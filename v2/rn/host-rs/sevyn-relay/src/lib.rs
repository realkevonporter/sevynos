//! sevyn-relay — the SevynOS AI relay agent (Phase 2).
//!
//! Thin local SESSION client of the AI daemon, driven by the cloud
//! agent over the tailnet. See `session.rs` for the handshake and
//! frame loop, `crypto.rs` for the crypto core, `daemon.rs` for the
//! local daemon client, and `envelope.rs` for the NDJSON framing.

pub mod capture;
pub mod crypto;
pub mod daemon;
pub mod envelope;
pub mod log;
pub mod screen;
pub mod session;
pub mod timeutil;
