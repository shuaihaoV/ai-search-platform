//! Shared application state.

use std::sync::Arc;

use crate::cache::Cache;
use crate::config::Config;
use crate::security::RateLimiter;
use crate::upstream::UpstreamClient;

/// State cloned into every handler.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    config: Config,
    upstream: UpstreamClient,
    cache: Arc<Cache>,
    search_limiter: RateLimiter,
    fetch_limiter: RateLimiter,
}

impl AppState {
    pub fn new(config: Config, upstream: UpstreamClient, cache: Arc<Cache>) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                upstream,
                cache,
                search_limiter: RateLimiter::new(crate::config::RATE_LIMIT_PER_MINUTE),
                fetch_limiter: RateLimiter::new(crate::config::RATE_LIMIT_PER_MINUTE),
            }),
        }
    }

    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    pub fn upstream(&self) -> &UpstreamClient {
        &self.inner.upstream
    }

    pub fn cache(&self) -> &Arc<Cache> {
        &self.inner.cache
    }

    pub fn search_limiter(&self) -> &RateLimiter {
        &self.inner.search_limiter
    }

    pub fn fetch_limiter(&self) -> &RateLimiter {
        &self.inner.fetch_limiter
    }
}
