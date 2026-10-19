//! On-disk response cache.
//!
//! Design notes
//! ------------
//! * Entry names are the lowercase hex SHA-256 of a canonical JSON document
//!   that includes the upstream identity, the response kind and every request
//!   field that can change the payload. The query string is folded in as
//!   Base64URL (`query_b64`), so the human readable keyword never touches the
//!   filesystem.
//! * Only 64 character hex names are ever opened: nothing derived from user
//!   input is concatenated into a path, which rules out traversal.
//! * Writes are atomic (temp file + rename) and, on Unix, files are created
//!   0600 inside 0700 directories.
//! * Expiry is recomputed on read from the current TTL, so a TTL change takes
//!   effect immediately.
//! * All failures degrade to a cache miss: a broken cache never breaks a
//!   response.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::config;
use crate::types::FetchParams;
use crate::types::SearchParams;

/// Cache namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Search,
    Fetch,
}

impl Kind {
    pub fn dir(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Fetch => "fetch",
        }
    }

    pub fn is_enabled(self) -> bool {
        match self {
            Self::Search => config::SEARCH_CACHE_ENABLED,
            Self::Fetch => config::FETCH_CACHE_ENABLED,
        }
    }
}

/// Persisted envelope.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    v: u32,
    kind: Kind,
    created_at: u64,
    upstream_status: u16,
    data: Value,
}

/// Borrowed variant used to serialise without cloning the payload.
#[derive(Serialize)]
struct EnvelopeRef<'a> {
    v: u32,
    kind: Kind,
    created_at: u64,
    upstream_status: u16,
    data: &'a Value,
}

/// A successfully loaded cache entry.
pub struct Cached {
    pub stored_at: u64,
    pub upstream_status: u16,
    pub data: Value,
}

/// Cache handle shared through application state.
pub struct Cache {
    root: PathBuf,
    enabled: bool,
    /// Approximate number of bytes currently stored; corrected by every sweep.
    bytes_used: AtomicU64,
}

pub type SharedCache = Arc<Cache>;

/// Envelope schema version; bump to invalidate every entry.
const ENVELOPE_VERSION: u32 = 1;

/// Per-process sequence for unique temporary file names.
static TMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Wall-clock second of the last logged cache-write failure.
///
/// A full or read-only cache volume makes *every* request fail the same write;
/// logging each one turns a disk problem into log amplification (which can, in
/// turn, keep the disk full). One warning per minute is enough for operators.
static LAST_WRITE_FAILURE_WARN: AtomicU64 = AtomicU64::new(0);
const WRITE_FAILURE_WARN_INTERVAL_SECONDS: u64 = 60;

impl Cache {
    /// Create the cache layout, failing fast when the directory is unusable.
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join(Kind::Search.dir()))?;
        fs::create_dir_all(root.join(Kind::Fetch.dir()))?;
        restrict_dir(&root);
        restrict_dir(&root.join(Kind::Search.dir()));
        restrict_dir(&root.join(Kind::Fetch.dir()));
        Ok(Self {
            root,
            enabled: true,
            bytes_used: AtomicU64::new(0),
        })
    }

    /// A disabled cache: every lookup misses and every store is a no-op.
    pub fn disabled() -> Self {
        Self {
            root: PathBuf::new(),
            enabled: false,
            bytes_used: AtomicU64::new(0),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Cache key for a search, based on the Base64URL form of the keyword plus
    /// every parameter that changes the upstream payload.
    pub fn search_key(&self, upstream: &str, params: &SearchParams) -> String {
        let query_b64 = URL_SAFE_NO_PAD.encode(params.query.as_bytes());
        hash_key(&serde_json::json!({
            "v": ENVELOPE_VERSION,
            "kind": "search",
            "base_url": upstream,
            "query_b64": query_b64,
            "count": params.count,
            "need_content": params.need_content,
            "ori_question": params.ori_question,
            "localization": params.localization,
        }))
    }

    /// Cache key for a fetch, based on the normalised URL.
    pub fn fetch_key(&self, upstream: &str, params: &FetchParams) -> String {
        hash_key(&serde_json::json!({
            "v": ENVELOPE_VERSION,
            "kind": "fetch",
            "base_url": upstream,
            "url": params.url,
        }))
    }

    /// Path of one entry.
    ///
    /// Only 64 character hex keys are valid; `get`/`put` reject everything else
    /// before touching the filesystem, so no user-controlled string can ever be
    /// concatenated into a path.
    pub fn entry_path(&self, kind: Kind, key: &str) -> PathBuf {
        debug_assert!(is_hex_key(key), "cache keys must be hex digests");
        self.root.join(kind.dir()).join(format!("{key}.json"))
    }

    /// Read a fresh entry. Returns `None` on miss, expiry or corruption.
    pub fn get(&self, kind: Kind, key: &str) -> Option<Cached> {
        if !self.enabled || !is_hex_key(key) {
            return None;
        }
        let path = self.entry_path(kind, key);
        let meta = match fs::metadata(&path) {
            Ok(meta) => meta,
            Err(err) => {
                if err.kind() != ErrorKind::NotFound {
                    tracing::debug!(error = %err, path = %path.display(), "cache read failed, treating as miss");
                }
                return None;
            }
        };
        // Never read an oversized file into memory.
        if meta.len() > config::CACHE_MAX_ENTRY_BYTES {
            tracing::debug!(path = %path.display(), "oversized cache entry removed");
            self.discard(&path, meta.len());
            return None;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                if err.kind() != ErrorKind::NotFound {
                    tracing::debug!(error = %err, path = %path.display(), "cache read failed, treating as miss");
                }
                return None;
            }
        };

        let envelope: Envelope = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(err) => {
                tracing::debug!(error = %err, path = %path.display(), "corrupt cache entry removed");
                self.discard(&path, bytes.len() as u64);
                return None;
            }
        };

        if envelope.v != ENVELOPE_VERSION || envelope.kind != kind {
            tracing::debug!(path = %path.display(), "stale cache schema removed");
            self.discard(&path, bytes.len() as u64);
            return None;
        }

        let now = unix_now();
        if is_expired(envelope.created_at, now, config::CACHE_TTL_SECONDS) {
            tracing::debug!(path = %path.display(), "expired cache entry removed");
            self.discard(&path, bytes.len() as u64);
            return None;
        }

        Some(Cached {
            stored_at: envelope.created_at,
            upstream_status: envelope.upstream_status,
            data: envelope.data,
        })
    }

    /// Remove one entry and keep the in-memory byte accounting in sync.
    fn discard(&self, path: &Path, bytes: u64) {
        let _ = fs::remove_file(path);
        self.release_bytes(bytes);
    }

    /// Atomically reserve `incoming` bytes against the directory budget.
    ///
    /// A plain load-then-compare races: concurrent writers all observe the same
    /// "used" value and all pass, so a burst can overshoot `CACHE_MAX_BYTES` by
    /// roughly `concurrency * CACHE_MAX_ENTRY_BYTES`. `fetch_update` makes the
    /// check-and-add one atomic step.
    fn reserve_bytes(&self, incoming: u64) -> bool {
        self.bytes_used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                let next = current.saturating_add(incoming);
                (next <= config::CACHE_MAX_BYTES).then_some(next)
            })
            .is_ok()
    }

    /// Give reserved (or now-deleted) bytes back to the budget.
    fn release_bytes(&self, amount: u64) {
        let _ = self
            .bytes_used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                Some(current.saturating_sub(amount))
            });
    }

    /// Log a cache-write failure, at most once per
    /// [`WRITE_FAILURE_WARN_INTERVAL_SECONDS`].
    fn warn_write_failure(&self, err: &std::io::Error) {
        if should_warn_write_failure(unix_now()) {
            tracing::warn!(
                error = %err,
                "failed to write cache entry (同类失败将在 60 秒内静默)"
            );
        }
    }

    /// Store a payload. Oversized payloads and I/O failures are logged and
    /// skipped; they never affect the response.
    pub fn put(&self, kind: Kind, key: &str, upstream_status: u16, data: &Value) {
        if !self.enabled || !is_hex_key(key) {
            return;
        }
        // Serialise through a borrowed envelope: cloning a multi-megabyte
        // upstream payload before the size check would double peak memory.
        let envelope = EnvelopeRef {
            v: ENVELOPE_VERSION,
            kind,
            created_at: unix_now(),
            upstream_status,
            data,
        };

        let bytes = match serde_json::to_vec(&envelope) {
            Ok(bytes) => bytes,
            Err(err) => {
                tracing::warn!(error = %err, "failed to serialize cache entry");
                return;
            }
        };

        if bytes.len() as u64 > config::CACHE_MAX_ENTRY_BYTES {
            tracing::debug!(
                size = bytes.len(),
                limit = config::CACHE_MAX_ENTRY_BYTES,
                "cache entry exceeds size limit, skipping store"
            );
            return;
        }

        // Enforce the directory budget between sweeps as well, otherwise a burst
        // of unique large responses can fill the disk for up to a full sweep
        // interval. Reserving first keeps concurrent writers from over-committing.
        let incoming = bytes.len() as u64;
        if !self.reserve_bytes(incoming) {
            tracing::debug!(
                incoming,
                limit = config::CACHE_MAX_BYTES,
                "cache budget exhausted, skipping store"
            );
            return;
        }

        // Overwriting a key must not double-count its old size.
        let previous = fs::metadata(self.entry_path(kind, key))
            .map(|meta| meta.len())
            .unwrap_or(0);

        if let Err(err) = self.write_atomic(kind, key, &bytes) {
            self.release_bytes(incoming);
            self.warn_write_failure(&err);
            return;
        }
        if previous > 0 {
            self.release_bytes(previous);
        }
    }

    fn write_atomic(&self, kind: Kind, key: &str, bytes: &[u8]) -> std::io::Result<()> {
        let dir = self.root.join(kind.dir());
        let final_path = dir.join(format!("{key}.json"));
        // Unique temp name: concurrent writers of the same key must not truncate
        // each other's temp file, and a pre-planted file must never be reused.
        let sequence = TMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let tmp_path = dir.join(format!(".{key}.{}.{sequence}.tmp", std::process::id()));

        write_private(&tmp_path, bytes)?;
        match fs::rename(&tmp_path, &final_path) {
            Ok(()) => Ok(()),
            Err(err) => {
                let _ = fs::remove_file(&tmp_path);
                Err(err)
            }
        }
    }

    /// Remove expired, corrupt and oversized entries, stale temp files, and
    /// trim the directory down to the configured entry/size budget.
    pub fn sweep(&self) -> SweepReport {
        let mut report = SweepReport::default();
        if !self.enabled {
            return report;
        }

        let now = unix_now();
        let mut live: Vec<(u64, u64, PathBuf)> = Vec::new();
        let mut total_bytes: u64 = 0;

        for kind in [Kind::Search, Kind::Fetch] {
            let dir = self.root.join(kind.dir());
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(err) => {
                    tracing::warn!(error = %err, path = %dir.display(), "cannot read cache dir");
                    continue;
                }
            };

            for entry in entries.flatten() {
                let path = entry.path();
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_owned(),
                    None => continue,
                };

                if name.ends_with(".tmp") {
                    if let Ok(meta) = entry.metadata() {
                        let age = now.saturating_sub(modified_at(&meta));
                        if age >= config::CACHE_STALE_TMP_SECONDS {
                            let _ = fs::remove_file(&path);
                            report.temp_removed += 1;
                        }
                    }
                    continue;
                }

                let key = match name.strip_suffix(".json") {
                    Some(key) if is_hex_key(key) => key.to_owned(),
                    _ => {
                        let _ = fs::remove_file(&path);
                        report.removed += 1;
                        continue;
                    }
                };

                let meta = match entry.metadata() {
                    Ok(meta) => meta,
                    Err(_) => continue,
                };
                let size = meta.len();

                if size > config::CACHE_MAX_ENTRY_BYTES {
                    let _ = fs::remove_file(&path);
                    report.removed += 1;
                    continue;
                }

                if !self.entry_is_fresh(&path, kind, &key, now) {
                    let _ = fs::remove_file(&path);
                    report.removed += 1;
                    continue;
                }

                total_bytes = total_bytes.saturating_add(size);
                live.push((modified_at(&meta), size, path));
            }
        }

        // Trim by age when over budget.
        let mut final_bytes = total_bytes;
        if live.len() > config::CACHE_MAX_ENTRIES || total_bytes > config::CACHE_MAX_BYTES {
            live.sort_by_key(|(mtime, _, _)| *mtime);
            let mut count = live.len();
            let mut bytes = total_bytes;
            for (_, size, path) in &live {
                if count <= config::CACHE_MAX_ENTRIES && bytes <= config::CACHE_MAX_BYTES {
                    break;
                }
                if fs::remove_file(path).is_ok() {
                    count = count.saturating_sub(1);
                    bytes = bytes.saturating_sub(*size);
                    report.removed += 1;
                }
            }
            final_bytes = bytes;
        }
        // The sweep does a full rescan, so it is also where the approximate
        // byte counter is corrected.
        self.bytes_used.store(final_bytes, Ordering::Relaxed);

        report
    }

    fn entry_is_fresh(&self, path: &Path, kind: Kind, _key: &str, now: u64) -> bool {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => return false,
        };
        match serde_json::from_slice::<Envelope>(&bytes) {
            Ok(envelope) => {
                envelope.v == ENVELOPE_VERSION
                    && envelope.kind == kind
                    && !is_expired(envelope.created_at, now, config::CACHE_TTL_SECONDS)
            }
            Err(_) => false,
        }
    }
}

/// Outcome of a cache sweep, used for logging and tests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepReport {
    pub removed: usize,
    pub temp_removed: usize,
}

/// Hash a canonical JSON document into a lowercase hex SHA-256 key.
fn hash_key(value: &Value) -> String {
    let canonical = canonical_json(value);
    let digest = Sha256::digest(canonical.as_bytes());
    hex::encode(digest)
}

/// Deterministic JSON serialisation with sorted object keys.
fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                // Keys are internal constants, but escape defensively anyway.
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                if let Some(inner) = map.get(*key) {
                    write_canonical(inner, out);
                }
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

/// True when a key is a 64 character lowercase hex string.
pub fn is_hex_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Clock-skew tolerance: a `created_at` slightly in the future is treated as
/// "just written" rather than corrupt, but a wildly future timestamp (or one
/// beyond the TTL) is discarded.
const CLOCK_SKEW_TOLERANCE_SECONDS: u64 = 300;

pub fn is_expired(created_at: u64, now: u64, ttl: u64) -> bool {
    if created_at > now {
        return created_at - now > CLOCK_SKEW_TOLERANCE_SECONDS;
    }
    now - created_at >= ttl
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Decide whether a cache-write failure should be logged at `now`.
///
/// Split out (and taking `now` as an argument) so the throttle can be tested
/// without sleeping.
fn should_warn_write_failure(now: u64) -> bool {
    let last = LAST_WRITE_FAILURE_WARN.load(Ordering::Relaxed);
    if now.saturating_sub(last) < WRITE_FAILURE_WARN_INTERVAL_SECONDS {
        return false;
    }
    LAST_WRITE_FAILURE_WARN
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
}

fn modified_at(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;

    // `create_new` refuses to follow a pre-existing symlink or truncate a file
    // planted at the temp path by another local user.
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SearchParams;

    fn params(query: &str) -> SearchParams {
        SearchParams {
            query: query.to_owned(),
            count: 10,
            ori_question: None,
            localization: None,
            need_content: true,
        }
    }

    #[test]
    fn keys_are_hex_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let key_a = cache.search_key("https://api.deepseek.com", &params("DeepSeek 模型"));
        let key_b = cache.search_key("https://api.deepseek.com", &params("DeepSeek 模型"));
        assert_eq!(key_a, key_b);
        assert!(is_hex_key(&key_a));
        assert_eq!(key_a.len(), 64);
    }

    #[test]
    fn keys_differ_per_field() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let base = cache.search_key("https://api.deepseek.com", &params("q"));

        assert_ne!(
            base,
            cache.search_key("https://other.example", &params("q"))
        );
        assert_ne!(
            base,
            cache.search_key("https://api.deepseek.com", &params("q2"))
        );

        let mut variant = params("q");
        variant.count = 20;
        assert_ne!(base, cache.search_key("https://api.deepseek.com", &variant));

        let mut variant = params("q");
        variant.need_content = false;
        assert_ne!(base, cache.search_key("https://api.deepseek.com", &variant));

        let mut variant = params("q");
        variant.localization = Some("1.2.3.4".into());
        assert_ne!(base, cache.search_key("https://api.deepseek.com", &variant));

        let mut variant = params("q");
        variant.ori_question = Some("原始问题".into());
        assert_ne!(base, cache.search_key("https://api.deepseek.com", &variant));
    }

    #[test]
    fn keys_do_not_contain_the_query() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let key = cache.search_key("https://api.deepseek.com", &params("secret-keyword"));
        assert!(!key.contains("secret"));
        assert!(!key.contains("keyword"));
    }

    #[test]
    fn roundtrip_and_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let key = cache.search_key("https://api.deepseek.com", &params("q"));
        let payload = serde_json::json!({"results": [{"title": "hi"}]});

        cache.put(Kind::Search, &key, 200, &payload);
        let hit = cache.get(Kind::Search, &key).expect("hit");
        assert_eq!(hit.upstream_status, 200);
        assert_eq!(hit.data, payload);

        // Fetching a search key in the fetch namespace must miss.
        assert!(cache.get(Kind::Fetch, &key).is_none());

        let _ = fs::remove_file(cache.entry_path(Kind::Search, &key));
        assert!(cache.get(Kind::Search, &key).is_none());
    }

    #[test]
    fn corrupted_entries_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let key = "a".repeat(64);
        let path = cache.entry_path(Kind::Search, &key);
        fs::write(&path, b"{not json").unwrap();
        assert!(cache.get(Kind::Search, &key).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn path_never_escapes_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let path = cache.entry_path(Kind::Search, &"b".repeat(64));
        assert!(path.starts_with(dir.path().join("search")));
    }

    #[test]
    fn expiry_helper() {
        assert!(!is_expired(1000, 1000, 10));
        assert!(!is_expired(1000, 1009, 10));
        assert!(is_expired(1000, 1010, 10));
        // A wildly future timestamp is treated as corrupt/expired.
        assert!(is_expired(2000, 1000, 10));
        // Small clock skew is tolerated.
        assert!(!is_expired(1010, 1000, 10));
        assert!(!is_expired(1300, 1000, 10));
    }

    #[test]
    fn hex_key_validation() {
        assert!(is_hex_key(&"0".repeat(64)));
        assert!(is_hex_key(&"abcdef0123456789".repeat(4)));
        assert!(!is_hex_key(&"A".repeat(64)));
        assert!(!is_hex_key("../escape"));
        assert!(!is_hex_key(&"a".repeat(63)));
    }

    #[test]
    fn sweep_removes_expired_and_bad_files() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();

        let key = cache.search_key("https://api.deepseek.com", &params("q"));
        cache.put(Kind::Search, &key, 200, &serde_json::json!({"results": []}));
        // Backdate the entry so it is expired.
        let path = cache.entry_path(Kind::Search, &key);
        let mut envelope: Envelope = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        envelope.created_at = 1;
        fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();

        // A stray file that is not a hex key must be removed.
        fs::write(dir.path().join("search").join("evil.txt"), b"x").unwrap();

        let report = cache.sweep();
        assert!(report.removed >= 2);
        assert!(!path.exists());
        assert!(!dir.path().join("search").join("evil.txt").exists());
    }

    #[test]
    fn oversized_entries_are_not_stored() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let key = cache.search_key("https://api.deepseek.com", &params("q"));
        let big = "x".repeat(config::CACHE_MAX_ENTRY_BYTES as usize + 16);
        cache.put(
            Kind::Search,
            &key,
            200,
            &serde_json::json!({ "content": big }),
        );
        assert!(cache.get(Kind::Search, &key).is_none());
    }

    #[test]
    fn non_hex_keys_never_touch_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let payload = serde_json::json!({"results": []});

        let bad_keys: Vec<String> = vec![
            "../../escape".to_owned(),
            "..".to_owned(),
            "a/../../b".to_owned(),
            "a".repeat(63),
            "A".repeat(64),
        ];
        for key in &bad_keys {
            cache.put(Kind::Search, key, 200, &payload);
            assert!(cache.get(Kind::Search, key).is_none(), "{key:?}");
        }

        // Only the two namespace directories exist: nothing escaped the root.
        let entries = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(entries, 2);
        assert_eq!(
            std::fs::read_dir(dir.path().join("search"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn byte_accounting_tracks_writes_and_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let key = cache.search_key("https://api.deepseek.com", &params("q"));
        assert_eq!(cache.bytes_used.load(Ordering::Relaxed), 0);

        cache.put(Kind::Search, &key, 200, &serde_json::json!({"results": []}));
        let written = cache.bytes_used.load(Ordering::Relaxed);
        assert!(written > 0);

        // The sweep rescans the directory and must converge on the real size.
        let report = cache.sweep();
        assert_eq!(report.removed, 0);
        let on_disk: u64 = std::fs::read_dir(dir.path().join("search"))
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        assert_eq!(cache.bytes_used.load(Ordering::Relaxed), on_disk);
    }

    #[test]
    fn byte_budget_reservation_never_overshoots() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path()).unwrap();
        let chunk: u64 = 8 * 1024 * 1024;
        let expected = config::CACHE_MAX_BYTES / chunk;

        // Eight threads race to reserve the whole budget in 8 MiB chunks. With a
        // non-atomic load-then-add check they would over-commit; `fetch_update`
        // must stop at exactly CACHE_MAX_BYTES / chunk reservations.
        let reserved: u64 = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        let mut mine = 0u64;
                        while cache.reserve_bytes(chunk) {
                            mine += 1;
                        }
                        mine
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("reservation thread"))
                .sum()
        });
        assert_eq!(reserved, expected);
        assert_eq!(cache.bytes_used.load(Ordering::Relaxed), expected * chunk);
        assert!(cache.bytes_used.load(Ordering::Relaxed) <= config::CACHE_MAX_BYTES);

        // Releasing one chunk makes exactly one more reservation possible.
        cache.release_bytes(chunk);
        assert!(cache.reserve_bytes(chunk));
        assert!(!cache.reserve_bytes(1));
    }

    #[test]
    fn write_failure_warnings_are_throttled() {
        // Uses the process-global throttle; pick a far-future base so no other
        // test can have primed it within the interval.
        let base: u64 = 10_000_000_000;
        assert!(should_warn_write_failure(base));
        assert!(!should_warn_write_failure(base + 1));
        assert!(!should_warn_write_failure(
            base + WRITE_FAILURE_WARN_INTERVAL_SECONDS - 1
        ));
        assert!(should_warn_write_failure(
            base + WRITE_FAILURE_WARN_INTERVAL_SECONDS
        ));
        assert!(!should_warn_write_failure(
            base + WRITE_FAILURE_WARN_INTERVAL_SECONDS
        ));
    }
}
