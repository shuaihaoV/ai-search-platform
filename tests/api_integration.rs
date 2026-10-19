//! End-to-end HTTP tests against an in-process mock upstream.
//!
//! Each test boots a mock DeepSeek server, points a real `Router` at it, and
//! drives requests through the same middleware stack used in production.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use ai_search_platform::cache::Cache;
use ai_search_platform::config::Config;
use ai_search_platform::state::AppState;
use ai_search_platform::upstream::UpstreamClient;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use http_body_util::BodyExt as _;
use serde_json::Value;
use tower::ServiceExt as _;

/// What the mock saw, so tests can assert on call counts and payloads.
#[derive(Default)]
struct MockState {
    search_calls: Mutex<Vec<Value>>,
    fetch_calls: Mutex<Vec<Value>>,
    auth_headers: Mutex<Vec<String>>,
}

const SEARCH_OK: &str = r#"{"results":[
  {"rerank_score":2.4,"title":"DeepSeek V4 发布","url":"https://example.com/a",
   "snippet":"短摘要","summary":"长摘要","content":"正文内容","site_name":"Example",
   "site_icon":"https://example.com/favicon.ico","date":"2026-06-01T00:00:00+00:00",
   "authority":3},
  {"rerank_score":1.1,"title":"Second","url":"https://example.com/b",
   "snippet":"s2","summary":"m2","content":"","site_name":null,"site_icon":null,
   "date":null,"authority":-1}
]}"#;

const FETCH_OK: &str = r##"{"title":"Example article","content":"# 标题\n\n正文 **bold**"}"##;

async fn mock_search(
    State(state): State<Arc<MockState>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    state.auth_headers.lock().unwrap().push(auth);

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    state.search_calls.lock().unwrap().push(parsed.clone());

    let query = parsed.get("query").and_then(Value::as_str).unwrap_or("");

    if query.contains("ratelimit") {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", "2")],
            axum::Json(serde_json::json!({
                "error": {"message": "rate limited", "type": "rate_limit_error",
                          "param": null, "code": "rate_limit_error"}
            })),
        )
            .into_response();
    }
    if query.contains("unauthorized") {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({
                "error": {"message": "invalid api key", "type": "authentication_error",
                          "param": null, "code": "invalid_api_key"}
            })),
        )
            .into_response();
    }
    if query.contains("boom") {
        return (StatusCode::INTERNAL_SERVER_ERROR, "upstream exploded").into_response();
    }
    if query.contains("badjson") {
        return (StatusCode::OK, "this is not json").into_response();
    }
    if query.contains("empty") {
        return axum::Json(serde_json::json!({"results": []})).into_response();
    }
    if query.contains("huge") {
        let blob = "x".repeat(17 * 1024 * 1024);
        return axum::Json(serde_json::json!({ "results": [{ "content": blob }] })).into_response();
    }

    (
        StatusCode::OK,
        [("content-type", "application/json")],
        SEARCH_OK,
    )
        .into_response()
}

async fn mock_fetch(State(state): State<Arc<MockState>>, body: String) -> axum::response::Response {
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    state.fetch_calls.lock().unwrap().push(parsed.clone());

    let url = parsed.get("url").and_then(Value::as_str).unwrap_or("");
    if url.contains("fail") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "error": {"message": "no content", "type": "not_found_error",
                          "param": null, "code": "not_found"}
            })),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        FETCH_OK,
    )
        .into_response()
}

/// A unique client IP per test, derived from the running test's name so that
/// concurrent tests never share a rate-limit bucket.
fn peer_tag() -> u8 {
    use std::sync::atomic::{AtomicU8, Ordering};
    static COUNTER: AtomicU8 = AtomicU8::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Boot the mock upstream and return its base URL plus its shared state.
async fn start_mock() -> (String, Arc<MockState>) {
    let state = Arc::new(MockState::default());
    let app = Router::new()
        .route("/v1/tools/search", post(mock_search))
        .route("/v1/tools/fetch", post(mock_fetch))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

/// Build the application router pointed at the mock upstream.
async fn start_app(upstream: &str, cache_dir: PathBuf) -> (Router, Arc<Cache>) {
    let bind: SocketAddr = "127.0.0.1:8080".parse().unwrap();
    let config = Config::new(
        Some("test-key".into()),
        ai_search_platform::config::parse_base_url(upstream).unwrap(),
        bind,
        cache_dir,
    );
    let cache = Arc::new(Cache::new(config.cache_dir()).unwrap());
    let client = UpstreamClient::new(&config).unwrap();
    let state = AppState::new(config, client, cache.clone());
    (ai_search_platform::build_app(state), cache)
}

/// Per-request client address so the per-IP rate limiter never couples tests.
fn attach_peer(request: Request<Body>, tag: u8) -> Request<Body> {
    let mut request = request;
    let addr: SocketAddr = format!("198.51.100.{tag}:12345").parse().unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(addr));
    request
}

/// Send a request and decode the JSON body.
async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let request = attach_peer(request, peer_tag());
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, value)
}

fn search_request(query: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/search")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("x-requested-with", "ai-search-platform")
        .body(Body::from(
            serde_json::json!({ "query": query }).to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn search_success_passes_through_full_payload() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let (status, body) = send(&app, search_request("DeepSeek 模型")).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["cache_status"], "miss");
    assert_eq!(body["cached"], false);
    assert_eq!(body["upstream_status"], 200);

    let results = body["data"]["results"].as_array().expect("results array");
    assert_eq!(results.len(), 2);
    // Every documented field survives untouched.
    assert_eq!(results[0]["title"], "DeepSeek V4 发布");
    assert_eq!(results[0]["rerank_score"], 2.4);
    assert_eq!(results[0]["authority"], 3);
    assert_eq!(results[0]["site_name"], "Example");
    assert!(results[0]["date"].is_string());
    assert_eq!(results[1]["site_name"], Value::Null);
    assert_eq!(results[1]["authority"], -1);

    // need_content defaults to true and the key is forwarded.
    let calls = mock.search_calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["need_content"], true);
    assert_eq!(calls[0]["count"], ai_search_platform::config::DEFAULT_COUNT);
    assert!(calls[0].get("force_refresh").is_none());

    let auth = mock.auth_headers.lock().unwrap();
    assert_eq!(auth[0], "Bearer test-key");
}

#[tokio::test]
async fn second_search_is_served_from_cache() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let (first_status, first) = send(&app, search_request("cached query")).await;
    assert_eq!(first_status, StatusCode::OK);
    assert_eq!(first["cache_status"], "miss");

    let (second_status, second) = send(&app, search_request("cached query")).await;
    assert_eq!(second_status, StatusCode::OK);
    assert_eq!(second["cache_status"], "hit");
    assert_eq!(second["cached"], true);
    assert_eq!(second["upstream_status"], 200);
    assert_eq!(second["data"], first["data"]);

    assert_eq!(
        mock.search_calls.lock().unwrap().len(),
        1,
        "upstream must be called once"
    );

    // The entry on disk is a 64 char hex file that never contains the query.
    let entries: Vec<_> = std::fs::read_dir(cache.root().join("search"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries.len(), 1);
    let name = entries[0].trim_end_matches(".json").to_owned();
    assert_eq!(name.len(), 64);
    assert!(
        name.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    assert!(!name.contains("cached"));

    let raw = std::fs::read_to_string(cache.root().join("search").join(&entries[0])).unwrap();
    assert!(!raw.contains("cached query"), "query must not be persisted");
}

#[tokio::test]
async fn force_refresh_bypasses_the_cache() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let _ = send(&app, search_request("refresh me")).await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/search")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("x-requested-with", "ai-search-platform")
        .body(Body::from(
            serde_json::json!({"query": "refresh me", "force_refresh": true}).to_string(),
        ))
        .unwrap();
    let (status, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cache_status"], "miss");
    assert_eq!(mock.search_calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn different_parameters_do_not_share_cache_entries() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let make = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("host", "localhost:8080")
            .header("content-type", "application/json")
            .header("x-requested-with", "ai-search-platform")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    let _ = send(&app, make(serde_json::json!({"query": "same", "count": 5}))).await;
    let (_, body) = send(
        &app,
        make(serde_json::json!({"query": "same", "count": 20})),
    )
    .await;
    assert_eq!(body["cache_status"], "miss");
    assert_eq!(mock.search_calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn empty_results_are_returned_and_cached() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let (status, body) = send(&app, search_request("empty query")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["results"], serde_json::json!([]));

    let (_, again) = send(&app, search_request("empty query")).await;
    assert_eq!(again["cache_status"], "hit");
    assert_eq!(mock.search_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn fetch_returns_markdown_and_is_cached() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .method("POST")
        .uri("/api/fetch")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("x-requested-with", "ai-search-platform")
        .body(Body::from(
            serde_json::json!({"url": "https://example.com/article"}).to_string(),
        ))
        .unwrap();

    let (status, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["data"]["title"], "Example article");
    assert!(
        body["data"]["content"]
            .as_str()
            .unwrap()
            .contains("正文 **bold**")
    );

    let request = Request::builder()
        .method("POST")
        .uri("/api/fetch")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("x-requested-with", "ai-search-platform")
        .body(Body::from(
            serde_json::json!({"url": "https://example.com/article"}).to_string(),
        ))
        .unwrap();
    let (_, again) = send(&app, request).await;
    assert_eq!(again["cache_status"], "hit");
    assert_eq!(mock.fetch_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn upstream_errors_are_mapped() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let (status, body) = send(&app, search_request("ratelimit please")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "upstream_rate_limited");
    assert_eq!(body["error"]["upstream_status"], 429);
    assert_eq!(body["error"]["retry_after_seconds"], 2);
    assert_eq!(body["error"]["retryable"], true);

    let (status, body) = send(&app, search_request("unauthorized now")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "upstream_auth_failed");
    assert_eq!(body["error"]["message"], "invalid api key");

    let (status, body) = send(&app, search_request("badjson please")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "upstream_invalid_response");

    // 5xx is retried once and then surfaces as 502.
    let (status, body) = send(&app, search_request("boom now")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "upstream_error");
}

#[tokio::test]
async fn oversized_upstream_response_is_rejected() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let (status, body) = send(&app, search_request("huge response")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "upstream_invalid_response");
}

#[tokio::test]
async fn validation_errors_are_rejected_before_upstream() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    for query in ["", "   "] {
        let (status, body) = send(&app, search_request(query)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_request");
    }

    let make = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("host", "localhost:8080")
            .header("content-type", "application/json")
            .header("x-requested-with", "ai-search-platform")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    let (status, _) = send(&app, make(serde_json::json!({"query": "x", "count": 51}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        make(serde_json::json!({"query": "x", "localization": "nope"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(&app, make(serde_json::json!({"unknown": 1}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    assert!(mock.search_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn csrf_guards_reject_cross_site_requests() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let build = |headers: &[(&str, &str)]| {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("host", "localhost:8080");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder
            .body(Body::from(serde_json::json!({"query": "csrf"}).to_string()))
            .unwrap()
    };

    // Missing custom header.
    let (status, body) = send(&app, build(&[("content-type", "application/json")])).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "forbidden");

    // Wrong content type.
    let (status, _) = send(
        &app,
        build(&[
            ("content-type", "text/plain"),
            ("x-requested-with", "ai-search-platform"),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Cross-site origin.
    let (status, _) = send(
        &app,
        build(&[
            ("content-type", "application/json"),
            ("x-requested-with", "ai-search-platform"),
            ("origin", "https://evil.example"),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // null origin.
    let (status, _) = send(
        &app,
        build(&[
            ("content-type", "application/json"),
            ("x-requested-with", "ai-search-platform"),
            ("origin", "null"),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Cross-site fetch metadata.
    let (status, _) = send(
        &app,
        build(&[
            ("content-type", "application/json"),
            ("x-requested-with", "ai-search-platform"),
            ("sec-fetch-site", "cross-site"),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Foreign Host on a loopback bind.
    let request = Request::builder()
        .method("GET")
        .uri("/api/health")
        .header("host", "attacker.example")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(&app, request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    assert!(
        mock.search_calls.lock().unwrap().is_empty(),
        "no rejected request may reach the upstream"
    );
}

#[tokio::test]
async fn same_origin_requests_are_accepted() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .method("POST")
        .uri("/api/search")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("x-requested-with", "ai-search-platform")
        .header("origin", "http://localhost:8080")
        .header("sec-fetch-site", "same-origin")
        .body(Body::from(serde_json::json!({"query": "ok"}).to_string()))
        .unwrap();
    let (status, _) = send(&app, request).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn ssrf_targets_are_blocked_before_upstream() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    for url in [
        "http://127.0.0.1/secret",
        "http://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal/",
        "http://metadata.goog/",
        // Alternate numeric spellings normalised by the URL parser.
        "http://2130706433/",
        "http://0x7f000001/",
        "http://127.1/",
        // IPv4 addresses embedded in IPv6 literals.
        "http://[::127.0.0.1]/",
        "http://[::ffff:0:127.0.0.1]/",
        "http://[2002:7f00:1::]/",
        "http://[64:ff9b::7f00:1]/",
        // Internal DNS names / split-DNS suffixes.
        "http://intranet/",
        "http://router.lan/",
    ] {
        let request = Request::builder()
            .method("POST")
            .uri("/api/fetch")
            .header("host", "localhost:8080")
            .header("content-type", "application/json")
            .header("x-requested-with", "ai-search-platform")
            .body(Body::from(serde_json::json!({ "url": url }).to_string()))
            .unwrap();
        let (status, body) = send(&app, request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "url {url} must be blocked");
        assert_eq!(body["error"]["code"], "forbidden");
    }
    assert!(mock.fetch_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn missing_api_key_yields_503() {
    let dir = tempfile::tempdir().unwrap();
    let bind: SocketAddr = "127.0.0.1:8080".parse().unwrap();
    let config = Config::new(
        None,
        ai_search_platform::config::parse_base_url("http://127.0.0.1:9").unwrap(),
        bind,
        dir.path().to_path_buf(),
    );
    let cache = Arc::new(Cache::new(config.cache_dir()).unwrap());
    let client = UpstreamClient::new(&config).unwrap();
    let state = AppState::new(config, client, cache);
    let app = ai_search_platform::build_app(state);

    let (status, body) = send(&app, search_request("no key")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"]["code"], "upstream_not_configured");
}

#[tokio::test]
async fn unknown_api_paths_return_json_404() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .method("GET")
        .uri("/api/nope")
        .header("host", "localhost:8080")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

#[tokio::test]
async fn config_endpoint_never_leaks_the_key() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .method("GET")
        .uri("/api/config")
        .header("host", "localhost:8080")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!text.contains("test-key"));
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["defaults"]["need_content"], true);
    assert_eq!(
        body["defaults"]["count"],
        ai_search_platform::config::DEFAULT_COUNT
    );
    assert_eq!(body["upstream"]["configured"], true);
    assert_eq!(body["cache"]["search_ttl_seconds"], 86400);
}

#[tokio::test]
async fn static_index_and_security_headers_are_served() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .uri("/")
        .header("host", "localhost:8080")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    let csp = headers
        .get("content-security-policy")
        .and_then(|v| v.to_str().ok())
        .expect("CSP header");
    assert!(csp.contains("default-src 'self'"));
    assert!(csp.contains("frame-ancestors 'none'"));
    assert!(!csp.contains("unsafe-inline"));
    assert!(!csp.contains("unsafe-eval"));
    assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");

    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(content_type.starts_with("text/html"));
}

#[tokio::test]
async fn asset_path_traversal_is_rejected() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    for path in ["/assets/../Cargo.toml", "/assets/%2e%2e/Cargo.toml"] {
        let request = Request::builder()
            .uri(path)
            .header("host", "localhost:8080")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert!(
            response.status() == StatusCode::NOT_FOUND
                || response.status() == StatusCode::BAD_REQUEST,
            "{path} must not resolve, got {}",
            response.status()
        );
    }
}

#[tokio::test]
async fn rate_limit_returns_429_with_retry_after() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    // The limiter allows 30 requests per minute per IP. Pin one address so the
    // loop deterministically exhausts exactly this bucket.
    let pinned: SocketAddr = "203.0.113.77:4444".parse().unwrap();
    let mut last_status = StatusCode::OK;
    let mut last_body = Value::Null;
    for index in 0..40 {
        let request = Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("host", "localhost:8080")
            .header("content-type", "application/json")
            .header("x-requested-with", "ai-search-platform")
            .body(Body::from(
                serde_json::json!({"query": format!("limited {index}")}).to_string(),
            ))
            .unwrap();
        let mut request = request;
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(pinned));
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        last_status = status;
        last_body = body;
        if status == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }
    assert_eq!(last_status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(last_body["error"]["code"], "rate_limited");
    assert!(last_body["error"]["retry_after_seconds"].as_u64().unwrap() >= 1);
}

/// A client behind a same-host reverse proxy must not be able to reset its rate
/// limit bucket by prepending a forged `X-Forwarded-For` value: only the entry
/// appended by the trusted proxy (the rightmost one) may count.
#[tokio::test]
async fn spoofed_xff_cannot_bypass_rate_limit() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let loopback: SocketAddr = "127.0.0.1:45678".parse().unwrap();
    let send_from_proxy = |index: u32, forwarded: &str| {
        let request = Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("host", "localhost:8080")
            .header("content-type", "application/json")
            .header("x-requested-with", "ai-search-platform")
            .header("x-forwarded-for", forwarded)
            .body(Body::from(
                serde_json::json!({ "query": format!("xff bypass {index}") }).to_string(),
            ))
            .unwrap();
        let mut request = request;
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(loopback));
        request
    };

    let mut limited = false;
    for index in 0..40u32 {
        // The left-most value changes on every request; the right-most one (as
        // appended by the proxy) stays constant.
        let forwarded = format!("1.1.1.{}, 203.0.113.200", index % 250);
        let response = app
            .clone()
            .oneshot(send_from_proxy(index, &forwarded))
            .await
            .unwrap();
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(
        limited,
        "forged left-most X-Forwarded-For entries must not reset the limiter"
    );

    // A different trusted peer observed by the proxy gets its own bucket.
    let response = app
        .clone()
        .oneshot(send_from_proxy(99, "1.1.1.1, 203.0.113.201"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

/// When the direct peer is *not* loopback there is no trusted same-host proxy,
/// so `X-Forwarded-For` must be ignored entirely: rotating forged values must
/// not create fresh buckets and the peer address alone keys the limiter.
#[tokio::test]
async fn xff_from_non_loopback_peer_is_ignored() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let peer: SocketAddr = "198.51.100.123:5555".parse().unwrap();
    let mut limited_at = None;
    for index in 0..40u32 {
        let request = Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("host", "localhost:8080")
            .header("content-type", "application/json")
            .header("x-requested-with", "ai-search-platform")
            // Every request claims to come from a different client address.
            .header("x-forwarded-for", format!("10.0.0.{}", index % 250))
            .body(Body::from(
                serde_json::json!({ "query": format!("non loopback xff {index}") }).to_string(),
            ))
            .unwrap();
        let mut request = request;
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(peer));
        let response = app.clone().oneshot(request).await.unwrap();
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            limited_at = Some(index);
            break;
        }
    }
    assert_eq!(
        limited_at,
        Some(30),
        "X-Forwarded-For from a non-loopback peer must never reset the limiter"
    );
}

/// On a public bind, an explicit `ALLOWED_HOSTS` allowlist blocks DNS-rebinding
/// style requests while loopback health checks keep working.
#[tokio::test]
async fn allowed_hosts_guard_public_bind() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let bind: SocketAddr = "0.0.0.0:8080".parse().unwrap();
    let config = Config::new(
        Some("test-key".into()),
        ai_search_platform::config::parse_base_url(&upstream).unwrap(),
        bind,
        dir.path().to_path_buf(),
    )
    .with_allowed_hosts(["search.example.com".to_owned()]);
    let cache = Arc::new(Cache::new(config.cache_dir()).unwrap());
    let client = UpstreamClient::new(&config).unwrap();
    let app = ai_search_platform::build_app(AppState::new(config, client, cache));

    let health = |host: &str| {
        Request::builder()
            .uri("/api/health")
            .header("host", host)
            .body(Body::empty())
            .unwrap()
    };

    let (status, body) = send(&app, health("search.example.com")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");

    // Same-machine probes (container healthchecks, reverse proxies) still work.
    let (status, _) = send(&app, health("127.0.0.1:8080")).await;
    assert_eq!(status, StatusCode::OK);

    // A domain that only *resolves* to this server is rejected.
    let (status, body) = send(&app, health("attacker.example")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "forbidden");
}

/// `/api` (without a trailing path) has no handler but must still answer as JSON.
#[tokio::test]
async fn api_root_returns_json_404() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .uri("/api")
        .header("host", "localhost:8080")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

/// Error responses (including 404s) must carry the security headers and must
/// never be stored by intermediaries.
#[tokio::test]
async fn api_errors_carry_security_headers_and_no_store() {
    let (upstream, _mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .uri("/api/nope")
        .header("host", "localhost:8080")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let headers = response.headers();
    assert!(headers.get("content-security-policy").is_some());
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
}

/// The 16 KiB request body cap must reject oversized bodies before any parsing
/// or upstream work happens.
#[tokio::test]
async fn oversized_request_body_is_rejected() {
    let (upstream, mock) = start_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _cache) = start_app(&upstream, dir.path().to_path_buf()).await;

    let request = Request::builder()
        .method("POST")
        .uri("/api/search")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("x-requested-with", "ai-search-platform")
        .body(Body::from(
            serde_json::json!({ "query": "x".repeat(32 * 1024) }).to_string(),
        ))
        .unwrap();
    let (status, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"]["code"], "payload_too_large");
    assert!(mock.search_calls.lock().unwrap().is_empty());
}
