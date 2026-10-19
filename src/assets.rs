//! Embedded frontend assets and SPA fallback.

use axum::body::Body;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderValue;
use axum::http::StatusCode;
use axum::http::header::CACHE_CONTROL;
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::response::Response;
use rust_embed::RustEmbed;

use crate::state::AppState;

/// Built SPA, embedded at compile time in release builds.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/frontend/dist/"]
pub struct Assets;

/// `GET /` and any non-API path: serve the SPA entry point.
pub async fn index() -> Response {
    serve("index.html", CachePolicy::NoCache)
}

/// `GET /assets/{*path}`: immutable hashed assets.
pub async fn asset(Path(path): Path<String>) -> Response {
    if !is_safe_path(&path) {
        return not_found_plain();
    }
    let resolved = format!("assets/{path}");
    serve(&resolved, CachePolicy::Immutable)
}

/// Fallback for unknown non-API routes: SPA routing, but never for assets.
pub async fn spa_fallback(State(_state): State<AppState>, uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // `/api` itself has no handler but must still answer with JSON, not HTML.
    if path == "api" || path.starts_with("api/") {
        return crate::routes::api_not_found().await;
    }
    if path.starts_with("assets/") {
        // A missing hashed asset must 404 rather than return HTML.
        return not_found_plain();
    }
    // Serve a real file when one matches (e.g. favicon.svg, robots.txt).
    if !path.is_empty() && is_safe_path(path) && Assets::get(path).is_some() {
        return serve(path, CachePolicy::ShortLived);
    }
    serve("index.html", CachePolicy::NoCache)
}

/// `GET /favicon.svg` served from the embedded public assets.
pub async fn favicon() -> Response {
    if Assets::get("favicon.svg").is_some() {
        return serve("favicon.svg", CachePolicy::ShortLived);
    }
    not_found_plain()
}

/// Reject traversal attempts before touching the embedded table.
pub fn is_safe_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 512 {
        return false;
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    !path
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
}

#[derive(Clone, Copy)]
enum CachePolicy {
    /// `index.html` must be revalidated so deploys take effect.
    NoCache,
    /// Hashed bundles never change under the same name.
    Immutable,
    ShortLived,
}

fn serve(path: &str, policy: CachePolicy) -> Response {
    let Some(file) = Assets::get(path) else {
        return not_found_plain();
    };

    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let content_type = if mime.type_() == mime_guess::mime::TEXT {
        format!("{}; charset=utf-8", mime.as_ref())
    } else {
        mime.to_string()
    };

    let mut response = Response::new(Body::from(file.data.into_owned()));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static(match policy {
            CachePolicy::NoCache => "no-cache",
            CachePolicy::Immutable => "public, max-age=31536000, immutable",
            CachePolicy::ShortLived => "public, max-age=3600",
        }),
    );
    response
}

fn not_found_plain() -> Response {
    let mut response = (StatusCode::NOT_FOUND, "not found").into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_paths_are_rejected() {
        assert!(!is_safe_path("../secret"));
        assert!(!is_safe_path("a/../../etc/passwd"));
        assert!(!is_safe_path("/absolute"));
        assert!(!is_safe_path("a\\b"));
        assert!(!is_safe_path("a\0b"));
        assert!(!is_safe_path(""));
        assert!(!is_safe_path("./index.html"));
    }

    #[test]
    fn normal_paths_are_allowed() {
        assert!(is_safe_path("index.html"));
        assert!(is_safe_path("assets/index-abc123.js"));
        assert!(is_safe_path("favicon.svg"));
    }

    #[test]
    fn index_is_embedded() {
        // build.rs guarantees an entry point exists, so the embed table is never empty.
        assert!(Assets::get("index.html").is_some());
    }
}
