//! Request validation: query/URL/parameter bounds and SSRF guardrails.

use std::net::IpAddr;

use url::Url;

use crate::config;
use crate::error::AppError;
use crate::types::FetchParams;
use crate::types::SearchParams;
use crate::types::SearchRequest;

/// Count Unicode scalar values, not bytes.
pub fn char_len(value: &str) -> usize {
    value.chars().count()
}

/// Validate and normalise a search request.
pub fn validate_search(request: SearchRequest) -> Result<(SearchParams, bool), AppError> {
    let query = request.query.trim().to_owned();
    if query.is_empty() {
        return Err(AppError::invalid("query 不能为空或全为空白字符"));
    }
    let query_chars = char_len(&query);
    if query_chars > config::QUERY_MAX_CHARS {
        return Err(AppError::invalid(format!(
            "query 长度 {query_chars} 超过上限 {} 个字符",
            config::QUERY_MAX_CHARS
        )));
    }

    let count = request.count.unwrap_or(config::DEFAULT_COUNT);
    if !(config::COUNT_MIN..=config::COUNT_MAX).contains(&count) {
        return Err(AppError::invalid(format!(
            "count 必须在 {} 到 {} 之间",
            config::COUNT_MIN,
            config::COUNT_MAX
        )));
    }

    let ori_question = normalise_optional(request.ori_question);
    if let Some(text) = &ori_question {
        let chars = char_len(text);
        if chars == 0 {
            return Err(AppError::invalid("ori_question 不能为空字符串"));
        }
        if chars > config::ORI_QUESTION_MAX_CHARS {
            return Err(AppError::invalid(format!(
                "ori_question 长度 {chars} 超过上限 {} 个字符",
                config::ORI_QUESTION_MAX_CHARS
            )));
        }
    }

    let localization = normalise_optional(request.localization);
    if let Some(value) = &localization
        && value.parse::<IpAddr>().is_err()
    {
        return Err(AppError::invalid(
            "localization 必须是合法的 IPv4 或 IPv6 地址",
        ));
    }

    let params = SearchParams {
        query,
        count,
        ori_question,
        localization,
        need_content: request.need_content.unwrap_or(config::DEFAULT_NEED_CONTENT),
    };

    Ok((params, request.force_refresh))
}

/// Trim an optional string, mapping blank strings to `None`.
fn normalise_optional(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Validate a fetch URL and normalise it for cache identity and upstream use.
pub fn validate_fetch(
    request: crate::types::FetchRequest,
) -> Result<(FetchParams, bool), AppError> {
    let raw = request.url.trim();
    if raw.is_empty() {
        return Err(AppError::invalid("url 不能为空"));
    }
    if char_len(raw) > config::FETCH_URL_MAX_CHARS {
        return Err(AppError::invalid(format!(
            "url 长度超过上限 {} 个字符",
            config::FETCH_URL_MAX_CHARS
        )));
    }

    let url = Url::parse(raw).map_err(|_| AppError::invalid("url 不是合法的绝对 URL"))?;

    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(AppError::invalid("url 仅支持 http/https 协议")),
    }

    if url.host().is_none() {
        return Err(AppError::invalid("url 必须包含 host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::invalid("url 不允许携带用户名或密码"));
    }

    // Normalisation (IDN punycode, percent-encoding) can make the URL longer
    // than the raw input, so re-check the length the upstream will actually see.
    let normalized = url.to_string();
    if char_len(&normalized) > config::FETCH_URL_MAX_CHARS {
        return Err(AppError::invalid(format!(
            "url 规范化后长度超过上限 {} 个字符",
            config::FETCH_URL_MAX_CHARS
        )));
    }

    // Defence in depth: the fetch is executed by the upstream service, but a
    // local request for internal targets should never even leave this process.
    if is_blocked_target(&url) {
        return Err(AppError::forbidden(
            "拒绝访问内网、回环或本地保留地址（SSRF 防护）",
        ));
    }

    Ok((FetchParams { url: normalized }, request.force_refresh))
}

/// Block loopback/private/link-local/CGNAT/ULA addresses and internal names.
pub fn is_blocked_target(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => is_blocked_domain(domain),
        Some(url::Host::Ipv4(ip)) => is_blocked_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => is_blocked_ipv6(ip),
        None => true,
    }
}

fn is_blocked_domain(domain: &str) -> bool {
    let lower = domain.trim_end_matches('.').to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }
    // Single-label names (`intranet`, `metadata`, `router`) can only resolve
    // through a local search domain or internal DNS; no public host uses them.
    if !lower.contains('.') {
        return true;
    }
    // `.local` (mDNS), `.internal` (cloud metadata), `.home.arpa` (RFC 8375),
    // `.arpa` (reverse/infra), RFC 2606 reserved names and common split-DNS
    // suffixes used by home/office networks.
    const BLOCKED_SUFFIXES: [&str; 12] = [
        ".local",
        ".localdomain",
        ".internal",
        ".home.arpa",
        ".arpa",
        ".lan",
        ".corp",
        ".home",
        ".intranet",
        ".test",
        ".invalid",
        ".example",
    ];
    if BLOCKED_SUFFIXES
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        return true;
    }
    // Alternate GCP metadata hostname.
    lower == "metadata.goog"
}

fn is_blocked_ipv4(v4: std::net::Ipv4Addr) -> bool {
    let octets = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        // CGNAT 100.64.0.0/10 (also covers Alibaba Cloud's 100.100.100.200)
        || (octets[0] == 100 && (64..128).contains(&octets[1]))
        // 0.0.0.0/8
        || octets[0] == 0
        // 192.0.0.0/24 IETF protocol assignments
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        // 198.18.0.0/15 benchmarking
        || (octets[0] == 198 && (octets[1] & 0xfe) == 18)
        // 240.0.0.0/4 reserved (includes 255.255.255.255)
        || octets[0] >= 240
        // 192.88.99.0/24 6to4 relay anycast (deprecated)
        || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
}

fn is_blocked_ipv6(v6: std::net::Ipv6Addr) -> bool {
    if let Some(embedded) = embedded_ipv4(v6) {
        return is_blocked_ipv4(embedded);
    }
    let segments = v6.segments();
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        // Unique local fc00::/7
        || (segments[0] & 0xfe00) == 0xfc00
        // Link local fe80::/10
        || (segments[0] & 0xffc0) == 0xfe80
        // Deprecated site local fec0::/10
        || (segments[0] & 0xffc0) == 0xfec0
        // 6to4 2002::/16 embeds an IPv4 address (deprecated, RFC 7526)
        || segments[0] == 0x2002
        // Teredo 2001:0000::/32 embeds an IPv4 address
        || (segments[0] == 0x2001 && segments[1] == 0x0000)
        // NAT64 64:ff9b::/96 (well known) and 64:ff9b:1::/48 (local use)
        || (segments[0] == 0x0064 && segments[1] == 0xff9b)
        // Discard-only 100::/64
        || (segments[0] == 0x0100 && segments[1..4].iter().all(|segment| *segment == 0))
}

/// Extract the IPv4 address carried by an IPv4-in-IPv6 literal, if any.
fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    use std::net::Ipv4Addr;

    if let Some(mapped) = v6.to_ipv4_mapped() {
        return Some(mapped);
    }
    let segments = v6.segments();
    let low = || {
        Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        )
    };
    if segments[..4].iter().all(|segment| *segment == 0) {
        // IPv4-translated `::ffff:0:0/96` (RFC 2765).
        if segments[4] == 0xffff {
            return Some(low());
        }
        // IPv4-compatible `::a.b.c.d` (deprecated but still mapped by some stacks).
        if segments[..6].iter().all(|segment| *segment == 0)
            && !v6.is_unspecified()
            && !v6.is_loopback()
        {
            return Some(low());
        }
    }
    // NAT64 well-known prefix keeps the IPv4 destination in the low 32 bits.
    if segments[0] == 0x0064 && segments[1] == 0xff9b {
        return Some(low());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FetchRequest;

    fn search(query: &str) -> Result<(SearchParams, bool), AppError> {
        validate_search(SearchRequest {
            query: query.to_owned(),
            count: None,
            ori_question: None,
            localization: None,
            need_content: None,
            force_refresh: false,
        })
    }

    fn fetch(url: &str) -> Result<(FetchParams, bool), AppError> {
        validate_fetch(FetchRequest {
            url: url.to_owned(),
            force_refresh: false,
        })
    }

    #[test]
    fn need_content_defaults_to_true() {
        let (params, _) = search("rust").expect("valid");
        assert!(params.need_content);
        assert_eq!(params.count, config::DEFAULT_COUNT);
    }

    #[test]
    fn query_is_trimmed_and_bounded() {
        let (params, _) = search("  rust lang:zh  ").expect("valid");
        assert_eq!(params.query, "rust lang:zh");

        assert!(search("   ").is_err());
        assert!(search("").is_err());
        assert!(search(&"字".repeat(129)).is_err());
        assert!(search(&"字".repeat(128)).is_ok());
    }

    #[test]
    fn count_bounds_are_enforced() {
        let make = |count: Option<u32>| {
            validate_search(SearchRequest {
                query: "x".into(),
                count,
                ori_question: None,
                localization: None,
                need_content: None,
                force_refresh: false,
            })
        };
        assert!(make(Some(0)).is_err());
        assert!(make(Some(51)).is_err());
        assert!(make(Some(1)).is_ok());
        assert!(make(Some(50)).is_ok());
    }

    #[test]
    fn optional_fields_are_trimmed_and_validated() {
        let ok = validate_search(SearchRequest {
            query: "x".into(),
            count: Some(5),
            ori_question: Some("  原始问题  ".into()),
            localization: Some(" 1.2.3.4 ".into()),
            need_content: Some(false),
            force_refresh: true,
        })
        .expect("valid");
        assert_eq!(ok.0.ori_question.as_deref(), Some("原始问题"));
        assert_eq!(ok.0.localization.as_deref(), Some("1.2.3.4"));
        assert!(!ok.0.need_content);
        assert!(ok.1);

        let blank = validate_search(SearchRequest {
            query: "x".into(),
            count: None,
            ori_question: Some("   ".into()),
            localization: Some("".into()),
            need_content: None,
            force_refresh: false,
        })
        .expect("valid");
        assert_eq!(blank.0.ori_question, None);
        assert_eq!(blank.0.localization, None);

        assert!(
            validate_search(SearchRequest {
                query: "x".into(),
                count: None,
                ori_question: None,
                localization: Some("not-an-ip".into()),
                need_content: None,
                force_refresh: false,
            })
            .is_err()
        );
    }

    #[test]
    fn fetch_accepts_public_https_urls() {
        let (params, _) = fetch("https://example.com/article").expect("valid");
        assert_eq!(params.url, "https://example.com/article");
    }

    #[test]
    fn fetch_rejects_internal_targets() {
        for url in [
            "http://127.0.0.1/admin",
            "http://localhost/admin",
            "http://[::1]/admin",
            "http://10.0.0.1/",
            "http://192.168.1.1/",
            "http://172.16.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://100.100.100.200/",
            "http://0.0.0.0/",
            "http://198.18.0.1/",
            "http://192.88.99.1/",
            "http://240.0.0.1/",
            "http://printer.local/",
            "http://metadata.google.internal/",
            "http://metadata.goog/",
            "http://router.home.arpa/",
            "http://foo.localdomain/",
            "http://router.lan/",
            "http://intranet/",
            "http://metadata/",
            "http://server.test/",
            // Alternative numeric IPv4 spellings are normalised by the URL parser.
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://127.1/",
            // IPv4-embedded IPv6 forms must not slip through.
            "http://[::ffff:127.0.0.1]/",
            "http://[::127.0.0.1]/",
            "http://[::ffff:0:127.0.0.1]/",
            "http://[2002:7f00:1::]/",
            "http://[2001::7f00:1]/",
            "http://[64:ff9b::7f00:1]/",
            "http://[fec0::1]/",
            "http://[100::1]/",
        ] {
            let err = fetch(url).expect_err("must be blocked");
            assert!(
                err.code == crate::error::ErrorCode::Forbidden,
                "{url} should be forbidden, got {:?}",
                err.code
            );
        }
    }

    #[test]
    fn fetch_accepts_public_targets() {
        for url in [
            "https://example.com/article",
            "https://8.8.8.8/",
            "https://1.1.1.1/",
            "https://[2606:4700:4700::1111]/",
        ] {
            assert!(fetch(url).is_ok(), "{url} should be allowed");
            assert!(!is_blocked_target(&Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn fetch_rejects_bad_schemes_and_shapes() {
        assert!(fetch("ftp://example.com/x").is_err());
        assert!(fetch("file:///etc/passwd").is_err());
        assert!(fetch("javascript:alert(1)").is_err());
        assert!(fetch("https://user:pass@example.com/").is_err());
        assert!(fetch("not a url").is_err());
        assert!(fetch(&format!("https://example.com/{}", "a".repeat(9000))).is_err());
        // Percent-encoding expansion after normalisation must be re-checked too.
        assert!(fetch(&format!("https://example.com/{}", "字".repeat(1000))).is_err());
    }

    #[test]
    fn ipv4_mapped_and_embedded_ipv6_is_blocked() {
        assert!(is_blocked_target(
            &Url::parse("http://[::ffff:127.0.0.1]/").unwrap()
        ));
        assert!(is_blocked_target(
            &Url::parse("http://[::ffff:7f00:1]/").unwrap()
        ));
        assert!(is_blocked_target(&Url::parse("http://[::a00:1]/").unwrap()));
        assert!(!is_blocked_target(&Url::parse("https://8.8.8.8/").unwrap()));
        assert!(!is_blocked_target(
            &Url::parse("https://example.com/").unwrap()
        ));
    }
}
