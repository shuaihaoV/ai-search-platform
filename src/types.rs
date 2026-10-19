//! Request/response payload types shared by the HTTP layer and the cache.

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::config;

/// Upstream search request body as understood by this platform.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub ori_question: Option<String>,
    #[serde(default)]
    pub localization: Option<String>,
    #[serde(default)]
    pub need_content: Option<bool>,
    #[serde(default)]
    pub force_refresh: bool,
}

/// Normalised search parameters after validation and defaulting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchParams {
    pub query: String,
    pub count: u32,
    pub ori_question: Option<String>,
    pub localization: Option<String>,
    pub need_content: bool,
}

impl SearchParams {
    /// The exact JSON body forwarded upstream (unknown fields never leak in).
    pub fn upstream_body(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("query".into(), Value::String(self.query.clone()));
        map.insert("count".into(), Value::from(self.count));
        map.insert("need_content".into(), Value::Bool(self.need_content));
        if let Some(value) = &self.ori_question {
            map.insert("ori_question".into(), Value::String(value.clone()));
        }
        if let Some(value) = &self.localization {
            map.insert("localization".into(), Value::String(value.clone()));
        }
        Value::Object(map)
    }
}

/// Upstream fetch request body.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FetchRequest {
    pub url: String,
    #[serde(default)]
    pub force_refresh: bool,
}

/// Normalised fetch parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchParams {
    pub url: String,
}

impl FetchParams {
    pub fn upstream_body(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("url".into(), Value::String(self.url.clone()));
        Value::Object(map)
    }
}

/// Cache metadata surfaced to the frontend next to every payload.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CacheMeta {
    pub cached: bool,
    pub cache_status: &'static str,
    pub cache_age_seconds: u64,
    pub stored_at: u64,
    pub expires_at: u64,
}

impl CacheMeta {
    pub fn miss(now: u64) -> Self {
        Self {
            cached: false,
            cache_status: "miss",
            cache_age_seconds: 0,
            stored_at: now,
            expires_at: now.saturating_add(config::CACHE_TTL_SECONDS),
        }
    }

    pub fn hit(now: u64, stored_at: u64) -> Self {
        Self {
            cached: true,
            cache_status: "hit",
            cache_age_seconds: now.saturating_sub(stored_at),
            stored_at,
            expires_at: stored_at.saturating_add(config::CACHE_TTL_SECONDS),
        }
    }
}

/// Successful search/fetch envelope returned by the API.
#[derive(Debug, Serialize)]
pub struct DataResponse {
    #[serde(flatten)]
    pub meta: CacheMeta,
    pub upstream_status: u16,
    pub elapsed_ms: u64,
    pub data: Value,
}

/// Non-sensitive runtime information for the frontend.
#[derive(Debug, Serialize)]
pub struct PublicConfig {
    pub version: &'static str,
    pub defaults: PublicDefaults,
    pub limits: PublicLimits,
    pub cache: PublicCache,
    pub upstream: PublicUpstream,
}

#[derive(Debug, Serialize)]
pub struct PublicDefaults {
    pub count: u32,
    pub need_content: bool,
    pub ori_question: &'static str,
    pub localization: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PublicLimits {
    pub count_min: u32,
    pub count_max: u32,
    pub query_max_chars: usize,
    pub ori_question_max_chars: usize,
    pub fetch_url_max_chars: usize,
}

#[derive(Debug, Serialize)]
pub struct PublicCache {
    pub search_enabled: bool,
    pub search_ttl_seconds: u64,
    pub fetch_enabled: bool,
    pub fetch_ttl_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct PublicUpstream {
    pub configured: bool,
}

impl PublicConfig {
    pub fn new(upstream_configured: bool) -> Self {
        Self {
            version: config::VERSION,
            defaults: PublicDefaults {
                count: config::DEFAULT_COUNT,
                need_content: config::DEFAULT_NEED_CONTENT,
                ori_question: "",
                localization: "",
            },
            limits: PublicLimits {
                count_min: config::COUNT_MIN,
                count_max: config::COUNT_MAX,
                query_max_chars: config::QUERY_MAX_CHARS,
                ori_question_max_chars: config::ORI_QUESTION_MAX_CHARS,
                fetch_url_max_chars: config::FETCH_URL_MAX_CHARS,
            },
            cache: PublicCache {
                search_enabled: config::SEARCH_CACHE_ENABLED,
                search_ttl_seconds: config::CACHE_TTL_SECONDS,
                fetch_enabled: config::FETCH_CACHE_ENABLED,
                fetch_ttl_seconds: config::CACHE_TTL_SECONDS,
            },
            upstream: PublicUpstream {
                configured: upstream_configured,
            },
        }
    }
}

/// Health endpoint payload.
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
}
