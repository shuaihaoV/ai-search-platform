//! Binary entry point.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use ai_search_platform::cache::Cache;
use ai_search_platform::config::Config;
use ai_search_platform::state::AppState;
use ai_search_platform::upstream::UpstreamClient;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    // `.env` is optional: real deployments usually inject env vars directly.
    //
    // Only the file next to the working directory is consulted. `dotenvy::dotenv()`
    // walks up parent directories, which would silently pick up an unrelated
    // `~/.env` and make an unconfigured instance look configured.
    match dotenvy::from_path(".env") {
        Ok(()) => tracing::debug!("已加载 ./.env"),
        Err(err) if err.not_found() => {}
        Err(err) => {
            // `dotenvy::Error::LineParse` embeds the raw offending line in its
            // `Display` output, which for a typo on the API-key line would print
            // the key to stderr/logs. Never render the error verbatim.
            let reason = match &err {
                dotenvy::Error::Io(io) => format!("I/O 错误: {}", io.kind()),
                _ => "文件格式错误".to_owned(),
            };
            eprintln!("警告: 读取 ./.env 失败（{reason}）；已忽略该文件以避免泄露文件内容");
        }
    }

    init_tracing();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("配置错误: {err}");
            return ExitCode::FAILURE;
        }
    };

    match serve(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!(error = %err, "服务启动失败");
            ExitCode::FAILURE
        }
    }
}

fn init_tracing() {
    let filter = std::env::var("RUST_LOG")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "info".to_owned());

    let env_filter = EnvFilter::try_new(&filter).unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .try_init();
}

async fn serve(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let bind_addr = config.bind_addr();

    if !config.loopback_bind() {
        tracing::warn!(
            addr = %bind_addr,
            "服务绑定在非回环地址：请确保前面有 TLS 反向代理与访问控制"
        );
        if config.allowed_hosts().is_empty() {
            tracing::warn!(
                "未设置 ALLOWED_HOSTS：公网绑定时 Host 头无法校验，存在 DNS rebinding 滥用风险；\
                 建议设置为对外域名（逗号分隔）"
            );
        } else {
            tracing::info!(
                allowed_hosts = ?config.allowed_hosts(),
                "已启用 Host 白名单校验"
            );
        }
    }
    if !config.is_upstream_configured() {
        tracing::warn!("未设置 DEEPSEEK_API_KEY：搜索与抓取接口将返回 502");
    }

    let cache = std::sync::Arc::new(Cache::new(config.cache_dir())?);
    tracing::info!(dir = %cache.root().display(), "缓存目录就绪");
    spawn_sweeper(cache.clone());

    let upstream = UpstreamClient::new(&config)?;
    let state = AppState::new(config, upstream, cache);
    let app = ai_search_platform::build_app(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    let local_addr: SocketAddr = listener.local_addr()?;
    tracing::info!(addr = %local_addr, version = ai_search_platform::config::VERSION, "服务已启动");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    tracing::info!("服务已停止");
    Ok(())
}

/// Sweep expired cache entries at startup and then on a fixed interval.
///
/// The sweep walks the whole cache directory with blocking filesystem calls, so
/// it runs on the blocking pool instead of a tokio worker thread.
fn spawn_sweeper(cache: std::sync::Arc<Cache>) {
    tokio::spawn(async move {
        let report = sweep_blocking(cache.clone()).await;
        tracing::info!(
            removed = report.removed,
            temp_removed = report.temp_removed,
            "启动时缓存清理完成"
        );

        let mut ticker = tokio::time::interval(Duration::from_secs(
            ai_search_platform::config::CACHE_SWEEP_INTERVAL_SECONDS,
        ));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick fires immediately; skip it.
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let report = sweep_blocking(cache.clone()).await;
            if report.removed > 0 || report.temp_removed > 0 {
                tracing::info!(
                    removed = report.removed,
                    temp_removed = report.temp_removed,
                    "周期缓存清理完成"
                );
            }
        }
    });
}

async fn sweep_blocking(cache: std::sync::Arc<Cache>) -> ai_search_platform::cache::SweepReport {
    match tokio::task::spawn_blocking(move || cache.sweep()).await {
        Ok(report) => report,
        Err(err) => {
            tracing::warn!(error = %err, "缓存清理任务失败");
            ai_search_platform::cache::SweepReport::default()
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %err, "无法监听 Ctrl+C");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => tracing::warn!(error = %err, "无法监听 SIGTERM"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("收到退出信号，正在优雅关闭");
}
