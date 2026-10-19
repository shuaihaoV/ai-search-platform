//! `POST /api/fetch`: cache-aware proxy to the upstream Fetch API.

use std::time::Instant;

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::Response;

use crate::cache::Kind;
use crate::error::AppError;
use crate::routes::json_response;
use crate::state::AppState;
use crate::types::CacheMeta;
use crate::types::DataResponse;
use crate::types::FetchRequest;
use crate::validation;

pub async fn fetch(
    State(state): State<AppState>,
    request: Result<Json<FetchRequest>, JsonRejection>,
) -> Result<Response, AppError> {
    let Json(request) = request.map_err(crate::routes::map_json_rejection)?;

    let (params, force_refresh) = validation::validate_fetch(request)?;
    let key = state
        .cache()
        .fetch_key(&state.config().upstream_identity(), &params);
    let now = crate::cache::unix_now();

    if !force_refresh && let Some(hit) = state.cache().get(Kind::Fetch, &key) {
        tracing::debug!("fetch cache hit");
        return Ok(json_response(
            StatusCode::OK,
            DataResponse {
                meta: CacheMeta::hit(now, hit.stored_at),
                upstream_status: hit.upstream_status,
                elapsed_ms: 0,
                data: hit.data,
            },
        ));
    }

    if !state.config().is_upstream_configured() {
        return Err(AppError::upstream_not_configured());
    }

    let started = Instant::now();
    let upstream = state.upstream().fetch(params.upstream_body()).await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    state
        .cache()
        .put(Kind::Fetch, &key, upstream.status, &upstream.body);

    Ok(json_response(
        StatusCode::OK,
        DataResponse {
            meta: CacheMeta::miss(now),
            upstream_status: upstream.status,
            elapsed_ms,
            data: upstream.body,
        },
    ))
}
