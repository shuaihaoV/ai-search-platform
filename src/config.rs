//! Configuration.
//!
//! Four environment variables control normal operation:
//!
//! * `DEEPSEEK_API_KEY`
//! * `DEEPSEEK_BASE_URL`
//! * `BIND_ADDR`
//! * `RUST_LOG`
//!
//! One optional variable can *only strengthen* host validation:
//!
//! * `ALLOWED_HOSTS` — comma separated hostnames the service answers to. When
//!   set, the `Host` header must match one of them (loopback names are always
//!   accepted so same-machine health checks keep working). This is required to
//!   stop DNS-rebinding style attacks on a non-loopback bind, where an
//!   attacker-controlled domain can be pointed at this server and then be
//!   treated as same-origin by a victim's browser.
//!
//! Everything else (cache TTLs, limits, timeouts) is a compile-time constant so
//! that operators cannot accidentally weaken the safety limits.

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;

use url::Url;

/// Default upstream base URL.
pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
/// Default listen address (loopback only).
pub const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8080";

/// Search cache is always enabled.
pub const SEARCH_CACHE_ENABLED: bool = true;
/// Fetch cache is always enabled.
pub const FETCH_CACHE_ENABLED: bool = true;
/// Cache time-to-live: one day.
pub const CACHE_TTL_SECONDS: u64 = 86_400;
/// Directory (relative to the process CWD) holding cache entries.
pub const CACHE_DIR: &str = "./.cache";
/// Hard cap for the whole cache directory.
pub const CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Hard cap for a single cache entry; larger upstream responses are not cached.
pub const CACHE_MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
/// Hard cap on the number of cache entries.
pub const CACHE_MAX_ENTRIES: usize = 2_000;
/// Background sweep interval for expired entries.
pub const CACHE_SWEEP_INTERVAL_SECONDS: u64 = 600;
/// Temporary cache files older than this are removed by the sweeper.
pub const CACHE_STALE_TMP_SECONDS: u64 = 3_600;

/// Maximum accepted request body size.
pub const BODY_LIMIT_BYTES: usize = 16 * 1024;
/// Upstream request timeout.
pub const UPSTREAM_TIMEOUT_SECONDS: u64 = 30;
/// Whole-request timeout enforced by `tower_http::timeout`.
pub const REQUEST_TIMEOUT_SECONDS: u64 = 90;
/// Maximum bytes read from an upstream response body.
pub const UPSTREAM_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Retries for transient upstream failures (408/429/5xx/network errors).
pub const UPSTREAM_MAX_RETRIES: u32 = 1;
/// Concurrent upstream requests allowed.
pub const MAX_CONCURRENT_UPSTREAM: usize = 8;
/// Per-client-IP requests per minute, applied separately to search and fetch.
pub const RATE_LIMIT_PER_MINUTE: u32 = 30;

/// Optional access password: Argon2id PHC hash, never the plaintext.
pub const PLATFORM_PASSWD_ENV: &str = "PLATFORM_PASSWD";
/// Access-token lifetime (7 days).
pub const AUTH_TOKEN_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
/// Login attempts allowed per client IP per minute (brute-force brake).
pub const AUTH_LOGIN_LIMIT_PER_MINUTE: u32 = 10;
/// Maximum concurrent Argon2id verifications.
///
/// One verification needs ~19 MiB (`m=19456` KiB) and a full core for a few
/// milliseconds, so unbounded concurrency is both a memory and a latency
/// threat for the whole process.
pub const AUTH_LOGIN_MAX_CONCURRENT: usize = 4;
/// How long a login attempt may wait for a verification slot before it is
/// rejected with a retryable 429 instead of piling up.
pub const AUTH_LOGIN_QUEUE_TIMEOUT_SECONDS: u64 = 2;
/// Accepted password length range for the `hash-password` subcommand and login.
pub const AUTH_PASSWORD_MIN_CHARS: usize = 8;
pub const AUTH_PASSWORD_MAX_CHARS: usize = 256;

/// Default value for the upstream `count` field.
///
/// Set to the upstream maximum (50): billing is per request, not per result,
/// so a larger `count` costs the same while returning a fuller first page.
pub const DEFAULT_COUNT: u32 = 50;
pub const COUNT_MIN: u32 = 1;
pub const COUNT_MAX: u32 = 50;
/// `need_content` defaults to `true` in this platform (the upstream default is
/// `false`); a full-text payload is what the reader UI expects.
pub const DEFAULT_NEED_CONTENT: bool = true;
/// Upstream `query` accepts 1..=128 Unicode characters.
pub const QUERY_MAX_CHARS: usize = 128;
/// Upstream `ori_question` accepts 1..=128 characters.
pub const ORI_QUESTION_MAX_CHARS: usize = 128;
/// Upstream `url` accepts at most 8192 characters.
pub const FETCH_URL_MAX_CHARS: usize = 8192;

/// Header value the browser must echo on state-changing requests.
pub const CSRF_HEADER: &str = "x-requested-with";
/// Header value the browser must send.
pub const CSRF_HEADER_VALUE: &str = "ai-search-platform";

/// Optional comma separated `Host` allowlist (see the module docs).
pub const ALLOWED_HOSTS_ENV: &str = "ALLOWED_HOSTS";

/// Application version, surfaced by `/api/health` and `/api/config`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("DEEPSEEK_BASE_URL 非法: {0}")]
    BaseUrl(String),
    #[error("BIND_ADDR 非法: {0}")]
    BindAddr(String),
    #[error(
        "PLATFORM_PASSWD 必须是以 $argon2id$ 开头的 Argon2id 哈希（可用 `--hash-password` 生成）"
    )]
    PlatformPasswd,
}

/// Runtime configuration derived from the environment.
#[derive(Clone)]
pub struct Config {
    api_key: Option<String>,
    base_url: Url,
    bind_addr: SocketAddr,
    cache_dir: PathBuf,
    loopback_bind: bool,
    allowed_hosts: Vec<String>,
    /// Argon2id hash of the optional access password.
    platform_passwd: Option<String>,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print the API key itself.
        f.debug_struct("Config")
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("base_url", &self.base_url.as_str())
            .field("bind_addr", &self.bind_addr)
            .field("cache_dir", &self.cache_dir)
            .field("loopback_bind", &self.loopback_bind)
            .field("allowed_hosts", &self.allowed_hosts)
            .field(
                "platform_passwd",
                &self.platform_passwd.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl Config {
    /// Load configuration from the process environment (after `.env`).
    pub fn from_env() -> Result<Self, ConfigError> {
        let api_key = std::env::var("DEEPSEEK_API_KEY")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());

        let raw_base = std::env::var("DEEPSEEK_BASE_URL")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());

        let base_url = parse_base_url(&raw_base)?;

        let raw_bind = std::env::var("BIND_ADDR")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_BIND_ADDR.to_owned());

        let bind_addr = SocketAddr::from_str(&raw_bind)
            .map_err(|err| ConfigError::BindAddr(format!("{raw_bind} ({err})")))?;

        let loopback_bind = bind_addr.ip().is_loopback();

        let allowed_hosts = std::env::var(ALLOWED_HOSTS_ENV)
            .ok()
            .map(|raw| parse_allowed_hosts(&raw))
            .unwrap_or_default();

        // A malformed password hash must abort startup: silently falling back
        // to "no password" would be a security downgrade.
        let platform_passwd = match std::env::var(PLATFORM_PASSWD_ENV)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            Some(raw) => {
                crate::auth::validate_password_hash(&raw)
                    .map_err(|_| ConfigError::PlatformPasswd)?;
                Some(raw)
            }
            None => None,
        };

        Ok(Self {
            api_key,
            base_url,
            bind_addr,
            cache_dir: PathBuf::from(CACHE_DIR),
            loopback_bind,
            allowed_hosts,
            platform_passwd,
        })
    }

    /// Construct a configuration directly (tests, embedding, tooling).
    pub fn new(
        api_key: Option<String>,
        base_url: Url,
        bind_addr: SocketAddr,
        cache_dir: PathBuf,
    ) -> Self {
        let loopback_bind = bind_addr.ip().is_loopback();
        Self {
            api_key,
            base_url,
            bind_addr,
            cache_dir,
            loopback_bind,
            allowed_hosts: Vec::new(),
            platform_passwd: None,
        }
    }

    /// Attach an Argon2id password hash, enabling the access gate.
    pub fn with_platform_passwd(mut self, hash: Option<String>) -> Self {
        self.platform_passwd = hash;
        self
    }

    /// Replace the optional `Host` allowlist. Entries are normalised with
    /// [`parse_allowed_hosts`] semantics (lowercase, no port, no trailing dot).
    pub fn with_allowed_hosts(mut self, hosts: impl IntoIterator<Item = String>) -> Self {
        self.allowed_hosts = hosts
            .into_iter()
            .filter_map(|raw| normalise_allowed_host(&raw))
            .collect();
        self.allowed_hosts.sort_unstable();
        self.allowed_hosts.dedup();
        self
    }

    /// Configured `Host` allowlist; empty means "not configured".
    pub fn allowed_hosts(&self) -> &[String] {
        &self.allowed_hosts
    }

    /// True when `host` (already lowercased by the caller) is allowlisted.
    pub fn host_allowed(&self, host: &str) -> bool {
        let normalised = host.trim_end_matches('.').to_ascii_lowercase();
        self.allowed_hosts
            .iter()
            .any(|allowed| allowed == &normalised)
    }

    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    pub fn is_upstream_configured(&self) -> bool {
        self.api_key.is_some()
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }

    pub fn cache_dir(&self) -> &PathBuf {
        &self.cache_dir
    }

    /// True when the listener is bound to a loopback address.
    pub fn loopback_bind(&self) -> bool {
        self.loopback_bind
    }

    /// Stable identity of the upstream used as part of the cache key, so that
    /// pointing the service at a different base URL never reuses old entries.
    pub fn upstream_identity(&self) -> String {
        self.base_url.as_str().trim_end_matches('/').to_owned()
    }

    /// Configured Argon2id hash, or `None` when the access gate is disabled.
    pub fn platform_passwd(&self) -> Option<&str> {
        self.platform_passwd.as_deref()
    }

    /// Whether the optional access password gate is enabled.
    pub fn auth_enabled(&self) -> bool {
        self.platform_passwd.is_some()
    }

    /// True when the upstream lives on this machine (local mock or a same-host
    /// reverse proxy). Loopback traffic must never be sent through a proxy.
    pub fn base_url_is_loopback(&self) -> bool {
        match self.base_url.host() {
            Some(url::Host::Domain(domain)) => {
                domain.eq_ignore_ascii_case("localhost") || domain.ends_with(".localhost")
            }
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        }
    }

    /// `POST {base}/v1/tools/search`
    pub fn search_endpoint(&self) -> Url {
        join_endpoint(&self.base_url, "tools/search")
    }

    /// `POST {base}/v1/tools/fetch`
    pub fn fetch_endpoint(&self) -> Url {
        join_endpoint(&self.base_url, "tools/fetch")
    }
}

/// Normalise the base URL: absolute, http(s), with a host, no credentials,
/// query or fragment. Plain HTTP is only tolerated for loopback hosts (local
/// development / mock upstreams).
pub fn parse_base_url(raw: &str) -> Result<Url, ConfigError> {
    // Error messages must never echo credentials embedded in a bad base URL.
    let shown = redact_credentials(raw);
    let url = Url::parse(raw).map_err(|err| ConfigError::BaseUrl(format!("{shown}: {err}")))?;

    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(ConfigError::BaseUrl(format!(
                "仅支持 http/https，收到 {other}"
            )));
        }
    }

    if url.host().is_none() {
        return Err(ConfigError::BaseUrl(format!("{shown}: 缺少 host")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::BaseUrl(format!(
            "{shown}: 不允许携带用户名或密码"
        )));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ConfigError::BaseUrl(format!(
            "{shown}: 不允许携带 query 或 fragment"
        )));
    }

    let is_loopback = match url.host() {
        Some(url::Host::Domain(domain)) => {
            domain.eq_ignore_ascii_case("localhost") || domain.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };

    if url.scheme() == "http" && !is_loopback {
        return Err(ConfigError::BaseUrl(format!(
            "{shown}: 非回环地址必须使用 https"
        )));
    }

    Ok(url)
}

/// Replace the userinfo section of a URL-shaped string with `***`.
///
/// [`parse_base_url`] rejects credentials, but the rejection message should not
/// become the place where a mistaken password ends up in the logs.
pub fn redact_credentials(raw: &str) -> String {
    let Some(scheme_end) = raw.find("://") else {
        return raw.to_owned();
    };
    let authority_start = scheme_end + 3;
    let authority = &raw[authority_start..];
    let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    let authority = &authority[..authority_end];
    let Some(at) = authority.rfind('@') else {
        return raw.to_owned();
    };

    let mut redacted = String::with_capacity(raw.len());
    redacted.push_str(&raw[..authority_start]);
    redacted.push_str("***@");
    redacted.push_str(&authority[at + 1..]);
    redacted.push_str(&raw[authority_start + authority_end..]);
    redacted
}

/// Parse a comma separated `ALLOWED_HOSTS` value into normalised hostnames.
pub fn parse_allowed_hosts(raw: &str) -> Vec<String> {
    let mut hosts: Vec<String> = raw.split(',').filter_map(normalise_allowed_host).collect();
    hosts.sort_unstable();
    hosts.dedup();
    hosts
}

/// Normalise one allowlist entry: drop an optional port, a trailing dot and
/// surrounding whitespace, then lowercase.
fn normalise_allowed_host(entry: &str) -> Option<String> {
    let entry = entry.trim();
    if entry.is_empty() {
        return None;
    }
    let host = if let Some(rest) = entry.strip_prefix('[') {
        // Bracketed IPv6 literal, optionally followed by `:port`.
        rest.split_once(']').map(|(inner, _)| inner)?
    } else {
        match entry.rsplit_once(':') {
            Some((head, tail)) if tail.bytes().all(|byte| byte.is_ascii_digit()) => head,
            _ => entry,
        }
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() { None } else { Some(host) }
}

/// Append `v1/<path>` to a base URL, tolerating bases that already end in
/// `/v1` (a common reverse-proxy layout).
fn join_endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let trimmed = url.path().trim_end_matches('/');
    let suffix = if trimmed.ends_with("/v1") {
        format!("{trimmed}/{path}")
    } else {
        format!("{trimmed}/v1/{path}")
    };
    url.set_path(&suffix);
    url
}

/// True when the host is a loopback name or address (used by URL validation).
pub fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_base_url_endpoints() {
        let base = parse_base_url(DEFAULT_BASE_URL).expect("valid");
        let mut cfg = Config::new(
            Some("k".into()),
            base,
            DEFAULT_BIND_ADDR.parse().unwrap(),
            PathBuf::from(".cache"),
        );
        assert_eq!(
            cfg.search_endpoint().as_str(),
            "https://api.deepseek.com/v1/tools/search"
        );
        assert_eq!(
            cfg.fetch_endpoint().as_str(),
            "https://api.deepseek.com/v1/tools/fetch"
        );
        // Cache identity must survive trailing slashes.
        cfg.base_url = parse_base_url("https://api.deepseek.com/").unwrap();
        assert_eq!(cfg.upstream_identity(), "https://api.deepseek.com");
    }

    #[test]
    fn base_url_with_v1_suffix_is_not_duplicated() {
        let base = parse_base_url("https://api.deepseek.com/v1").expect("valid");
        let cfg = Config::new(
            None,
            base,
            DEFAULT_BIND_ADDR.parse().unwrap(),
            PathBuf::from(".cache"),
        );
        assert_eq!(
            cfg.search_endpoint().as_str(),
            "https://api.deepseek.com/v1/tools/search"
        );
    }

    #[test]
    fn local_mock_over_http_is_allowed() {
        assert!(parse_base_url("http://127.0.0.1:9000").is_ok());
        assert!(parse_base_url("http://localhost:9000").is_ok());
        assert!(parse_base_url("http://[::1]:9000").is_ok());
    }

    #[test]
    fn insecure_or_credentialed_bases_are_rejected() {
        assert!(parse_base_url("http://api.deepseek.com").is_err());
        assert!(parse_base_url("ftp://api.deepseek.com").is_err());
        assert!(parse_base_url("https://user:pass@api.deepseek.com").is_err());
        assert!(parse_base_url("https://api.deepseek.com/?x=1").is_err());
        assert!(parse_base_url("https://api.deepseek.com/#frag").is_err());
        assert!(parse_base_url("not a url").is_err());
    }

    #[test]
    fn debug_never_leaks_api_key() {
        let cfg = Config::new(
            Some("sk-super-secret".into()),
            parse_base_url(DEFAULT_BASE_URL).unwrap(),
            DEFAULT_BIND_ADDR.parse().unwrap(),
            PathBuf::from(".cache"),
        );
        let rendered = format!("{cfg:?}");
        assert!(!rendered.contains("sk-super-secret"));
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn debug_never_leaks_password_hash() {
        // The Argon2 PHC string doubles as the token-signing secret: anyone who
        // sees it can forge bearer tokens, so it must never be rendered.
        let hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo";
        let cfg = Config::new(
            Some("k".into()),
            parse_base_url(DEFAULT_BASE_URL).unwrap(),
            DEFAULT_BIND_ADDR.parse().unwrap(),
            PathBuf::from(".cache"),
        )
        .with_platform_passwd(Some(hash.to_owned()));
        let rendered = format!("{cfg:?}");
        assert!(!rendered.contains("argon2"), "hash leaked: {rendered}");
        assert!(
            !rendered.contains("aGFzaGhhc2hoYXNo"),
            "hash leaked: {rendered}"
        );
        assert!(rendered.contains("<redacted>"));
        assert!(cfg.auth_enabled());
    }

    #[test]
    fn allowed_hosts_are_normalised() {
        let hosts = parse_allowed_hosts(" Search.Example.COM , [::1]:8080, localhost.:8080,,");
        assert_eq!(hosts, vec!["::1", "localhost", "search.example.com"]);

        let cfg = Config::new(
            None,
            parse_base_url(DEFAULT_BASE_URL).unwrap(),
            "0.0.0.0:8080".parse().unwrap(),
            PathBuf::from(".cache"),
        )
        .with_allowed_hosts([
            "Search.Example.com".to_owned(),
            "search.example.com".to_owned(),
        ]);
        assert_eq!(cfg.allowed_hosts(), ["search.example.com".to_owned()]);
        assert!(cfg.host_allowed("SEARCH.example.com"));
        assert!(cfg.host_allowed("search.example.com."));
        assert!(!cfg.host_allowed("evil.example"));

        let defaults = Config::new(
            None,
            parse_base_url(DEFAULT_BASE_URL).unwrap(),
            DEFAULT_BIND_ADDR.parse().unwrap(),
            PathBuf::from(".cache"),
        );
        assert!(defaults.allowed_hosts().is_empty());
    }

    #[test]
    fn base_url_errors_do_not_echo_credentials() {
        let raw = "http://user:super-secret@api.example.com";
        let err = parse_base_url(raw).expect_err("credentials must be rejected");
        let rendered = err.to_string();
        assert!(!rendered.contains("super-secret"), "{rendered}");
        assert!(rendered.contains("***@"), "{rendered}");

        assert_eq!(
            redact_credentials("https://u:p@h:8443/v1?x=1"),
            "https://***@h:8443/v1?x=1"
        );
        assert_eq!(redact_credentials("not a url"), "not a url");
        assert_eq!(
            redact_credentials("https://api.deepseek.com"),
            "https://api.deepseek.com"
        );
    }
}
