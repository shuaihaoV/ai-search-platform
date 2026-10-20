//! Optional access-password authentication.
//!
//! The platform can be protected by a single shared password. The password is
//! configured through `PLATFORM_PASSWD` as an **Argon2id hash** (never the
//! plaintext), so a leaked environment dump does not reveal the password.
//!
//! Design notes:
//! - Successful login returns a *stateless* bearer token: `v1.<expiry>.<sig>`
//!   where `sig = HMAC-SHA256(token_key, "v1.<expiry>")`. The key is derived
//!   from the configured hash, so rotating the password invalidates every
//!   previously issued token.
//! - No cookies are used (the rest of the app is cookie-free by design), so
//!   CSRF exposure is unchanged.
//! - When `PLATFORM_PASSWD` is unset the whole feature is inert and every
//!   request behaves exactly as before.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest as _, Sha256};

use crate::config;

/// Token format version prefix.
const TOKEN_PREFIX: &str = "v1";
/// Domain separation label mixed into the token signing key.
const TOKEN_KEY_LABEL: &[u8] = b"ai-search-platform-token-v1";

/// Argon2id PHC string, e.g. `$argon2id$v=19$m=19456,t=2,p=1$...`.
pub type PasswordHash = String;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("PLATFORM_PASSWD 不是合法的 Argon2id 哈希")]
    InvalidHash,
    #[error("密码哈希计算失败")]
    HashFailure,
}

/// Hash a plaintext password into an Argon2id PHC string.
///
/// Used by the `hash-password` subcommand; not used at request time.
pub fn hash_password(password: &str) -> Result<PasswordHash, AuthError> {
    use argon2::Argon2;
    use argon2::PasswordHasher;

    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| AuthError::HashFailure)
}

/// Validate that a configured value is a usable Argon2id hash.
///
/// Called at startup: a malformed hash must fail fast instead of silently
/// disabling the password gate (that would be a security downgrade).
pub fn validate_password_hash(raw: &str) -> Result<(), AuthError> {
    let parsed =
        argon2::password_hash::phc::PasswordHash::new(raw).map_err(|_| AuthError::InvalidHash)?;
    if parsed.algorithm.as_str() != "argon2id" {
        return Err(AuthError::InvalidHash);
    }
    Ok(())
}

/// Constant-time comparison of two byte slices.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Verify a plaintext password against the configured Argon2id hash.
pub fn verify_password(hash: &str, password: &str) -> bool {
    use argon2::Argon2;
    use argon2::PasswordVerifier;
    use argon2::password_hash::phc::PasswordHash;

    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Issues and verifies stateless bearer tokens.
#[derive(Clone)]
pub struct TokenIssuer {
    key: [u8; 32],
}

impl std::fmt::Debug for TokenIssuer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never expose the signing key.
        f.debug_struct("TokenIssuer").finish_non_exhaustive()
    }
}

impl TokenIssuer {
    /// Derive the signing key from the configured password hash.
    ///
    /// Because the key depends on the hash, changing `PLATFORM_PASSWD` makes
    /// all outstanding tokens stop verifying.
    pub fn new(password_hash: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(TOKEN_KEY_LABEL);
        hasher.update(password_hash.as_bytes());
        let digest = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        Self { key }
    }

    fn sign(&self, payload: &str) -> [u8; 32] {
        // Plain HMAC-SHA256 (RFC 2104) built on sha2 to avoid pulling a second
        // digest stack. Only two short inputs are involved.
        const BLOCK: usize = 64;
        let mut key_block = [0u8; BLOCK];
        if self.key.len() > BLOCK {
            let mut hasher = Sha256::new();
            hasher.update(self.key);
            let hashed = hasher.finalize();
            key_block[..hashed.len()].copy_from_slice(&hashed);
        } else {
            key_block[..self.key.len()].copy_from_slice(&self.key);
        }

        let mut ipad = [0x36u8; BLOCK];
        let mut opad = [0x5cu8; BLOCK];
        for i in 0..BLOCK {
            ipad[i] ^= key_block[i];
            opad[i] ^= key_block[i];
        }

        let mut inner = Sha256::new();
        inner.update(ipad);
        inner.update(payload.as_bytes());
        let inner_digest = inner.finalize();

        let mut outer = Sha256::new();
        outer.update(opad);
        outer.update(inner_digest);
        let digest = outer.finalize();

        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    /// Issue a token valid until `now + TTL`.
    ///
    /// Returns `(token, expires_at_unix_seconds)`.
    pub fn issue(&self, now: i64) -> (String, i64) {
        let expires_at = now.saturating_add(config::AUTH_TOKEN_TTL_SECONDS);
        let payload = format!("{TOKEN_PREFIX}.{expires_at}");
        let signature = URL_SAFE_NO_PAD.encode(self.sign(&payload));
        (format!("{payload}.{signature}"), expires_at)
    }

    /// Verify a token's signature and expiry. Fails closed on any anomaly.
    pub fn verify(&self, token: &str, now: i64) -> bool {
        let mut parts = token.split('.');
        let (Some(prefix), Some(expires), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        if prefix != TOKEN_PREFIX {
            return false;
        }
        let Ok(expires_at) = expires.parse::<i64>() else {
            return false;
        };
        if expires_at <= now {
            return false;
        }
        let Ok(provided) = URL_SAFE_NO_PAD.decode(signature.as_bytes()) else {
            return false;
        };
        let expected = self.sign(&format!("{TOKEN_PREFIX}.{expires_at}"));
        constant_time_eq(&provided, &expected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Argon2id hash of "correct horse battery staple" (fixed, only used in tests).
    fn sample_hash() -> String {
        hash_password("correct horse battery staple").expect("hash")
    }

    #[test]
    fn hashing_produces_argon2id_phc() {
        let hash = sample_hash();
        assert!(hash.starts_with("$argon2id$"), "unexpected hash: {hash}");
        validate_password_hash(&hash).expect("valid");
    }

    #[test]
    fn password_verification_accepts_only_the_right_password() {
        let hash = sample_hash();
        assert!(verify_password(&hash, "correct horse battery staple"));
        assert!(!verify_password(&hash, "wrong password"));
        assert!(!verify_password(&hash, ""));
        assert!(!verify_password("not-a-hash", "whatever"));
    }

    #[test]
    fn rejects_non_argon2id_hashes() {
        // A syntactically valid PHC string for a different algorithm.
        let other = "$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaHZhbHVl";
        assert!(validate_password_hash(other).is_err());
        assert!(validate_password_hash("").is_err());
        assert!(validate_password_hash("plaintext").is_err());
    }

    #[test]
    fn token_round_trip() {
        let issuer = TokenIssuer::new(&sample_hash());
        let now = 1_700_000_000;
        let (token, expires_at) = issuer.issue(now);
        assert_eq!(expires_at, now + config::AUTH_TOKEN_TTL_SECONDS);
        assert!(issuer.verify(&token, now));
        // Still valid one second before expiry.
        assert!(issuer.verify(&token, expires_at - 1));
        // Expired exactly at the boundary and after.
        assert!(!issuer.verify(&token, expires_at));
        assert!(!issuer.verify(&token, expires_at + 1));
    }

    #[test]
    fn token_rejects_tampering() {
        let issuer = TokenIssuer::new(&sample_hash());
        let now = 1_700_000_000;
        let (token, _) = issuer.issue(now);

        // Flip the signature.
        let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
        parts[2] = URL_SAFE_NO_PAD.encode([0u8; 32]);
        assert!(!issuer.verify(&parts.join("."), now));

        // Extend the expiry without re-signing.
        let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
        parts[1] = (now + 10_000).to_string();
        assert!(!issuer.verify(&parts.join("."), now));

        // Structural garbage.
        for bad in ["", "v1", "v1.x.y", "v2.1.2", "v1.1", "v1.1.x.y"] {
            assert!(!issuer.verify(bad, now), "should reject {bad:?}");
        }
    }

    #[test]
    fn rotating_the_password_invalidates_old_tokens() {
        let old = TokenIssuer::new(&sample_hash());
        let now = 1_700_000_000;
        let (token, _) = old.issue(now);

        let rotated = TokenIssuer::new(&hash_password("another password").expect("hash"));
        assert!(!rotated.verify(&token, now));
    }

    #[test]
    fn token_from_another_secret_is_rejected() {
        let a = TokenIssuer::new(&sample_hash());
        let b = TokenIssuer::new(&hash_password("different").expect("hash"));
        let now = 1_700_000_000;
        let (token, _) = a.issue(now);
        assert!(!b.verify(&token, now));
    }
}
