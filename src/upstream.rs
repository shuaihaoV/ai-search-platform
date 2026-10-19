//! Upstream client for the DeepSeek Search and Fetch endpoints.
//!
//! Responsibilities: authentication, bounded response reading, transient
//! retries, and translation of upstream failures into [`AppError`].

use std::time::Duration;
use std::time::Instant;

use reqwest::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::RETRY_AFTER;
use serde_json::Value;
use tokio::sync::Semaphore;
use tracing::Instrument as _;

use crate::config;
use crate::error::AppError;
use crate::error::ErrorCode;

/// Successful upstream payload plus metadata.
#[derive(Debug)]
pub struct UpstreamPayload {
    pub body: Value,
    pub status: u16,
    pub elapsed_ms: u64,
}

/// Upstream client handed out through application state.
pub struct UpstreamClient {
    http: reqwest::Client,
    search_endpoint: reqwest::Url,
    fetch_endpoint: reqwest::Url,
    api_key: Option<String>,
    semaphore: std::sync::Arc<Semaphore>,
}

impl UpstreamClient {
    pub fn new(config: &crate::config::Config) -> Result<Self, reqwest::Error> {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(config::UPSTREAM_TIMEOUT_SECONDS))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent(concat!("ai-search-platform/", env!("CARGO_PKG_VERSION")))
            // The only redirect we care about is the one we issue ourselves.
            .redirect(reqwest::redirect::Policy::none());

        // The `system-proxy` feature makes reqwest honour HTTP(S)_PROXY, which is
        // desirable for reaching the real API from a restricted network. It would
        // however also route *loopback* upstreams (local mock or a same-host
        // reverse proxy) through that proxy and stall them until the timeout.
        // Loopback never needs a proxy, so bypass it explicitly.
        if config.base_url_is_loopback() {
            builder = builder.no_proxy();
        }

        let http = builder.build()?;

        Ok(Self {
            http,
            search_endpoint: config.search_endpoint(),
            fetch_endpoint: config.fetch_endpoint(),
            api_key: config.api_key().map(str::to_owned),
            semaphore: std::sync::Arc::new(Semaphore::new(config::MAX_CONCURRENT_UPSTREAM)),
        })
    }

    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    /// `POST /v1/tools/search`
    pub async fn search(&self, body: Value) -> Result<UpstreamPayload, AppError> {
        self.post(self.search_endpoint.clone(), body, "search")
            .await
    }

    /// `POST /v1/tools/fetch`
    pub async fn fetch(&self, body: Value) -> Result<UpstreamPayload, AppError> {
        self.post(self.fetch_endpoint.clone(), body, "fetch").await
    }

    async fn post(
        &self,
        endpoint: reqwest::Url,
        body: Value,
        operation: &'static str,
    ) -> Result<UpstreamPayload, AppError> {
        let api_key = self
            .api_key
            .as_deref()
            .ok_or_else(AppError::upstream_not_configured)?;

        let started = Instant::now();
        let mut attempt = 0u32;

        loop {
            let permit = self
                .semaphore
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| AppError::internal("上游并发控制已关闭"))?;

            let span = tracing::info_span!("upstream", operation, attempt);
            let result = async {
                let response = self
                    .http
                    .post(endpoint.clone())
                    .header(AUTHORIZATION, format!("Bearer {api_key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|err| map_transport_error(&err, operation))?;

                let status = response.status();
                let retry_after = parse_retry_after(response.headers().get(RETRY_AFTER));

                // Read the body with a hard size cap so a hostile or broken
                // upstream cannot exhaust memory.
                let bytes = read_bounded(response, config::UPSTREAM_MAX_BYTES).await?;

                if status.is_success() {
                    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| {
                        AppError::new(
                            ErrorCode::UpstreamInvalidResponse,
                            format!("上游 {operation} 返回了非 JSON 响应"),
                        )
                        .with_upstream_status(status.as_u16())
                    })?;
                    return Ok(UpstreamPayload {
                        body: parsed,
                        status: status.as_u16(),
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    });
                }

                Err(map_upstream_status(status, &bytes, retry_after))
            }
            .instrument(span)
            .await;

            drop(permit);

            match result {
                Ok(payload) => return Ok(payload),
                Err(err) => {
                    let retryable = should_retry(&err);
                    if retryable && attempt < config::UPSTREAM_MAX_RETRIES {
                        attempt += 1;
                        let delay = backoff(attempt, err.retry_after_seconds);
                        tracing::debug!(
                            operation,
                            attempt,
                            delay_ms = delay.as_millis() as u64,
                            code = err.code.as_str(),
                            "retrying upstream request"
                        );
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    }
}

fn should_retry(err: &AppError) -> bool {
    match err.upstream_status {
        Some(code) => {
            code == StatusCode::REQUEST_TIMEOUT.as_u16()
                || code == StatusCode::TOO_MANY_REQUESTS.as_u16()
                || (500..600).contains(&code)
        }
        None => err.code == ErrorCode::UpstreamTimeout,
    }
}

fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    let hinted = retry_after.unwrap_or(0).min(2);
    let computed = 200u64.saturating_mul(1 << attempt.min(4));
    Duration::from_millis((hinted * 1000).max(computed))
}

fn map_transport_error(err: &reqwest::Error, operation: &str) -> AppError {
    if err.is_timeout() {
        return AppError::new(
            ErrorCode::UpstreamTimeout,
            format!("上游 {operation} 请求超时"),
        );
    }
    if err.is_connect() || err.is_request() || err.is_body() || err.is_decode() {
        return AppError::new(
            ErrorCode::UpstreamError,
            format!("无法完成上游 {operation} 请求"),
        );
    }
    AppError::new(
        ErrorCode::UpstreamError,
        format!("上游 {operation} 请求失败"),
    )
}

/// Map an HTTP status from the upstream into our error model, preserving the
/// upstream status code and retry hint.
fn map_upstream_status(status: StatusCode, body: &[u8], retry_after: Option<u64>) -> AppError {
    let message = extract_upstream_message(body);
    let code = status.as_u16();

    let error_code = match status {
        StatusCode::UNAUTHORIZED => ErrorCode::UpstreamAuthFailed,
        StatusCode::PAYMENT_REQUIRED => ErrorCode::UpstreamPaymentRequired,
        StatusCode::FORBIDDEN => ErrorCode::UpstreamForbidden,
        StatusCode::NOT_FOUND => ErrorCode::UpstreamNotFound,
        StatusCode::TOO_MANY_REQUESTS => ErrorCode::UpstreamRateLimited,
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => ErrorCode::UpstreamTimeout,
        StatusCode::PAYLOAD_TOO_LARGE => ErrorCode::PayloadTooLarge,
        _ if status.is_client_error() => ErrorCode::UpstreamError,
        _ => ErrorCode::UpstreamError,
    };

    let fallback = match error_code {
        ErrorCode::UpstreamAuthFailed => "上游鉴权失败：请检查 DEEPSEEK_API_KEY",
        ErrorCode::UpstreamPaymentRequired => "上游账号余额不足",
        ErrorCode::UpstreamForbidden => "上游安全策略拒绝了该请求",
        ErrorCode::UpstreamNotFound => "上游未能获取可用内容",
        ErrorCode::UpstreamRateLimited => "上游限流，请稍后重试",
        ErrorCode::UpstreamTimeout => "上游请求超时，请稍后重试",
        ErrorCode::PayloadTooLarge => "上游请求体超过大小限制",
        _ => "上游返回错误",
    };

    let mut error = AppError::new(error_code, message.unwrap_or_else(|| fallback.to_owned()))
        .with_upstream_status(code);
    if let Some(seconds) = retry_after {
        error = error.with_retry_after(seconds);
    } else if error_code == ErrorCode::UpstreamRateLimited {
        error = error.with_retry_after(1);
    }
    error
}

/// Pull `error.message` out of the OpenAI-compatible error envelope.
fn extract_upstream_message(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let message = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(crate::error::truncate(trimmed, 300))
    }
}

fn parse_retry_after(value: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    let raw = value?.to_str().ok()?;
    // Only the delta-seconds form is honoured; HTTP-date is ignored.
    raw.trim().parse::<u64>().ok()
}

/// Read at most `limit` bytes from a response body, failing on overflow.
async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, AppError> {
    if let Some(length) = response.content_length()
        && length > limit as u64
    {
        return Err(AppError::new(
            ErrorCode::UpstreamInvalidResponse,
            "上游响应体超过大小上限",
        ));
    }

    let mut buffer: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if buffer.len() + chunk.len() > limit {
                    return Err(AppError::new(
                        ErrorCode::UpstreamInvalidResponse,
                        "上游响应体超过大小上限",
                    ));
                }
                buffer.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(buffer),
            Err(err) => {
                return Err(map_transport_error(&err, "响应读取"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_is_parsed() {
        let value = reqwest::header::HeaderValue::from_static("3");
        assert_eq!(parse_retry_after(Some(&value)), Some(3));
        let value = reqwest::header::HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT");
        assert_eq!(parse_retry_after(Some(&value)), None);
        assert_eq!(parse_retry_after(None), None);
    }

    #[test]
    fn upstream_error_message_is_extracted() {
        let body = br#"{"error":{"message":"'count' must be between 1 and 50","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
        assert_eq!(
            extract_upstream_message(body).as_deref(),
            Some("'count' must be between 1 and 50")
        );
        assert_eq!(extract_upstream_message(b"plain text"), None);
        assert_eq!(extract_upstream_message(b"{}"), None);
    }

    #[test]
    fn status_mapping_preserves_details() {
        let body = br#"{"error":{"message":"rate limited"}}"#;
        let err = map_upstream_status(StatusCode::TOO_MANY_REQUESTS, body, Some(2));
        assert_eq!(err.code, ErrorCode::UpstreamRateLimited);
        assert_eq!(err.upstream_status, Some(429));
        assert_eq!(err.retry_after_seconds, Some(2));

        let err = map_upstream_status(StatusCode::UNAUTHORIZED, b"", None);
        assert_eq!(err.code, ErrorCode::UpstreamAuthFailed);

        let err = map_upstream_status(StatusCode::BAD_GATEWAY, b"", None);
        assert_eq!(err.code, ErrorCode::UpstreamError);
        assert!(should_retry(&err));
    }

    #[test]
    fn backoff_is_bounded_and_honours_hint() {
        assert!(backoff(1, None) >= Duration::from_millis(200));
        assert_eq!(backoff(1, Some(2)), Duration::from_millis(2000));
        // Hints are capped at 2 seconds.
        assert_eq!(backoff(1, Some(60)), Duration::from_millis(2000));
    }
}
