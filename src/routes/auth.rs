//! `POST /api/auth/login` — exchange the shared access password for a token.

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::cache::unix_now;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub expires_at: i64,
}

/// Verify the shared password and issue a bearer token.
///
/// Returns 404 when the access gate is disabled so the endpoint does not
/// advertise itself on unprotected deployments.
pub async fn login(
    State(state): State<AppState>,
    request: Result<Json<LoginRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let Some(issuer) = state.token_issuer() else {
        return Err(AppError::not_found("接口不存在"));
    };
    let Json(mut request) = request.map_err(crate::routes::map_json_rejection)?;

    // Reject absurd inputs before touching Argon2 (which is intentionally slow).
    //
    // Count *characters*, exactly like the `--hash-password` generator. Using
    // `.len()` (UTF-8 bytes) here rejected passwords that the generator happily
    // accepted once they contained non-ASCII characters (e.g. 100 CJK chars =
    // 300 bytes), locking the operator out permanently. Characters are also the
    // right bound for the DoS check: 256 chars is at most 1 KiB of UTF-8, far
    // below anything that could stress Argon2.
    if request.password.is_empty()
        || request.password.chars().count() > crate::config::AUTH_PASSWORD_MAX_CHARS
    {
        return Err(AppError::invalid_password("访问密码错误"));
    }

    let Some(hash) = state.config().platform_passwd() else {
        return Err(AppError::not_found("接口不存在"));
    };

    // Bound the number of simultaneous Argon2 verifications. Each one needs
    // ~19 MiB *and* a full core: a burst of login attempts from many source
    // addresses would otherwise exhaust memory and stall the async workers
    // (taking every endpoint down with it). Excess attempts wait briefly for a
    // slot and then get a retryable 429 instead of piling up.
    let permits = state.login_permits();
    let permit = match tokio::time::timeout(
        std::time::Duration::from_secs(crate::config::AUTH_LOGIN_QUEUE_TIMEOUT_SECONDS),
        permits.acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return Err(AppError::rate_limited("登录请求过多，请稍后重试").with_retry_after(1));
        }
    };

    // Argon2 is deliberately CPU-heavy; keep it off the async runtime so a
    // login burst cannot block the tasks serving normal traffic.
    let hash = hash.to_owned();
    let password = std::mem::take(&mut request.password);
    let verified =
        tokio::task::spawn_blocking(move || crate::auth::verify_password(&hash, &password))
            .await
            .unwrap_or(false);
    drop(permit);

    if !verified {
        return Err(AppError::invalid_password("访问密码错误"));
    }

    let (token, expires_at) = issuer.issue(unix_now() as i64);
    Ok((
        StatusCode::OK,
        [("cache-control", "no-store")],
        Json(LoginResponse { token, expires_at }),
    )
        .into_response())
}
