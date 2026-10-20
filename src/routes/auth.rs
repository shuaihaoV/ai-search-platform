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
    let Json(request) = request.map_err(crate::routes::map_json_rejection)?;

    // Reject absurd inputs before touching Argon2 (which is intentionally slow).
    if request.password.is_empty()
        || request.password.len() > crate::config::AUTH_PASSWORD_MAX_CHARS
    {
        return Err(AppError::invalid_password("访问密码错误"));
    }

    let Some(hash) = state.config().platform_passwd() else {
        return Err(AppError::not_found("接口不存在"));
    };

    if !crate::auth::verify_password(hash, &request.password) {
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
