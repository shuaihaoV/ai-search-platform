//! Crate root: wires configuration, state, middleware and routers together.

pub mod assets;
pub mod auth;
pub mod cache;
pub mod config;
pub mod error;
pub mod routes;
pub mod security;
pub mod state;
pub mod types;
pub mod upstream;
pub mod validation;

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::extract::State;
use axum::http::HeaderValue;
use axum::middleware;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::timeout::TimeoutLayer;

use crate::config::Config;
use crate::state::AppState;

/// Build the fully configured application router.
pub fn build_app(state: AppState) -> Router {
    // `/api` subtree: host/CSRF guard wraps everything, per-route rate limits only
    // apply to the two expensive endpoints.
    let api = Router::new()
        .route("/health", get(routes::meta::health))
        .route("/config", get(routes::meta::config))
        .route(
            "/search",
            post(routes::search::search)
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    security::limit_search,
                ))
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    security::require_auth,
                )),
        )
        .route(
            "/fetch",
            post(routes::fetch::fetch)
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    security::limit_fetch,
                ))
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    security::require_auth,
                )),
        )
        .route(
            "/auth/login",
            post(routes::auth::login).route_layer(middleware::from_fn_with_state(
                state.clone(),
                security::limit_login,
            )),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security::guard_api,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(
            config::BODY_LIMIT_BYTES,
        ))
        .fallback(routes::api_not_found);

    Router::new()
        .nest("/api", api)
        .route("/", get(assets::index))
        .route("/assets/{*path}", get(assets::asset))
        .route("/favicon.svg", get(assets::favicon))
        .fallback(assets::spa_fallback)
        .with_state(state)
        // `security_headers` is added last so it is the outermost layer: that
        // way the headers are also attached to responses produced by the panic
        // catcher and the request timeout, not only to handler responses.
        .layer(CatchPanicLayer::new())
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            std::time::Duration::from_secs(config::REQUEST_TIMEOUT_SECONDS),
        ))
        .layer(axum::middleware::from_fn(security_headers))
}

/// Build the router used by the binary and integration tests.
pub fn bootstrap(cfg: Config) -> Result<Router, Box<dyn std::error::Error>> {
    let cache = Arc::new(cache::Cache::new(cfg.cache_dir())?);
    let upstream = upstream::UpstreamClient::new(&cfg)?;
    let state = AppState::new(cfg, upstream, cache);
    Ok(build_app(state))
}

/// Apply security headers to every response.
async fn security_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let is_api = path == "/api" || path.starts_with("/api/");
    let mut response = next.run(request).await;
    for (name, value) in security::security_headers() {
        if let Ok(value) = HeaderValue::from_str(value) {
            response.headers_mut().insert(name, value);
        }
    }
    // API responses must never be stored by intermediaries.
    if is_api {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        );
    }
    response
}

/// Unused-state guard so `State` stays referenced in this module.
#[allow(dead_code)]
fn _state_marker(_: State<AppState>) {}

/// Build a JSON POST request with the CSRF header attached (test helper).
pub fn json_post(uri: &str, body: &str) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header(config::CSRF_HEADER, config::CSRF_HEADER_VALUE)
        .body(axum::body::Body::from(body.to_owned()))
        .expect("valid request")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::StatusCode;
    use tower::ServiceExt as _;

    /// `security_headers` must be the outermost layer so even panic-catcher
    /// responses (500) carry CSP/nosniff instead of leaking a bare error page.
    async fn boom() -> &'static str {
        panic!("boom");
    }

    #[tokio::test]
    async fn security_headers_wrap_panic_responses() {
        let app = Router::new()
            .route("/boom", get(boom))
            .layer(CatchPanicLayer::new())
            .layer(axum::middleware::from_fn(security_headers));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/boom")
                    .body(Body::empty())
                    .expect("valid request"),
            )
            .await
            .expect("infallible");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(response.headers().contains_key("content-security-policy"));
        assert!(response.headers().contains_key("x-content-type-options"));
    }
}
