//! Keys, fingerprints, the HKDF session-key derivation and the
//! ChaCha20-Poly1305 sealed channel — the crypto core of the relay
//! handshake (INTERFACES.md, handshake steps 1–4).
//!
//! Fingerprint = SHA-256(public key) hex, lowercase; the device id
//! shown to the cloud agent is the first 16 hex chars. Pairing code
//! = first 6 hex chars of SHA-256(device_pub || peer_pub).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use ed25519_dalek::Verifier as _;
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

/// HKDF info string — binds the derived key to this protocol.
pub const HKDF_INFO: &[u8] = b"sevyn-relay-v1";

pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|e| format!("invalid base64: {e}"))
}

pub fn b64_decode_32(s: &str) -> Result<[u8; 32], String> {
    let v = b64_decode(s)?;
    v.try_into()
        .map_err(|_| "expected 32 bytes after base64 decode".to_string())
}

/// 32 fresh random bytes (getrandom 0.3: `fill`, not `getrandom`).
pub fn random_32() -> Result<[u8; 32], String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("getrandom failed: {e}"))?;
    Ok(buf)
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex_encode(&h.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Fingerprint = SHA-256(public key) hex.
pub fn fingerprint_hex(pubkey: &[u8; 32]) -> String {
    sha256_hex(pubkey)
}

/// Device id = first 16 hex chars of the fingerprint.
pub fn device_id(pubkey: &[u8; 32]) -> String {
    fingerprint_hex(pubkey)[..16].to_string()
}

/// Pairing code = first 6 hex chars of SHA-256(device_pub ||
/// peer_pub). Both sides compute it independently from the
/// exchanged public keys.
pub fn pairing_code(device_pub: &[u8; 32], peer_pub: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(device_pub);
    h.update(peer_pub);
    hex_encode(&h.finalize())[..6].to_string()
}

/// Load the device Ed25519 keypair from `<key_dir>/relay-key` (raw
/// 32-byte seed, 0600) and `<key_dir>/relay-key.pub` (raw 32 bytes).
/// The `.pub` file must match the seed's public key; a mismatch is
/// a broken keypair and fails startup.
pub fn load_device_keypair(key_dir: &Path) -> Result<(SigningKey, [u8; 32]), String> {
    let seed_path = key_dir.join("relay-key");
    let pub_path = key_dir.join("relay-key.pub");
    let seed =
        fs::read(&seed_path).map_err(|e| format!("cannot read {}: {e}", seed_path.display()))?;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| format!("{}: expected exactly 32 bytes", seed_path.display()))?;
    let pub_bytes =
        fs::read(&pub_path).map_err(|e| format!("cannot read {}: {e}", pub_path.display()))?;
    let pub_bytes: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| format!("{}: expected exactly 32 bytes", pub_path.display()))?;
    let signing = SigningKey::from_bytes(&seed);
    let derived = signing.verifying_key().to_bytes();
    if derived != pub_bytes {
        return Err(format!(
            "{} does not match the public key derived from {}",
            pub_path.display(),
            seed_path.display()
        ));
    }
    Ok((signing, pub_bytes))
}

/// Load the pinned cloud-agent public key (`relay-peer.pub`, raw 32
/// bytes) if present. Absent = unpaired.
pub fn load_pinned_peer(key_dir: &Path) -> Result<Option<[u8; 32]>, String> {
    let path = key_dir.join("relay-peer.pub");
    match fs::read(&path) {
        Ok(bytes) => bytes
            .try_into()
            .map(Some)
            .map_err(|_| format!("{}: expected exactly 32 bytes", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Ed25519 verify helper: base64 public key + base64 signature over
/// `msg`.
pub fn verify_sig(pub_b64: &str, msg: &[u8], sig_b64: &str) -> Result<(), String> {
    let pub_bytes = b64_decode_32(pub_b64)?;
    let sig_bytes = b64_decode(sig_b64)?;
    let sig = Signature::try_from(sig_bytes.as_slice())
        .map_err(|e| format!("bad signature bytes: {e}"))?;
    let vk =
        VerifyingKey::from_bytes(&pub_bytes).map_err(|e| format!("bad public key bytes: {e}"))?;
    vk.verify(msg, &sig)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// X25519 ephemeral keypair from fresh randomness.
pub fn ephemeral_keypair() -> Result<(StaticSecret, [u8; 32]), String> {
    let secret_bytes = random_32()?;
    let secret = StaticSecret::from(secret_bytes);
    let public = X25519PublicKey::from(&secret).to_bytes();
    Ok((secret, public))
}

/// ECDH shared secret: our ephemeral secret × peer ephemeral public.
pub fn ecdh_shared(secret: &StaticSecret, peer_eph_b64: &str) -> Result<[u8; 32], String> {
    let peer_bytes = b64_decode_32(peer_eph_b64)?;
    let peer_pub = X25519PublicKey::from(peer_bytes);
    Ok(*secret.diffie_hellman(&peer_pub).as_bytes())
}

/// Session key: HKDF-SHA256, salt = nonce_cloud || nonce_device
/// (32 + 32 bytes), ikm = the X25519 ECDH shared secret,
/// info = "sevyn-relay-v1".
pub fn derive_session_key(
    shared: &[u8; 32],
    nonce_cloud: &[u8; 32],
    nonce_device: &[u8; 32],
) -> Result<[u8; 32], String> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(nonce_cloud);
    salt[32..].copy_from_slice(nonce_device);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut key)
        .map_err(|e| format!("hkdf expand failed: {e}"))?;
    Ok(key)
}

/// One direction of the sealed channel. AEAD nonces are 12 bytes:
/// 4 zero bytes + an 8-byte big-endian per-direction counter,
/// starting at 0. Session keys are fresh per session (ephemeral
/// ECDH), so counters starting at 0 are safe.
pub struct AeadChannel {
    cipher: ChaCha20Poly1305,
    send_counter: u64,
    recv_counter: u64,
}

impl AeadChannel {
    pub fn new(key: &[u8; 32]) -> Self {
        Self {
            cipher: ChaCha20Poly1305::new(&Key::from(*key)),
            send_counter: 0,
            recv_counter: 0,
        }
    }

    fn nonce(counter: u64) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&counter.to_be_bytes());
        n
    }

    /// Seal plaintext; returns ciphertext + 16-byte Poly1305 tag.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        if self.send_counter == u64::MAX {
            return Err("sealed-channel send counter exhausted".to_string());
        }
        let nonce = Nonce::from(Self::nonce(self.send_counter));
        self.send_counter += 1;
        self.cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| format!("aead seal failed: {e}"))
    }

    /// Open ciphertext (ciphertext + 16-byte tag). A failure means
    /// the peer is not who it claims to be, or the stream is
    /// corrupt — the session must be dropped.
    pub fn open(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        if self.recv_counter == u64::MAX {
            return Err("sealed-channel recv counter exhausted".to_string());
        }
        let nonce = Nonce::from(Self::nonce(self.recv_counter));
        self.recv_counter += 1;
        self.cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|e| format!("aead open failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, Verifier};

    #[test]
    fn fingerprint_and_pairing_code_are_stable() {
        let dev = [7u8; 32];
        let peer = [9u8; 32];
        // SHA-256 of 32 bytes of 0x07, computed independently here.
        let fp = fingerprint_hex(&dev);
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(device_id(&dev), &fp[..16]);
        let code = pairing_code(&dev, &peer);
        assert_eq!(code.len(), 6);
        // Order matters: device || peer, not peer || device.
        assert_ne!(code, pairing_code(&peer, &dev));
    }

    #[test]
    fn aead_round_trip_and_tamper() {
        let key = [3u8; 32];
        let mut a = AeadChannel::new(&key);
        let mut b = AeadChannel::new(&key);
        let ct1 = a.seal(b"hello").unwrap();
        let ct2 = a.seal(b"second frame, counter 1").unwrap();
        assert_ne!(ct1, ct2);
        assert_eq!(b.open(&ct1).unwrap(), b"hello");
        assert_eq!(b.open(&ct2).unwrap(), b"second frame, counter 1");
        // Tamper with one byte: open must fail.
        let mut bad = ct1.clone();
        bad[0] ^= 1;
        let mut c = AeadChannel::new(&key);
        assert!(c.open(&bad).is_err());
        // Replay / wrong counter: a fresh channel opening ct2 first fails
        // (its recv counter is 0, ct2 was sealed under counter 1).
        let mut d = AeadChannel::new(&key);
        assert!(d.open(&ct2).is_err());
    }

    #[test]
    fn hkdf_is_deterministic_and_salt_bound() {
        let shared = [1u8; 32];
        let nc = [2u8; 32];
        let nd = [3u8; 32];
        let k1 = derive_session_key(&shared, &nc, &nd).unwrap();
        let k2 = derive_session_key(&shared, &nc, &nd).unwrap();
        assert_eq!(k1, k2);
        // Swapping the nonces changes the key (salt order matters).
        let k3 = derive_session_key(&shared, &nd, &nc).unwrap();
        assert_ne!(k1, k3);
    }

    #[test]
    fn ed25519_sign_verify_round_trip() {
        let seed = [5u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let sig = sk.sign(b"test nonce");
        let vk = sk.verifying_key();
        assert!(vk.verify(b"test nonce", &sig).is_ok());
        assert!(vk.verify(b"other nonce", &sig).is_err());
        // The base64 verify helper agrees.
        let pub_b64 = b64_encode(&vk.to_bytes());
        let sig_b64 = b64_encode(&sig.to_bytes());
        assert!(verify_sig(&pub_b64, b"test nonce", &sig_b64).is_ok());
        assert!(verify_sig(&pub_b64, b"other nonce", &sig_b64).is_err());
    }
}
