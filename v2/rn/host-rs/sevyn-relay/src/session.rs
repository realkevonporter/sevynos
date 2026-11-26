//! One cloud-agent connection: the mutual-auth handshake, then
//! the sealed frame loop (INTERFACES.md, handshake steps 1–4).
//!
//! Timers (R7): idle (no task) and max-session drops are enforced
//! by the heartbeat thread, which owns the only clock checks and
//! shuts the socket down when one fires — the main loop blocks on
//! reads with no timeout, so a long SESSION in flight can never
//! wedge the heartbeat or the timers.

use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use crate::capture;
use crate::crypto::{
    b64_decode, b64_decode_32, b64_encode, derive_session_key, device_id, ecdh_shared,
    ephemeral_keypair, load_device_keypair, load_pinned_peer, pairing_code, random_32, verify_sig,
    AeadChannel,
};
use crate::daemon;
use crate::envelope::{
    self, ErrorFrame, FrameChunkFrame, FrameEndFrame, FrameRequestFrame, FrameStartFrame, Hello,
    HelloAck, HelloOk, PingFrame, PongFrame, SealedFrame, SessionEndFrame, TaskFrame, TypedFrame,
    FRAME_CHUNK_BYTES, FRAME_MIN_INTERVAL, MAX_TASK_BYTES,
};
use crate::logf;
use crate::screen::{self, ScreenState};
use crate::timeutil::iso_now;

/// Lifecycle timers (R7 production defaults: 15 min idle, 4 h max,
/// 30 s heartbeat). The flags exist so tests can shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timers {
    pub idle_timeout: Duration,
    pub max_session: Duration,
    pub heartbeat: Duration,
}

impl Default for Timers {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(900),
            max_session: Duration::from_secs(14_400),
            heartbeat: Duration::from_secs(30),
        }
    }
}

/// The device identity loaded once at startup: the device keypair
/// only. The pinned cloud-agent key is deliberately NOT cached
/// here — `run_connection` re-reads it from disk on every
/// connection, so a `pair --confirm` that lands after startup
/// takes effect without an agent restart (a startup snapshot
/// would loop on pairing-required until reboot/off-on).
pub struct DeviceIdentity {
    pub signing_key: ed25519_dalek::SigningKey,
    pub public_key: [u8; 32],
}

impl DeviceIdentity {
    pub fn load(key_dir: &Path) -> Result<Self, String> {
        let (signing_key, public_key) = load_device_keypair(key_dir)?;
        Ok(Self {
            signing_key,
            public_key,
        })
    }
}

/// Pending-pairing record (`relay-pending.json`, 0600).
#[derive(Debug, Serialize, Deserialize)]
pub struct PendingPairing {
    pub peer_key: String,
    pub pairing_code: String,
    pub first_seen: String,
}

fn write_pending(key_dir: &Path, peer_pub: &[u8; 32], code: &str) -> Result<(), String> {
    let path = key_dir.join("relay-pending.json");
    // Preserve the original first_seen for the same peer.
    let first_seen = match std::fs::read_to_string(&path) {
        Ok(existing) => serde_json::from_str::<PendingPairing>(&existing)
            .ok()
            .filter(|p| p.peer_key == b64_encode(peer_pub))
            .map(|p| p.first_seen)
            .unwrap_or_else(iso_now),
        Err(_) => iso_now(),
    };
    let pending = PendingPairing {
        peer_key: b64_encode(peer_pub),
        pairing_code: code.to_string(),
        first_seen,
    };
    let json = serde_json::to_string(&pending).map_err(|e| format!("serialize pending: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, json).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Shared sealed-channel state: the AEAD channel and the writer.
/// One lock order everywhere (channel, then writer) so the main
/// loop and the heartbeat thread can never deadlock.
struct Shared {
    channel: Mutex<AeadChannel>,
    writer: Mutex<TcpStream>,
}

impl Shared {
    /// Seal `plaintext_json` and write it as one NDJSON sealed frame.
    fn send_sealed(&self, plaintext_json: &str) -> Result<(), String> {
        let data = {
            let mut channel = self.channel.lock().unwrap();
            channel.seal(plaintext_json.as_bytes())?
        };
        let frame = envelope::sealed_json(&b64_encode(&data));
        let mut writer = self.writer.lock().unwrap();
        envelope::write_json_line(&mut *writer, &frame)
            .map_err(|e| format!("sealed write failed: {e}"))
    }

    fn send_error(&self, id: Option<&str>, message: &str) {
        let frame = ErrorFrame {
            kind: "error".to_string(),
            id: id.map(str::to_string),
            message: message.to_string(),
            pairing_code: None,
        };
        let json = serde_json::to_string(&frame).unwrap();
        if let Err(e) = self.send_sealed(&json) {
            logf!("sealed error reply failed: {e}");
        }
    }
}

/// Frame plumbing for one connection: where the agent reaches the
/// compositor, statusd, and the screen state file. All paths have
/// production defaults (`FrameConfig::default`); the agent's CLI
/// flags override them so host tests can point at fakes.
#[derive(Debug, Clone)]
pub struct FrameConfig {
    pub capture_sock: PathBuf,
    pub status_sock: PathBuf,
    pub screen_state: PathBuf,
}

impl Default for FrameConfig {
    fn default() -> Self {
        Self {
            capture_sock: capture::default_capture_sock(),
            status_sock: PathBuf::from(screen::DEFAULT_STATUS_SOCK),
            screen_state: PathBuf::from(screen::DEFAULT_SCREEN_STATE),
        }
    }
}

/// Per-connection frame state: the rate-cap window, the delivered
/// count (logged at session end with `via=relay`), and whether the
/// SCREEN mark is on (so teardown can turn it off exactly once).
struct FrameState {
    frames: u64,
    last_accepted: Option<Instant>,
    screen_on: bool,
    session_start_iso: String,
    peer_fp16: String,
}

/// Handle one accepted cloud-agent connection to completion
/// (handshake, then sealed frames until close, error, or a timer
/// drop). Returns when the connection is over.
pub fn handle_connection(
    stream: TcpStream,
    identity: &DeviceIdentity,
    key_dir: &Path,
    daemon_sock: &Path,
    timers: Timers,
    frames: FrameConfig,
) {
    let peer = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "?".to_string());
    logf!("connection from {peer}");
    if let Err(e) = run_connection(stream, identity, key_dir, daemon_sock, timers, &frames) {
        logf!("connection from {peer} ended: {e}");
    } else {
        logf!("connection from {peer} closed");
    }
}

fn run_connection(
    stream: TcpStream,
    identity: &DeviceIdentity,
    key_dir: &Path,
    daemon_sock: &Path,
    timers: Timers,
    frames_cfg: &FrameConfig,
) -> Result<(), String> {
    // The handshake must arrive promptly; the session itself has no
    // read timeout (a SESSION in flight blocks the daemon's poll
    // loop — see daemon.rs).
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| format!("set read timeout: {e}"))?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("clone stream: {e}"))?,
    );
    let mut writer = stream;

    // --- 1. hello -------------------------------------------------
    let hello_line = envelope::read_line_capped(&mut reader)
        .map_err(|e| format!("hello read failed: {e}"))?
        .ok_or_else(|| "peer closed before hello".to_string())?;
    let hello: Hello =
        serde_json::from_str(&hello_line).map_err(|e| format!("hello is not valid JSON: {e}"))?;
    if hello.kind != "hello" {
        return Err(format!("expected hello, got {}", hello.kind));
    }
    let agent_pub = b64_decode_32(&hello.agent_key)?;
    let nonce_c = b64_decode_32(&hello.nonce)?;

    // --- 2. verify the agent key against the pinned peer ---------
    // An unknown key — or a key that differs from the pinned one —
    // gets the same treatment (no oracle between unknown and
    // revoked): record the pending pairing, reply pairing-required,
    // close. The pin is re-read from disk on EVERY connection:
    // `pair --confirm` writes it while the agent is running, and
    // the next connect must honour it without a restart. A pin
    // file that cannot be read (corrupt, wrong length) fails
    // closed into the pairing-required path — the user re-pairs
    // and `pair --confirm` overwrites the bad file.
    let pinned_peer = match load_pinned_peer(key_dir) {
        Ok(p) => p,
        Err(e) => {
            logf!("cannot read pinned peer ({e}), treating as unpaired");
            None
        }
    };
    if pinned_peer != Some(agent_pub) {
        let code = pairing_code(&identity.public_key, &agent_pub);
        match write_pending(key_dir, &agent_pub, &code) {
            Ok(()) => logf!("unknown agent key, pairing pending (code {code})"),
            Err(e) => logf!("could not record pending pairing: {e}"),
        }
        let err = ErrorFrame {
            kind: "error".to_string(),
            id: None,
            message: "pairing required — approve on the device".to_string(),
            pairing_code: Some(code),
        };
        let _ = envelope::write_json_line(&mut writer, &err);
        return Err("pairing required".to_string());
    }

    // --- 3. hello-ok ----------------------------------------------
    let (eph_secret, eph_pub) = ephemeral_keypair()?;
    let nonce_d = random_32()?;
    let sig = identity.signing_key.sign(&nonce_c);
    let hello_ok = HelloOk {
        kind: "hello-ok".to_string(),
        device_id: device_id(&identity.public_key),
        device_key: b64_encode(&identity.public_key),
        eph_key: b64_encode(&eph_pub),
        nonce: b64_encode(&nonce_d),
        sig: b64_encode(&sig.to_bytes()),
    };
    envelope::write_json_line(&mut writer, &hello_ok)
        .map_err(|e| format!("hello-ok write failed: {e}"))?;

    // --- 4. hello-ack ---------------------------------------------
    let ack_line = envelope::read_line_capped(&mut reader)
        .map_err(|e| format!("hello-ack read failed: {e}"))?
        .ok_or_else(|| "peer closed before hello-ack".to_string())?;
    let ack: HelloAck =
        serde_json::from_str(&ack_line).map_err(|e| format!("hello-ack is not valid JSON: {e}"))?;
    if ack.kind != "hello-ack" {
        return Err(format!("expected hello-ack, got {}", ack.kind));
    }
    if let Err(e) = verify_sig(&hello.agent_key, &nonce_d, &ack.sig) {
        let err = ErrorFrame {
            kind: "error".to_string(),
            id: None,
            message: "hello-ack signature verification failed".to_string(),
            pairing_code: None,
        };
        let _ = envelope::write_json_line(&mut writer, &err);
        return Err(e);
    }

    // --- 5. session key -------------------------------------------
    let shared_secret = ecdh_shared(&eph_secret, &hello.eph_key)?;
    let session_key = derive_session_key(&shared_secret, &nonce_c, &nonce_d)?;
    let channel = AeadChannel::new(&session_key);
    stream_clear_timeout(&writer)?;

    let peer_fp = crate::crypto::fingerprint_hex(&agent_pub);
    logf!(
        "session established with agent {}",
        &peer_fp[..16.min(peer_fp.len())]
    );
    let mut frame_state = FrameState {
        frames: 0,
        last_accepted: None,
        screen_on: false,
        session_start_iso: iso_now(),
        peer_fp16: peer_fp[..16.min(peer_fp.len())].to_string(),
    };

    // --- 6. sealed loop + heartbeat thread ------------------------
    let shared = Arc::new(Shared {
        channel: Mutex::new(channel),
        writer: Mutex::new(writer),
    });
    let stop = Arc::new(AtomicBool::new(false));
    let last_task = Arc::new(Mutex::new(Instant::now()));
    let last_pong = Arc::new(Mutex::new(Instant::now()));
    let session_start = Instant::now();
    let shutdown_handle = shared
        .writer
        .lock()
        .unwrap()
        .try_clone()
        .map_err(|e| format!("clone shutdown handle: {e}"))?;
    let shutdown_for_heartbeat = shutdown_handle
        .try_clone()
        .map_err(|e| format!("clone shutdown handle: {e}"))?;

    spawn_heartbeat(
        Arc::clone(&shared),
        Arc::clone(&stop),
        Arc::clone(&last_task),
        Arc::clone(&last_pong),
        session_start,
        timers,
        shutdown_for_heartbeat,
    );

    let result = sealed_loop(
        &mut reader,
        &shared,
        &stop,
        &last_task,
        &last_pong,
        daemon_sock,
        frames_cfg,
        &mut frame_state,
    );
    // Session stop: the frame count (with via=relay) and the SCREEN
    // mark off — exactly once, however the loop ended (bye, EOF,
    // error, or a timer drop), and only if a frame ever turned it
    // on. A session that delivered no frame never touched the mark.
    if frame_state.screen_on {
        if let Err(e) = screen::status_set_screen(&frames_cfg.status_sock, false) {
            logf!("ai.screen SET off failed: {e}");
        }
        screen::clear_screen_state(&frames_cfg.screen_state);
    }
    logf!(
        "session with agent {} ended frames={} via=relay",
        frame_state.peer_fp16,
        frame_state.frames
    );
    // Close the socket now: the heartbeat thread may still be
    // asleep for up to one heartbeat interval holding a cloned
    // handle, and the peer must see EOF promptly (e.g. after bye).
    let _ = shutdown_handle.shutdown(std::net::Shutdown::Both);
    stop.store(true, Ordering::SeqCst);
    result
}

fn stream_clear_timeout(stream: &TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(None)
        .map_err(|e| format!("clear read timeout: {e}"))
}

/// The heartbeat thread: every `timers.heartbeat`, send a sealed
/// ping; drop the session (shutdown the socket, which unblocks the
/// main loop's read) when a pong is missed, the connection has been
/// idle, or the max session length is reached.
#[allow(clippy::too_many_arguments)]
fn spawn_heartbeat(
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    last_task: Arc<Mutex<Instant>>,
    last_pong: Arc<Mutex<Instant>>,
    session_start: Instant,
    timers: Timers,
    shutdown_handle: TcpStream,
) {
    thread::spawn(move || loop {
        thread::sleep(timers.heartbeat);
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        let idle = *last_task.lock().unwrap();
        let pong = *last_pong.lock().unwrap();
        let reason: Option<String> = if now.duration_since(pong) > timers.heartbeat * 2 {
            Some(format!(
                "heartbeat missed (no pong for {}s)",
                now.duration_since(pong).as_secs()
            ))
        } else if now.duration_since(idle) > timers.idle_timeout {
            Some(format!(
                "idle timeout (no task for {}s)",
                now.duration_since(idle).as_secs()
            ))
        } else if now.duration_since(session_start) > timers.max_session {
            Some(format!(
                "max session length reached ({}s)",
                now.duration_since(session_start).as_secs()
            ))
        } else {
            None
        };
        if let Some(reason) = reason {
            logf!("dropping session: {reason}");
            let _ = shutdown_handle.shutdown(std::net::Shutdown::Both);
            return;
        }
        let ping = PingFrame {
            kind: "ping".to_string(),
        };
        let json = serde_json::to_string(&ping).unwrap();
        if let Err(e) = shared.send_sealed(&json) {
            logf!("heartbeat ping failed, ending session: {e}");
            return;
        }
    });
}

fn sealed_loop(
    reader: &mut BufReader<TcpStream>,
    shared: &Arc<Shared>,
    stop: &Arc<AtomicBool>,
    last_task: &Arc<Mutex<Instant>>,
    last_pong: &Arc<Mutex<Instant>>,
    daemon_sock: &Path,
    frames_cfg: &FrameConfig,
    frame_state: &mut FrameState,
) -> Result<(), String> {
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let line = match envelope::read_line_capped(reader) {
            Ok(Some(l)) => l,
            Ok(None) => return Ok(()), // clean EOF
            Err(e) => return Err(format!("sealed read failed: {e}")),
        };
        let frame: SealedFrame = match serde_json::from_str(&line) {
            Ok(f) => f,
            Err(e) => return Err(format!("frame is not valid JSON: {e}")),
        };
        if frame.kind != "sealed" {
            return Err(format!("expected sealed frame, got {}", frame.kind));
        }
        let ciphertext = b64_decode(&frame.data)?;
        let plaintext = {
            let mut channel = shared.channel.lock().unwrap();
            channel.open(&ciphertext)?
        };
        let text = String::from_utf8(plaintext)
            .map_err(|_| "sealed plaintext is not valid UTF-8".to_string())?;
        let typed: TypedFrame = serde_json::from_str(&text)
            .map_err(|e| format!("sealed plaintext is not valid JSON: {e}"))?;
        match typed.kind.as_str() {
            "task" => {
                let task: TaskFrame = serde_json::from_str(&text)
                    .map_err(|e| format!("task frame is not valid: {e}"))?;
                *last_task.lock().unwrap() = Instant::now();
                if task.task.len() > MAX_TASK_BYTES {
                    logf!("task {} exceeds 16 KiB cap, refused", task.id);
                    shared.send_error(Some(&task.id), "task exceeds 16 KiB cap");
                    continue;
                }
                // One outstanding SESSION at a time: this loop is
                // single-threaded, so no second task can start
                // while one is in flight.
                match daemon::run_session(daemon_sock, &task.task) {
                    Ok(outcome) => {
                        let end = SessionEndFrame {
                            kind: "session-end".to_string(),
                            id: task.id.clone(),
                            allowed: outcome.allowed,
                            denied: outcome.denied,
                            failed: outcome.failed,
                        };
                        let json = serde_json::to_string(&end).unwrap();
                        shared.send_sealed(&json)?;
                    }
                    Err(e) => {
                        logf!("SESSION {} failed: {e}", task.id);
                        shared.send_error(Some(&task.id), &e);
                    }
                }
            }
            "ping" => {
                let pong = PongFrame {
                    kind: "pong".to_string(),
                };
                let json = serde_json::to_string(&pong).unwrap();
                shared.send_sealed(&json)?;
            }
            "frame-request" => {
                let req: FrameRequestFrame = serde_json::from_str(&text)
                    .map_err(|e| format!("frame-request frame is not valid: {e}"))?;
                // A frame request is cloud activity: it resets the
                // idle timer like a task does.
                *last_task.lock().unwrap() = Instant::now();
                // Rate cap (S1, ≤1 fps): a request inside the window
                // is refused, never queued — queueing would let
                // requests pile up past the cap.
                if let Some(last) = frame_state.last_accepted {
                    if last.elapsed() < FRAME_MIN_INTERVAL {
                        logf!("frame {} refused: rate limited via=relay", req.id);
                        shared.send_error(
                            Some(&req.id),
                            "frame rate limited: at most one frame per second",
                        );
                        continue;
                    }
                }
                frame_state.last_accepted = Some(Instant::now());
                match deliver_frame(&req.id, frames_cfg, frame_state, shared) {
                    Ok(()) => {}
                    Err(e) => {
                        logf!("frame {} refused: {e} via=relay", req.id);
                        shared.send_error(Some(&req.id), &e);
                    }
                }
            }
            "pong" => {
                *last_pong.lock().unwrap() = Instant::now();
            }
            "bye" => {
                logf!("bye received, closing session");
                return Ok(());
            }
            other => {
                shared.send_error(None, &format!("unknown frame type: {other}"));
            }
        }
    }
}

/// Deliver one frame for `frame-request` id: capture, then stream
/// `frame-start` / `frame-chunk`* / `frame-end` over the sealed
/// channel. On the first delivered frame of the session the SCREEN
/// mark goes on (statusd `ai.screen`, plus the screen state file
/// for `sevyn ai relay status` / Settings); the state file's frame
/// count is updated on every delivery. No per-frame log line — the
/// session-end line carries the count (see `run_connection`).
///
/// Errors are fail-closed and carry no pixels: a refused capture
/// (S3), an oversize PNG, or a missing compositor all surface here
/// as an error string, and the caller answers with an `error`
/// frame for the request id.
fn deliver_frame(
    id: &str,
    cfg: &FrameConfig,
    state: &mut FrameState,
    shared: &Arc<Shared>,
) -> Result<(), String> {
    let png = capture::capture_frame(&cfg.capture_sock)?;
    state.frames += 1;
    if !state.screen_on {
        if let Err(e) = screen::status_set_screen(&cfg.status_sock, true) {
            logf!("ai.screen SET on failed: {e}");
        }
        state.screen_on = true;
    }
    let screen_state = ScreenState {
        screen: "on".to_string(),
        agent: state.peer_fp16.clone(),
        session_start: state.session_start_iso.clone(),
        frames: state.frames,
    };
    if let Err(e) = screen::write_screen_state(&cfg.screen_state, &screen_state) {
        logf!("screen state write failed: {e}");
    }
    let start = FrameStartFrame {
        kind: "frame-start".to_string(),
        id: id.to_string(),
        width: png.width,
        height: png.height,
        bytes: png.bytes.len() as u64,
        sha256: png.sha256_hex,
    };
    let json = serde_json::to_string(&start).unwrap();
    shared.send_sealed(&json)?;
    let mut seq = 0u64;
    for chunk in png.bytes.chunks(FRAME_CHUNK_BYTES) {
        let frame = FrameChunkFrame {
            kind: "frame-chunk".to_string(),
            id: id.to_string(),
            seq,
            data: b64_encode(chunk),
        };
        let json = serde_json::to_string(&frame).unwrap();
        shared.send_sealed(&json)?;
        seq += 1;
    }
    let end = FrameEndFrame {
        kind: "frame-end".to_string(),
        id: id.to_string(),
    };
    let json = serde_json::to_string(&end).unwrap();
    shared.send_sealed(&json)?;
    Ok(())
}

/// The on-disk pending-pairing path (used by tests and the CLI
/// surface that reads it).
pub fn pending_path(key_dir: &Path) -> PathBuf {
    key_dir.join("relay-pending.json")
}
