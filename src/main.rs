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
    // Subcommands run before any configuration is loaded, so they work even on
    // a machine with no `.env`, no API key and no writable cache directory.
    //
    // A leading `--` is tolerated so that `docker run <image> -- generate-passwd`
    // (a common muscle memory) behaves the same as `docker run <image> generate-passwd`.
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--") {
        args.remove(0);
    }

    match args.first().map(String::as_str) {
        Some("generate-passwd" | "gen-passwd") => {
            return generate_passwd_command(&args[1..]);
        }
        Some("hash-password" | "--hash-password") => {
            if args.len() > 1 {
                eprintln!("`hash-password` 不接受额外参数；用法: ai-search-platform hash-password");
                return ExitCode::from(2);
            }
            return hash_password_command();
        }
        Some("help" | "--help" | "-h") => {
            print_usage();
            return ExitCode::SUCCESS;
        }
        None => {}
        Some(other) => {
            eprintln!("未知子命令: {other}");
            print_usage();
            return ExitCode::from(2);
        }
    }

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
    if config.auth_enabled() {
        tracing::warn!(
            token_ttl_seconds = ai_search_platform::config::AUTH_TOKEN_TTL_SECONDS,
            "已启用访问密码：/api/search 与 /api/fetch 需要 Bearer token"
        );
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

/// Format the copy-pasteable `.env` line for a freshly generated hash.
///
/// The value is wrapped in single quotes: a PHC string contains `$`, and
/// `dotenvy` performs variable substitution on unquoted values, which would
/// turn `$argon2id$v=19$m=...` into garbage and make the next start fail with
/// "PLATFORM_PASSWD 不是合法的 Argon2id 哈希". Single quotes keep the value
/// literal in `.env` files as well as in POSIX shells.
fn passwd_env_hint(hash: &str) -> String {
    format!("PLATFORM_PASSWD='{hash}'")
}

/// Default length for a generated password.
const GENERATED_PASSWORD_LEN: usize = 20;
/// Accepted range for `--length`.
const GENERATED_PASSWORD_MIN: usize = 16;
const GENERATED_PASSWORD_MAX: usize = 64;

/// Characters that are unambiguous when transcribed by hand.
///
/// Excluded: `0`/`O`/`o`, `1`/`l`/`I` — the pairs people routinely confuse.
const PASSWORD_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Generate a random password from the OS CSPRNG.
///
/// Uses rejection sampling so every character is uniformly distributed
/// (plain `byte % alphabet_len` would bias the first `256 % len` characters).
fn generate_random_password(length: usize) -> Result<String, getrandom::Error> {
    const LIMIT: usize = 256 / PASSWORD_ALPHABET.len() * PASSWORD_ALPHABET.len();
    let mut out = String::with_capacity(length);
    let mut buf = [0u8; 64];
    while out.len() < length {
        let take = (length - out.len()).min(buf.len());
        getrandom::fill(&mut buf[..take])?;
        for &byte in &buf[..take] {
            if out.len() == length {
                break;
            }
            if (byte as usize) < LIMIT {
                let index = (byte as usize) % PASSWORD_ALPHABET.len();
                out.push(PASSWORD_ALPHABET[index] as char);
            }
        }
    }
    Ok(out)
}

fn print_usage() {
    eprintln!(
        "\
AI 搜索平台 v{version}

用法:
  ai-search-platform                   启动服务
  ai-search-platform generate-passwd   生成随机访问密码及其 Argon2id 哈希
  ai-search-platform hash-password     把 stdin 读入的密码转成 Argon2id 哈希
  ai-search-platform help              显示本帮助

generate-passwd 选项:
  --length <N>   密码长度，{min}-{max}（默认 {default}）
  --hash-only    只输出配置行（不打印明文密码，便于脚本使用）

环境变量:
  DEEPSEEK_API_KEY   上游 API Key（必填）
  DEEPSEEK_BASE_URL  上游 Base URL
  BIND_ADDR          监听地址（默认 127.0.0.1:8080）
  RUST_LOG           日志过滤
  ALLOWED_HOSTS      Host 白名单（可选）
  PLATFORM_PASSWD    访问密码的 Argon2id 哈希（可选；用上面的子命令生成）

Docker:
  docker run --rm <image> generate-passwd
  docker run --rm -i <image> hash-password",
        version = ai_search_platform::config::VERSION,
        min = GENERATED_PASSWORD_MIN,
        max = GENERATED_PASSWORD_MAX,
        default = GENERATED_PASSWORD_LEN,
    );
}

/// `generate-passwd`: create a strong random password *and* its hash, so the
/// operator never has to invent one (weak passwords are the usual failure mode).
fn generate_passwd_command(args: &[String]) -> ExitCode {
    use std::io::Write;

    let mut length = GENERATED_PASSWORD_LEN;
    let mut hash_only = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--length" | "-l" => {
                let Some(raw) = args.get(index + 1) else {
                    eprintln!("`--length` 需要一个数字参数");
                    return ExitCode::from(2);
                };
                match raw.parse::<usize>() {
                    Ok(value)
                        if (GENERATED_PASSWORD_MIN..=GENERATED_PASSWORD_MAX).contains(&value) =>
                    {
                        length = value;
                    }
                    _ => {
                        eprintln!(
                            "密码长度必须是 {GENERATED_PASSWORD_MIN}-{GENERATED_PASSWORD_MAX} 之间的整数（收到 {raw}）"
                        );
                        return ExitCode::from(2);
                    }
                }
                index += 2;
            }
            "--hash-only" => {
                hash_only = true;
                index += 1;
            }
            other => {
                eprintln!("`generate-passwd` 不认识的参数: {other}");
                return ExitCode::from(2);
            }
        }
    }

    let password = match generate_random_password(length) {
        Ok(password) => password,
        Err(_) => {
            eprintln!("错误: 系统随机数生成器不可用，无法安全生成密码");
            return ExitCode::FAILURE;
        }
    };
    let hash = match ai_search_platform::auth::hash_password(&password) {
        Ok(hash) => hash,
        Err(err) => {
            eprintln!("生成哈希失败: {err}");
            return ExitCode::FAILURE;
        }
    };

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let hint = passwd_env_hint(&hash);

    if hash_only {
        // Machine-friendly: just the `.env` line.
        if writeln!(out, "{hint}").is_err() {
            eprintln!("输出失败");
            return ExitCode::FAILURE;
        }
        return ExitCode::SUCCESS;
    }

    let printed = writeln!(
        out,
        "\
已生成随机访问密码（只显示这一次，请立即保存）

  明文密码：{password}
  配置行　：{hint}

把「配置行」写入 .env（或容器环境变量）后重启服务，即可启用访问密码。
登录时输入上面的「明文密码」。

提示：
  * 哈希中的 `$` 必须用单引号保护，否则 dotenvy 会当作变量展开导致启动失败；
  * 密码可通过 `--length {min}-{max}` 调整长度（默认 {default}）；
  * 脚本场景请用 `--hash-only` 只取配置行，避免明文进入日志/文件。",
        min = GENERATED_PASSWORD_MIN,
        max = GENERATED_PASSWORD_MAX,
        default = GENERATED_PASSWORD_LEN
    );
    if printed.is_err() {
        eprintln!("输出失败");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// Read a password from stdin and print its Argon2id hash.
fn hash_password_command() -> ExitCode {
    use std::io::{BufRead, Write};

    // stdin echo cannot be disabled without termios (or another crate), so be
    // honest instead of promising "不回显". Piping the password in
    // (`printf '%s' '密码' | --hash-password`) keeps it off the terminal and out
    // of shell history either way.
    eprintln!(
        "请输入访问密码（注意：输入内容会显示在此终端；长度 {}-{} 个字符；\
         也可用 `printf '%s' '密码' | --hash-password` 避免回显）：",
        ai_search_platform::config::AUTH_PASSWORD_MIN_CHARS,
        ai_search_platform::config::AUTH_PASSWORD_MAX_CHARS
    );
    let mut line = String::new();
    let stdin = std::io::stdin();
    if let Err(err) = stdin.lock().read_line(&mut line) {
        eprintln!("读取输入失败: {}", err.kind());
        return ExitCode::FAILURE;
    }
    let password = line.trim_end_matches(['\r', '\n']);
    let chars = password.chars().count();
    if !(ai_search_platform::config::AUTH_PASSWORD_MIN_CHARS
        ..=ai_search_platform::config::AUTH_PASSWORD_MAX_CHARS)
        .contains(&chars)
    {
        eprintln!(
            "密码长度必须在 {}-{} 个字符之间（当前 {}）",
            ai_search_platform::config::AUTH_PASSWORD_MIN_CHARS,
            ai_search_platform::config::AUTH_PASSWORD_MAX_CHARS,
            chars
        );
        return ExitCode::FAILURE;
    }

    match ai_search_platform::auth::hash_password(password) {
        Ok(hash) => {
            // stdout keeps the bare hash so scripts can capture it; the
            // human-facing hint is quoted for direct `.env` use.
            if let Err(err) = writeln!(std::io::stdout(), "{hash}") {
                eprintln!("输出失败: {}", err.kind());
                return ExitCode::FAILURE;
            }
            eprintln!("\n把下面这行写入 .env（或容器环境变量）：");
            eprintln!("{}", passwd_env_hint(&hash));
            eprintln!(
                "（哈希中的 `$` 必须用单引号保护，否则 dotenvy 会把它当作变量展开，\
                 导致下次启动报 PLATFORM_PASSWD 非法）"
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("生成哈希失败: {err}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_password_has_requested_length_and_is_unambiguous() {
        for length in [GENERATED_PASSWORD_MIN, 20, 32, GENERATED_PASSWORD_MAX] {
            let password = generate_random_password(length).expect("csprng");
            assert_eq!(password.chars().count(), length);
            for ch in password.chars() {
                assert!(
                    PASSWORD_ALPHABET.contains(&(ch as u8)),
                    "unexpected character {ch:?} in generated password"
                );
                assert!(
                    !"0Oo1lI".contains(ch),
                    "generated password must avoid look-alike character {ch:?}"
                );
            }
        }
    }

    #[test]
    fn generated_passwords_are_unique() {
        let first = generate_random_password(20).expect("csprng");
        let second = generate_random_password(20).expect("csprng");
        assert_ne!(first, second);
    }

    #[test]
    fn generated_password_round_trips_through_argon2() {
        // The bytes printed on the terminal must be exactly what verifies,
        // otherwise an operator could be locked out by a display issue.
        let password = generate_random_password(24).expect("csprng");
        let hash = ai_search_platform::auth::hash_password(&password).expect("hash");
        ai_search_platform::auth::validate_password_hash(&hash).expect("valid phc");
        assert!(ai_search_platform::auth::verify_password(&hash, &password));
        assert!(!ai_search_platform::auth::verify_password(&hash, "wrong"));
    }

    #[test]
    fn password_alphabet_is_biased_free() {
        // Rejection sampling requires the alphabet to be much smaller than 256,
        // and the accepted limit to be a whole multiple of it.
        let len = PASSWORD_ALPHABET.len();
        assert!(len < 128, "alphabet too large for cheap rejection sampling");
        assert_eq!((256 / len) * len % len, 0);
        // No duplicates: a repeated char would skew the distribution.
        let mut sorted = PASSWORD_ALPHABET.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), len, "alphabet must not contain duplicates");
    }

    #[test]
    fn env_hint_is_single_quoted() {
        // The hint must survive `dotenvy` variable expansion on the next start.
        let hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
        let hint = passwd_env_hint(hash);
        assert_eq!(hint, format!("PLATFORM_PASSWD='{hash}'"));
        assert!(hint.starts_with("PLATFORM_PASSWD='$argon2id$"));
        assert!(hint.ends_with('\''));
    }
}
