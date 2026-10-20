//! HTTP routes.

pub mod auth;
pub mod fetch;
pub mod meta;
pub mod search;

use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;

use crate::error::AppError;
use crate::error::ErrorCode;
use crate::state::AppState;

/// Standalone `/api` router without guards; [`crate::build_app`] adds them.
pub fn api_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(meta::health))
        .route("/config", get(meta::config))
        .route("/auth/login", post(auth::login))
        .route("/search", post(search::search))
        .route("/fetch", post(fetch::fetch))
        .fallback(api_not_found)
}

/// JSON 404 used for unknown API paths.
pub async fn api_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({
            "error": {
                "code": "not_found",
                "message": "接口不存在",
                "retryable": false,
                "upstream_status": null,
                "retry_after_seconds": null
            }
        })),
    )
        .into_response()
}

/// JSON rejection → our error envelope.
pub(crate) fn map_json_rejection(rejection: JsonRejection) -> AppError {
    match rejection {
        JsonRejection::JsonDataError(err) => {
            AppError::invalid(crate::error::truncate(&err.body_text(), 300))
        }
        JsonRejection::JsonSyntaxError(_) => AppError::invalid("请求体不是合法的 JSON"),
        JsonRejection::MissingJsonContentType(_) => {
            AppError::new(ErrorCode::Forbidden, "Content-Type 必须为 application/json")
        }
        JsonRejection::BytesRejection(_) => {
            AppError::new(ErrorCode::PayloadTooLarge, "请求体过大或读取失败")
        }
        _ => AppError::invalid("请求体格式错误"),
    }
}

/// Serialise an API payload with `Cache-Control: no-store`.
pub(crate) fn json_response<T: serde::Serialize>(status: StatusCode, body: T) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
