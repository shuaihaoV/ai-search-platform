//! Unified error type and JSON error responses.

use std::fmt;

use axum::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use serde::Serialize;

/// Machine readable error codes understood by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidRequest,
    Forbidden,
    Unauthorized,
    InvalidPassword,
    NotFound,
    PayloadTooLarge,
    RateLimited,
    UpstreamNotConfigured,
    UpstreamAuthFailed,
    UpstreamPaymentRequired,
    UpstreamForbidden,
    UpstreamNotFound,
    UpstreamRateLimited,
    UpstreamTimeout,
    UpstreamInvalidResponse,
    UpstreamError,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Forbidden => "forbidden",
            Self::Unauthorized => "unauthorized",
            Self::InvalidPassword => "invalid_password",
            Self::NotFound => "not_found",
            Self::PayloadTooLarge => "payload_too_large",
            Self::RateLimited => "rate_limited",
            Self::UpstreamNotConfigured => "upstream_not_configured",
            Self::UpstreamAuthFailed => "upstream_auth_failed",
            Self::UpstreamPaymentRequired => "upstream_payment_required",
            Self::UpstreamForbidden => "upstream_forbidden",
            Self::UpstreamNotFound => "upstream_not_found",
            Self::UpstreamRateLimited => "upstream_rate_limited",
            Self::UpstreamTimeout => "upstream_timeout",
            Self::UpstreamInvalidResponse => "upstream_invalid_response",
            Self::UpstreamError => "upstream_error",
            Self::Internal => "internal_error",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::Unauthorized | Self::InvalidPassword => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited | Self::UpstreamRateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::UpstreamNotConfigured | Self::UpstreamError | Self::UpstreamInvalidResponse => {
                StatusCode::BAD_GATEWAY
            }
            Self::UpstreamAuthFailed => StatusCode::BAD_GATEWAY,
            Self::UpstreamPaymentRequired => StatusCode::PAYMENT_REQUIRED,
            Self::UpstreamForbidden => StatusCode::FORBIDDEN,
            Self::UpstreamNotFound => StatusCode::NOT_FOUND,
            Self::UpstreamTimeout => StatusCode::GATEWAY_TIMEOUT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Whether retrying the very same request may succeed.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited
                | Self::UpstreamRateLimited
                | Self::UpstreamTimeout
                | Self::UpstreamError
                | Self::Internal
        )
    }
}

/// Application error carrying an optional upstream status and retry hint.
#[derive(Debug)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub upstream_status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            upstream_status: None,
            retry_after_seconds: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Forbidden, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unauthorized, message)
    }

    pub fn invalid_password(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidPassword, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn rate_limited(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::RateLimited, message)
    }

    pub fn upstream_not_configured() -> Self {
        Self::new(
            ErrorCode::UpstreamNotConfigured,
            "服务端未配置 DEEPSEEK_API_KEY，无法访问上游 Search/Fetch 接口",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn with_upstream_status(mut self, status: u16) -> Self {
        self.upstream_status = Some(status);
        self
    }

    pub fn with_retry_after(mut self, seconds: u64) -> Self {
        self.retry_after_seconds = Some(seconds);
        self
    }

    fn retryable(&self) -> bool {
        self.code.retryable() && self.retry_after_seconds.is_none()
            || self.code == ErrorCode::UpstreamRateLimited
            || self.code == ErrorCode::RateLimited
    }

    pub fn status(&self) -> StatusCode {
        self.code.status()
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AppError {}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    retryable: bool,
    upstream_status: Option<u16>,
    retry_after_seconds: Option<u64>,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = ErrorEnvelope {
            error: ErrorBody {
                code: self.code.as_str(),
                message: truncate(&self.message, 512),
                retryable: self.retryable(),
                upstream_status: self.upstream_status,
                retry_after_seconds: self.retry_after_seconds,
            },
        };

        let mut response = (status, Json(body)).into_response();
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        if let Some(seconds) = self.retry_after_seconds
            && let Ok(value) = axum::http::HeaderValue::from_str(&seconds.to_string())
        {
            response
                .headers_mut()
                .insert(axum::http::header::RETRY_AFTER, value);
        }
        response
    }
}

/// Truncate on a char boundary so we never emit invalid UTF-8.
pub fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut out: String = value.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping_matches_contract() {
        assert_eq!(ErrorCode::InvalidRequest.status(), StatusCode::BAD_REQUEST);
        assert_eq!(ErrorCode::Forbidden.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            ErrorCode::PayloadTooLarge.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            ErrorCode::UpstreamRateLimited.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            ErrorCode::UpstreamAuthFailed.status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            ErrorCode::UpstreamPaymentRequired.status(),
            StatusCode::PAYMENT_REQUIRED
        );
        assert_eq!(ErrorCode::UpstreamNotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            ErrorCode::UpstreamTimeout.status(),
            StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            ErrorCode::UpstreamNotConfigured.status(),
            StatusCode::BAD_GATEWAY
        );
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("中文中文", 2), "中文…");
        assert_eq!(truncate("", 0), "");
    }

    #[test]
    fn retryable_is_reported_for_transient_codes() {
        assert!(ErrorCode::UpstreamRateLimited.retryable());
        assert!(ErrorCode::UpstreamTimeout.retryable());
        assert!(!ErrorCode::UpstreamAuthFailed.retryable());
        assert!(!ErrorCode::InvalidRequest.retryable());
    }
}
