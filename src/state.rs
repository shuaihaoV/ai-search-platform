//! Shared application state.

use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::auth::TokenIssuer;
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
    /// Present only when the optional access password is configured.
    token_issuer: Option<TokenIssuer>,
    login_limiter: RateLimiter,
    /// Caps concurrent Argon2 verifications (each needs ~19 MiB and a core).
    login_permits: Arc<Semaphore>,
}

impl AppState {
    pub fn new(config: Config, upstream: UpstreamClient, cache: Arc<Cache>) -> Self {
        let token_issuer = config.platform_passwd().map(TokenIssuer::new);
        Self {
            inner: Arc::new(Inner {
                config,
                upstream,
                cache,
                search_limiter: RateLimiter::new(crate::config::RATE_LIMIT_PER_MINUTE),
                fetch_limiter: RateLimiter::new(crate::config::RATE_LIMIT_PER_MINUTE),
                token_issuer,
                login_limiter: RateLimiter::new(crate::config::AUTH_LOGIN_LIMIT_PER_MINUTE),
                login_permits: Arc::new(Semaphore::new(crate::config::AUTH_LOGIN_MAX_CONCURRENT)),
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

    /// Token issuer, present only when the access password is configured.
    pub fn token_issuer(&self) -> Option<&TokenIssuer> {
        self.inner.token_issuer.as_ref()
    }

    /// Separate bucket for login attempts (brute-force brake).
    pub fn login_limiter(&self) -> &RateLimiter {
        &self.inner.login_limiter
    }

    /// Semaphore capping concurrent password verifications.
    ///
    /// Returned by value so a handler can hold an owned permit across an
    /// `.await` without borrowing `self`.
    pub fn login_permits(&self) -> Arc<Semaphore> {
        Arc::clone(&self.inner.login_permits)
    }
}
