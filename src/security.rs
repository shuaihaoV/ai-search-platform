//! CSRF, host, client-IP, rate-limiting and security-header guards.

use std::collections::HashMap;
use std::net::IpAddr;
use std::net::Ipv6Addr;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use axum::extract::ConnectInfo;
use axum::extract::Request;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::Method;
use axum::http::header::CONTENT_TYPE;
use axum::http::header::HOST;
use axum::http::header::ORIGIN;
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;

use crate::config;
use crate::config::Config;
use crate::error::AppError;
use crate::state::AppState;

/// Upper bound on tracked per-client rate-limit buckets.
const MAX_RATE_LIMIT_BUCKETS: usize = 16_384;
/// Minimum delay between full bucket sweeps; keeps the sweep `O(n)` cost from
/// being paid on every request when the map is large.
const BUCKET_CLEANUP_INTERVAL: Duration = Duration::from_secs(1);

/// Middleware enforcing host, origin and fetch-metadata rules for `/api/*`.
pub async fn guard_api(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match check_request(state.config(), &request) {
        Ok(()) => next.run(request).await,
        Err(err) => err.into_response(),
    }
}

/// Middleware applying the per-IP search rate limit.
/// Extract the bearer token from `Authorization` or `X-Platform-Token`.
fn extract_token(request: &Request) -> Option<String> {
    if let Some(value) = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        let token = value.trim();
        if !token.is_empty() {
            return Some(token.to_owned());
        }
    }
    request
        .headers()
        .get("x-platform-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Require a valid access token when the password gate is enabled.
///
/// No-op when `PLATFORM_PASSWD` is unset, so unprotected deployments keep
/// their previous behaviour byte for byte.
pub async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let Some(issuer) = state.token_issuer() else {
        return next.run(request).await;
    };
    let token = extract_token(&request);
    let ok = match token {
        Some(token) => issuer.verify(&token, crate::cache::unix_now() as i64),
        None => false,
    };
    if ok {
        return next.run(request).await;
    }
    AppError::unauthorized("需要访问密码").into_response()
}

/// Brute-force brake for the login endpoint (separate bucket from search/fetch).
pub async fn limit_login(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match enforce_rate_limit(state.login_limiter(), &request, "登录") {
        Ok(()) => next.run(request).await,
        Err(err) => err.into_response(),
    }
}

pub async fn limit_search(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match enforce_rate_limit(state.search_limiter(), &request, "搜索") {
        Ok(()) => next.run(request).await,
        Err(err) => err.into_response(),
    }
}

/// Middleware applying the per-IP fetch rate limit.
pub async fn limit_fetch(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match enforce_rate_limit(state.fetch_limiter(), &request, "抓取") {
        Ok(()) => next.run(request).await,
        Err(err) => err.into_response(),
    }
}

/// Validate a request against host, CSRF and fetch-metadata rules.
pub fn check_request(config: &Config, request: &Request) -> Result<(), AppError> {
    let authority = request_authority(request)?;
    check_host(config, &authority)?;

    if request.method() != Method::POST {
        return Ok(());
    }

    let headers = request.headers();
    check_csrf_header(headers)?;
    check_content_type(headers)?;
    check_origin(config, headers, &authority)?;
    check_fetch_metadata(headers)?;
    Ok(())
}

/// Normalised `Host` authority (`host` without brackets/trailing dot, optional port).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Authority {
    host: String,
    port: Option<u16>,
}

/// Resolve the request authority.
///
/// HTTP/1.1 carries it in the `Host` header. HTTP/2 replaces that header with
/// the `:authority` pseudo-header, which hyper exposes through the request URI;
/// without the URI fallback every HTTP/2 request would be rejected as if the
/// `Host` header were missing.
fn request_authority(request: &Request) -> Result<Authority, AppError> {
    let hosts: Vec<&str> = request
        .headers()
        .get_all(HOST)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    // Duplicate Host headers are a smuggling smell.
    if hosts.len() > 1 {
        return Err(AppError::forbidden("重复的 Host 头"));
    }
    if let Some(host) = hosts.first() {
        return parse_authority(host);
    }
    match request.uri().authority() {
        Some(authority) => parse_authority(authority.as_str()),
        None => Err(AppError::forbidden("缺少 Host 头")),
    }
}

/// Strictly parse a `Host` header / URI authority value.
fn parse_authority(raw: &str) -> Result<Authority, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::forbidden("Host 头缺少主机名"));
    }
    if value.len() > 512 {
        return Err(AppError::forbidden("Host 头过长"));
    }
    if value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '@' | '#' | '?' | ',' | '%'))
    {
        return Err(AppError::forbidden("Host 头格式非法"));
    }

    if let Some(rest) = value.strip_prefix('[') {
        let (inner, tail) = rest
            .split_once(']')
            .ok_or_else(|| AppError::forbidden("Host 头 IPv6 格式非法"))?;
        let ip: Ipv6Addr = inner
            .parse()
            .map_err(|_| AppError::forbidden("Host 头 IPv6 格式非法"))?;
        let port = parse_port_suffix(tail)?;
        return Ok(Authority {
            host: ip.to_string(),
            port,
        });
    }

    let (host_part, port) = match value.rsplit_once(':') {
        Some((host, port)) => {
            // More than one colon means a bare (unbracketed) IPv6 literal or
            // garbage; RFC 3986 requires brackets, so reject it.
            if host.contains(':') {
                return Err(AppError::forbidden("Host 头格式非法"));
            }
            (host, Some(parse_port(port)?))
        }
        None => (value, None),
    };

    Ok(Authority {
        host: normalise_host_name(host_part)?,
        port,
    })
}

fn parse_port_suffix(tail: &str) -> Result<Option<u16>, AppError> {
    if tail.is_empty() {
        return Ok(None);
    }
    let port = tail
        .strip_prefix(':')
        .ok_or_else(|| AppError::forbidden("Host 头端口格式非法"))?;
    Ok(Some(parse_port(port)?))
}

fn parse_port(raw: &str) -> Result<u16, AppError> {
    if raw.is_empty() || raw.len() > 5 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::forbidden("Host 头端口格式非法"));
    }
    raw.parse::<u16>()
        .map_err(|_| AppError::forbidden("Host 头端口格式非法"))
}

/// Strip a trailing root dot and lowercase; reject malformed hostnames.
fn normalise_host_name(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim_end_matches('.');
    if trimmed.is_empty() {
        return Err(AppError::forbidden("Host 头缺少主机名"));
    }
    // IPv4 literals (`127.0.0.1`) are kept canonical.
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    if trimmed.len() > 253 {
        return Err(AppError::forbidden("Host 头过长"));
    }
    let valid = trimmed.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    });
    if !valid {
        return Err(AppError::forbidden("Host 头格式非法"));
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// Reject requests whose `Host` cannot be ours.
fn check_host(config: &Config, authority: &Authority) -> Result<(), AppError> {
    let host = authority.host.as_str();
    let loopback = config::is_loopback_host(host);

    if config.loopback_bind() {
        // Loopback binds are reachable by any process on this machine, so a
        // foreign `Host` is the signature of a DNS-rebinding attempt.
        if loopback || config.host_allowed(host) {
            return Ok(());
        }
        return Err(AppError::forbidden(
            "服务仅绑定回环地址，拒绝非本机 Host 的请求",
        ));
    }

    // Public bind: without an explicit allowlist the Host is operator/proxy
    // defined and cannot be validated. With `ALLOWED_HOSTS` set, enforce it.
    if !config.allowed_hosts().is_empty() && !loopback && !config.host_allowed(host) {
        return Err(AppError::forbidden("Host 不在 ALLOWED_HOSTS 白名单内"));
    }
    Ok(())
}

fn check_csrf_header(headers: &HeaderMap) -> Result<(), AppError> {
    let value = headers
        .get(config::CSRF_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    match value {
        Some(value) if value == config::CSRF_HEADER_VALUE => Ok(()),
        _ => Err(AppError::forbidden(
            "缺少或错误的 X-Requested-With 请求头（CSRF 防护）",
        )),
    }
}

fn check_content_type(headers: &HeaderMap) -> Result<(), AppError> {
    let value = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or_default();
    let essence = value.split(';').next().unwrap_or_default().trim();
    if essence.eq_ignore_ascii_case("application/json") {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "Content-Type 必须为 application/json（CSRF 防护）",
        ))
    }
}

/// When an Origin header is present it must be same-origin with `Host`.
fn check_origin(
    config: &Config,
    headers: &HeaderMap,
    authority: &Authority,
) -> Result<(), AppError> {
    let origins: Vec<&str> = headers
        .get_all(ORIGIN)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    // Browsers send exactly one Origin; a duplicate is attacker/proxy noise.
    if origins.len() > 1 {
        return Err(AppError::forbidden("重复的 Origin 头"));
    }
    let Some(raw) = origins.first() else {
        return Ok(());
    };
    let origin = raw.trim();

    if origin.is_empty() || origin == "null" {
        return Err(AppError::forbidden("拒绝空或 null 的 Origin"));
    }

    let parsed =
        url::Url::parse(origin).map_err(|_| AppError::forbidden("Origin 头不是合法 URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::forbidden("Origin 仅支持 http/https"));
    }
    if !parsed.path().is_empty() && parsed.path() != "/" {
        return Err(AppError::forbidden("Origin 不应携带路径"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::forbidden("Origin 不应携带凭据"));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::forbidden("Origin 不应携带 query 或 fragment"));
    }

    let origin_host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.trim_end_matches('.').to_ascii_lowercase(),
        Some(url::Host::Ipv4(ip)) => ip.to_string(),
        Some(url::Host::Ipv6(ip)) => ip.to_string(),
        None => return Err(AppError::forbidden("Origin 缺少主机名")),
    };

    if origin_host != authority.host {
        return Err(AppError::forbidden("Origin 与 Host 不一致（CSRF 防护）"));
    }

    if config.loopback_bind()
        && let (Some(origin_port), Some(host_port)) =
            (parsed.port_or_known_default(), authority.port)
        && origin_port != host_port
    {
        return Err(AppError::forbidden("Origin 端口与 Host 不一致"));
    }

    Ok(())
}

fn check_fetch_metadata(headers: &HeaderMap) -> Result<(), AppError> {
    let Some(value) = headers.get("sec-fetch-site") else {
        return Ok(());
    };
    let value = value
        .to_str()
        .map_err(|_| AppError::forbidden("Sec-Fetch-Site 头格式非法"))?
        .trim();
    match value {
        "same-origin" | "none" => Ok(()),
        _ => Err(AppError::forbidden("拒绝跨站请求（Sec-Fetch-Site 校验）")),
    }
}

/// Resolve the effective client IP, trusting `X-Forwarded-For` only when the
/// direct peer is loopback (i.e. a same-host reverse proxy).
///
/// The *rightmost* entry is used: a same-host proxy appends the address it saw
/// to any client-supplied value, so everything to its left is attacker
/// controlled and must never become a rate-limit key.
pub fn client_ip(peer: Option<IpAddr>, headers: &HeaderMap) -> Option<IpAddr> {
    let peer = peer?;
    if !peer.is_loopback() {
        return Some(peer);
    }
    // A proxy usually joins values into one header, but some configurations
    // append a second header instead; only the last header can have been
    // written by the trusted hop.
    let forwarded = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .next_back();
    if let Some(forwarded) = forwarded {
        // Only the rightmost entry (appended by the trusted local proxy) is
        // used. If it is not a valid IP, ignore the header entirely rather than
        // falling back to the attacker-controlled part on the left.
        let last = forwarded.rsplit(',').next().map(str::trim).unwrap_or("");
        if let Ok(ip) = last.parse::<IpAddr>() {
            return Some(ip);
        }
    }
    Some(peer)
}

/// Collapse a client IP into its rate-limit bucket.
///
/// A single IPv6 subscriber usually owns a whole `/64`, so keying on the full
/// address lets an attacker rotate through billions of free buckets. IPv4 is
/// used as-is; IPv4-mapped IPv6 is folded back to IPv4.
pub fn limiter_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let segments = v6.segments();
                IpAddr::V6(Ipv6Addr::new(
                    segments[0],
                    segments[1],
                    segments[2],
                    segments[3],
                    0,
                    0,
                    0,
                    0,
                ))
            }
        },
    }
}

/// Fixed-window, per-IP rate limiter.
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    buckets: Mutex<Buckets>,
}

struct Buckets {
    map: HashMap<IpAddr, (u32, Instant)>,
    last_cleanup: Instant,
}

impl RateLimiter {
    pub fn new(limit: u32) -> Self {
        Self {
            limit,
            window: Duration::from_secs(60),
            buckets: Mutex::new(Buckets {
                map: HashMap::new(),
                last_cleanup: Instant::now(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Buckets> {
        match self.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// `Ok(())` when under the limit, otherwise the seconds to wait.
    pub fn check(&self, ip: IpAddr) -> Result<(), u64> {
        if self.limit == 0 {
            return Ok(());
        }
        let now = Instant::now();
        let mut buckets = self.lock();

        // Expire stale buckets, but at most once per interval: running an
        // `O(n)` sweep on every request would be a cheap CPU-amplification
        // vector for an attacker rotating source addresses.
        if now.saturating_duration_since(buckets.last_cleanup) >= BUCKET_CLEANUP_INTERVAL
            || buckets.map.len() > MAX_RATE_LIMIT_BUCKETS
        {
            buckets
                .map
                .retain(|_, (_, started)| now.saturating_duration_since(*started) < self.window);
            buckets.last_cleanup = now;
        }
        if buckets.map.len() > MAX_RATE_LIMIT_BUCKETS {
            // Hard memory bound under a distributed address flood. Clearing
            // fails open for one window, which is preferable to unbounded memory.
            buckets.map.clear();
        }

        let entry = buckets.map.entry(ip).or_insert((0, now));
        if now.saturating_duration_since(entry.1) >= self.window {
            *entry = (0, now);
        }
        if entry.0 >= self.limit {
            let elapsed = now.saturating_duration_since(entry.1).as_secs();
            let remaining = self.window.as_secs().saturating_sub(elapsed).max(1);
            return Err(remaining);
        }
        entry.0 += 1;
        Ok(())
    }
}

/// Peer address recorded by axum when the router is served with connect info.
pub fn peer_ip(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip())
}

/// Apply the limit to the effective client IP of a request.
pub fn enforce_rate_limit(
    limiter: &RateLimiter,
    request: &Request,
    label: &str,
) -> Result<(), AppError> {
    // Without connection info (e.g. embedded use) every request shares one
    // bucket; production serving always provides it.
    let ip = client_ip(peer_ip(request), request.headers())
        .unwrap_or_else(|| IpAddr::from([0, 0, 0, 0]));
    limiter.check(limiter_key(ip)).map_err(|seconds| {
        AppError::rate_limited(format!("{label}请求过于频繁，请稍后重试")).with_retry_after(seconds)
    })
}

/// Security headers applied to every response.
pub fn security_headers() -> [(axum::http::HeaderName, &'static str); 9] {
    use axum::http::header::HeaderName;
    [
        (
            HeaderName::from_static("content-security-policy"),
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; media-src 'none'",
        ),
        (HeaderName::from_static("x-content-type-options"), "nosniff"),
        (HeaderName::from_static("x-frame-options"), "DENY"),
        (HeaderName::from_static("referrer-policy"), "no-referrer"),
        (
            HeaderName::from_static("permissions-policy"),
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
        ),
        (
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ),
        (
            HeaderName::from_static("cross-origin-resource-policy"),
            "same-origin",
        ),
        (HeaderName::from_static("x-robots-tag"), "noindex, nofollow"),
        (HeaderName::from_static("x-dns-prefetch-control"), "off"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    fn make_request(method: Method, headers: &[(&str, &str)]) -> Request {
        let mut builder = axum::http::Request::builder()
            .method(method)
            .uri("/api/search");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).expect("valid request")
    }

    fn config() -> Config {
        Config::new(
            Some("k".into()),
            crate::config::parse_base_url("https://api.deepseek.com").unwrap(),
            "127.0.0.1:8080".parse().unwrap(),
            std::path::PathBuf::from(".cache"),
        )
    }

    #[test]
    fn authority_parsing_is_strict() {
        assert_eq!(
            parse_authority("localhost:8080").expect("valid"),
            Authority {
                host: "localhost".to_owned(),
                port: Some(8080),
            }
        );
        assert_eq!(
            parse_authority("[::1]:8080").expect("valid"),
            Authority {
                host: "::1".to_owned(),
                port: Some(8080),
            }
        );
        assert_eq!(
            parse_authority("[::1]").expect("valid"),
            Authority {
                host: "::1".to_owned(),
                port: None,
            }
        );
        assert_eq!(
            parse_authority("Example.COM.:443").expect("valid"),
            Authority {
                host: "example.com".to_owned(),
                port: Some(443),
            }
        );
        assert_eq!(
            parse_authority("127.0.0.1").expect("valid").host,
            "127.0.0.1"
        );

        for bad in [
            "",
            " ",
            "bad host",
            "a/b",
            "user@host",
            "[::1]evil",
            "[example.com]",
            "example.com:8080:90",
            "example.com:99999",
            "example.com:",
            "evil.example\\x",
            "::1",
            "a%2fb",
            "host,",
        ] {
            assert!(parse_authority(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn h2_authority_without_host_header_is_accepted() {
        let cfg = config();
        let request = axum::http::Request::builder()
            .method(Method::GET)
            .uri("http://localhost:8080/api/health")
            .body(Body::empty())
            .expect("valid request");
        assert!(check_request(&cfg, &request).is_ok());

        // The same fallback must keep the Origin comparison intact.
        let request = axum::http::Request::builder()
            .method(Method::POST)
            .uri("http://localhost:8080/api/search")
            .header(config::CSRF_HEADER, config::CSRF_HEADER_VALUE)
            .header("content-type", "application/json")
            .header("origin", "http://localhost:8080")
            .body(Body::empty())
            .expect("valid request");
        assert!(check_request(&cfg, &request).is_ok());
    }

    #[test]
    fn allowed_hosts_are_enforced_on_public_binds() {
        let cfg = Config::new(
            Some("k".into()),
            crate::config::parse_base_url("https://api.deepseek.com").unwrap(),
            "0.0.0.0:8080".parse().unwrap(),
            std::path::PathBuf::from(".cache"),
        )
        .with_allowed_hosts(["search.example.com".to_owned()]);

        assert!(
            check_request(
                &cfg,
                &make_request(Method::GET, &[("host", "search.example.com")])
            )
            .is_ok()
        );
        // Same-machine health checks keep working.
        assert!(
            check_request(
                &cfg,
                &make_request(Method::GET, &[("host", "127.0.0.1:8080")])
            )
            .is_ok()
        );
        // A rebinding domain that merely resolves here is rejected.
        assert!(
            check_request(
                &cfg,
                &make_request(Method::GET, &[("host", "evil.example")])
            )
            .is_err()
        );
    }

    #[test]
    fn loopback_bind_accepts_allowlisted_proxy_host() {
        let cfg = config().with_allowed_hosts(["search.example.com".to_owned()]);
        assert!(
            check_request(
                &cfg,
                &make_request(Method::GET, &[("host", "search.example.com")])
            )
            .is_ok()
        );
        assert!(
            check_request(
                &cfg,
                &make_request(Method::GET, &[("host", "evil.example")])
            )
            .is_err()
        );
    }

    #[test]
    fn public_bind_without_allowlist_keeps_previous_behaviour() {
        let cfg = Config::new(
            Some("k".into()),
            crate::config::parse_base_url("https://api.deepseek.com").unwrap(),
            "0.0.0.0:8080".parse().unwrap(),
            std::path::PathBuf::from(".cache"),
        );
        assert!(
            check_request(&cfg, &make_request(Method::GET, &[("host", "example.com")])).is_ok()
        );
        assert!(
            check_request(
                &cfg,
                &make_request(Method::GET, &[("host", "example.com:8080")])
            )
            .is_ok()
        );
        assert!(check_request(&cfg, &make_request(Method::GET, &[("host", "bad host")])).is_err());
    }

    #[test]
    fn loopback_bind_rejects_foreign_hosts() {
        let cfg = config();
        let err = check_request(
            &cfg,
            &make_request(Method::GET, &[("host", "evil.example")]),
        )
        .expect_err("foreign host must be rejected");
        assert_eq!(err.code, crate::error::ErrorCode::Forbidden);
    }

    #[test]
    fn loopback_aliases_are_accepted() {
        let cfg = config();
        for host in ["localhost:8080", "127.0.0.1:8080", "[::1]:8080"] {
            assert!(
                check_request(&cfg, &make_request(Method::GET, &[("host", host)])).is_ok(),
                "{host} should be accepted"
            );
        }
    }

    #[test]
    fn missing_host_is_rejected() {
        let cfg = config();
        assert!(check_request(&cfg, &make_request(Method::GET, &[])).is_err());
    }

    #[test]
    fn duplicate_host_headers_are_rejected() {
        let cfg = config();
        let request = make_request(
            Method::GET,
            &[("host", "localhost:8080"), ("host", "localhost:8080")],
        );
        assert!(check_request(&cfg, &request).is_err());
    }

    #[test]
    fn post_requires_csrf_header() {
        let cfg = config();
        let request = make_request(
            Method::POST,
            &[
                ("host", "localhost:8080"),
                ("content-type", "application/json"),
            ],
        );
        assert!(check_request(&cfg, &request).is_err());
    }

    #[test]
    fn post_requires_json_content_type() {
        let cfg = config();
        let request = make_request(
            Method::POST,
            &[
                ("host", "localhost:8080"),
                (config::CSRF_HEADER, config::CSRF_HEADER_VALUE),
                ("content-type", "text/plain"),
            ],
        );
        assert!(check_request(&cfg, &request).is_err());

        let charset_request = make_request(
            Method::POST,
            &[
                ("host", "localhost:8080"),
                (config::CSRF_HEADER, config::CSRF_HEADER_VALUE),
                ("content-type", "application/json; charset=utf-8"),
            ],
        );
        assert!(check_request(&cfg, &charset_request).is_ok());
    }

    #[test]
    fn cross_site_origins_are_rejected() {
        let cfg = config();
        for origin in ["https://evil.example", "null", "", "file:///etc/passwd"] {
            let request = make_request(
                Method::POST,
                &[
                    ("host", "localhost:8080"),
                    (config::CSRF_HEADER, config::CSRF_HEADER_VALUE),
                    ("content-type", "application/json"),
                    ("origin", origin),
                ],
            );
            assert!(
                check_request(&cfg, &request).is_err(),
                "origin {origin} must be rejected"
            );
        }
    }

    #[test]
    fn duplicate_origin_headers_are_rejected() {
        let cfg = config();
        let request = make_request(
            Method::POST,
            &[
                ("host", "localhost:8080"),
                (config::CSRF_HEADER, config::CSRF_HEADER_VALUE),
                ("content-type", "application/json"),
                ("origin", "http://localhost:8080"),
                ("origin", "http://localhost:8080"),
            ],
        );
        assert!(check_request(&cfg, &request).is_err());
    }

    #[test]
    fn same_origin_is_accepted() {
        let cfg = config();
        let request = make_request(
            Method::POST,
            &[
                ("host", "localhost:8080"),
                (config::CSRF_HEADER, config::CSRF_HEADER_VALUE),
                ("content-type", "application/json"),
                ("origin", "http://localhost:8080"),
                ("sec-fetch-site", "same-origin"),
            ],
        );
        assert!(check_request(&cfg, &request).is_ok());
    }

    #[test]
    fn cross_site_fetch_metadata_is_rejected() {
        let cfg = config();
        let request = make_request(
            Method::POST,
            &[
                ("host", "localhost:8080"),
                (config::CSRF_HEADER, config::CSRF_HEADER_VALUE),
                ("content-type", "application/json"),
                ("sec-fetch-site", "cross-site"),
            ],
        );
        assert!(check_request(&cfg, &request).is_err());
    }

    #[test]
    fn rate_limiter_enforces_limit() {
        let limiter = RateLimiter::new(2);
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        assert!(limiter.check(ip).is_ok());
        assert!(limiter.check(ip).is_ok());
        let err = limiter.check(ip).expect_err("must be limited");
        assert!(err >= 1);

        let other: IpAddr = "203.0.113.6".parse().unwrap();
        assert!(limiter.check(other).is_ok());
    }

    #[test]
    fn limiter_buckets_ipv6_by_64() {
        let first: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let same_subnet: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        let other_subnet: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(limiter_key(first), limiter_key(same_subnet));
        assert_ne!(limiter_key(first), limiter_key(other_subnet));

        // IPv4-mapped IPv6 collapses to the embedded IPv4 address.
        let mapped: IpAddr = "::ffff:203.0.113.5".parse().unwrap();
        assert_eq!(
            limiter_key(mapped),
            "203.0.113.5".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn xff_is_only_trusted_from_loopback_peers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.7".parse().unwrap());

        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(
            client_ip(Some(loopback), &headers),
            Some("198.51.100.7".parse().unwrap())
        );

        let remote: IpAddr = "203.0.113.9".parse().unwrap();
        assert_eq!(client_ip(Some(remote), &headers), Some(remote));
        assert_eq!(client_ip(None, &headers), None);
    }

    #[test]
    fn spoofed_leftmost_xff_is_ignored() {
        // A client that sends its own X-Forwarded-For before a same-host proxy
        // appends the real peer must not control the rate-limit key.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "1.1.1.1, 8.8.8.8, 198.51.100.7".parse().unwrap(),
        );
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(
            client_ip(Some(loopback), &headers),
            Some("198.51.100.7".parse().unwrap())
        );

        // Garbage on the right falls back to the direct peer, never to the
        // attacker-controlled value.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "198.51.100.7, not-an-ip".parse().unwrap(),
        );
        assert_eq!(client_ip(Some(loopback), &headers), Some(loopback));
    }

    #[test]
    fn repeated_xff_headers_use_the_last_one() {
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", "1.1.1.1".parse().unwrap());
        headers.append("x-forwarded-for", "198.51.100.7".parse().unwrap());
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(
            client_ip(Some(loopback), &headers),
            Some("198.51.100.7".parse().unwrap())
        );
    }

    #[test]
    fn security_headers_include_csp() {
        let headers = security_headers();
        let csp = headers
            .iter()
            .find(|(name, _)| name.as_str() == "content-security-policy")
            .map(|(_, value)| *value)
            .expect("csp present");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("frame-ancestors 'none'"));
    }
}
