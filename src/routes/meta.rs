//! `/api/health` and `/api/config`.

use axum::Json;
use axum::extract::State;

use crate::state::AppState;
use crate::types::HealthResponse;
use crate::types::PublicConfig;

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: crate::config::VERSION,
    })
}

/// Non-sensitive runtime configuration for the frontend.
pub async fn config(State(state): State<AppState>) -> Json<PublicConfig> {
    Json(PublicConfig::new(
        state.config().is_upstream_configured(),
        state.config().auth_enabled(),
    ))
}
