//! One on-demand still frame: ask the compositor over the bridge
//! socket, read the PNG it wrote, enforce the caps.
//!
//! The bridge protocol (Genesis `capture` op, compositor
//! `runtime_bridge.rs` + `capture.rs`): one JSON line out,
//! `{"v":1,"op":"capture"}`, and reply lines back until the
//! `capture` reply arrives — the reply is deferred one loop
//! iteration (the backend resolves it after the next render), so
//! the client must read until a reply with `"op":"capture"`
//! arrives. Success:
//! `{"v":1,"ok":true,"op":"capture","width":w,"height":h,
//! "path":"/data/screen/latest.png"}`.
//! Refusal / failure:
//! `{"v":1,"ok":false,"op":"capture","error":"..."}` —
//! `"refused: sensitive surface"`, `"capture already pending"`,
//! `"malformed request"`, or a readback/write failure.
//!
//! S3 — never a stale frame: the PNG file is read ONLY when the
//! reply is `ok:true`, AND only when its mtime is no older than
//! this request (minus the small `MTIME_GRACE` for wall-clock /
//! filesystem timestamp skew — the check still rejects anything
//! from an earlier capture). A refusal, a failure, a missing
//! file, or a stale mtime all mean NO frame is sent for the
//! request — the caller answers with an explicit error instead.
//! The compositor writes nothing on refusal, so the file on disk
//! after a refusal is the previous good frame, and serving it
//! would leak exactly the pixels the refusal was protecting.
//!
//! The agent never passes a `path` override: the compositor owns
//! the output path (`/data/screen/latest.png`, S4 — one file,
//! overwritten, no history). The reply's `path` is where the agent
//! reads from; it must be absolute.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::envelope::MAX_FRAME_BYTES;

/// How long to wait for the deferred capture reply. The reply
/// arrives after the next render, which is prompt while the
/// compositor is alive; a longer wait would wedge the sealed loop
/// (which is single-threaded, like a SESSION) on a dead
/// compositor.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);

/// Tolerance for the S3 freshness check below: the frame file's
/// mtime must be no older than the request minus this grace. The
/// wall clock (`SystemTime::now`) and filesystem timestamps can
/// disagree by sub-millisecond amounts (different clock sources,
/// NTP slew, coarse granularity), so a strict comparison rejects
/// genuinely fresh frames. 2 s still rejects anything from an
/// earlier capture round-trip — and the real S3 protection is the
/// refusal path (a refused capture never reads the file at all),
/// not this check.
pub const MTIME_GRACE: Duration = Duration::from_secs(2);

/// The bridge socket as the agent sees it in the image: init
/// exports `XDG_RUNTIME_DIR=/run`, and the compositor binds
/// `$XDG_RUNTIME_DIR/sevyn-compositor.sock` (Genesis
/// `backend.rs`). The env var is honoured when set (the agent
/// inherits the shell's environment in the guest); `/run` is the
/// fallback for a caller without it.
pub fn default_capture_sock() -> PathBuf {
    match std::env::var("XDG_RUNTIME_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir).join("sevyn-compositor.sock"),
        _ => PathBuf::from("/run/sevyn-compositor.sock"),
    }
}

/// One captured frame: the PNG bytes plus the dimensions the
/// compositor reported (cross-checked against the PNG's IHDR).
#[derive(Debug)]
pub struct CapturedPng {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
    pub sha256_hex: String,
}

#[derive(Debug, Deserialize)]
struct BridgeReply {
    #[allow(dead_code)]
    v: Option<u32>,
    ok: bool,
    op: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    path: Option<String>,
    error: Option<String>,
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Ask the compositor for one frame and read the PNG it wrote.
/// Returns the bytes on success; on any failure returns an error
/// string the agent forwards to the cloud agent — and reads no
/// file at all.
pub fn capture_frame(sock_path: &Path) -> Result<CapturedPng, String> {
    let requested_at = SystemTime::now();
    let mut stream = UnixStream::connect(sock_path).map_err(|e| {
        format!(
            "capture unavailable: cannot connect to compositor socket {}: {e}",
            sock_path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(CAPTURE_TIMEOUT))
        .map_err(|e| format!("capture unavailable: cannot set read timeout: {e}"))?;
    stream
        .write_all(b"{\"v\":1,\"op\":\"capture\"}\n")
        .map_err(|e| format!("capture unavailable: cannot send request: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("capture unavailable: cannot send request: {e}"))?;

    // Read reply lines until the capture reply arrives (the reply
    // is deferred; other lines on this connection, if any, are not
    // capture replies and are skipped).
    let mut reader = BufReader::new(stream);
    let reply = loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut
            {
                "capture unavailable: timed out waiting for the compositor".to_string()
            } else {
                format!("capture unavailable: cannot read reply: {e}")
            }
        })?;
        if line.is_empty() {
            return Err("capture unavailable: compositor closed the connection".to_string());
        }
        let parsed: Result<BridgeReply, _> = serde_json::from_str(line.trim());
        let parsed = match parsed {
            Ok(p) => p,
            Err(_) => continue, // not a bridge reply; keep reading
        };
        if parsed.op.as_deref() == Some("capture") {
            break parsed;
        }
    };
    if !reply.ok {
        let reason = reply.error.unwrap_or_else(|| "unknown error".to_string());
        if reason.starts_with("refused:") {
            return Err(format!("capture refused: {reason}"));
        }
        return Err(format!("capture failed: {reason}"));
    }
    let (width, height) = match (reply.width, reply.height) {
        (Some(w), Some(h)) => (w, h),
        _ => return Err("capture failed: reply has no dimensions".to_string()),
    };
    let path = match reply.path {
        Some(p) if Path::new(&p).is_absolute() => p,
        _ => return Err("capture failed: reply has no absolute path".to_string()),
    };

    // S3 freshness: the file must have been written by THIS
    // capture — its mtime no older than the request (minus the
    // MTIME_GRACE skew tolerance). A stale mtime means the
    // compositor did not rewrite the file for this request, so
    // these bytes are an older frame: fail closed.
    let meta =
        std::fs::metadata(&path).map_err(|e| format!("capture failed: cannot stat {path}: {e}"))?;
    match meta.modified() {
        Ok(mtime) if mtime + MTIME_GRACE >= requested_at => {}
        Ok(_) => {
            return Err(
                "capture failed: frame file is stale (not written by this capture)".to_string(),
            )
        }
        Err(e) => return Err(format!("capture failed: cannot stat {path}: {e}")),
    }
    // Cap the read: refuse >1 MiB without buffering the whole
    // file.
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("capture failed: cannot read {path}: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_FRAME_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("capture failed: cannot read {path}: {e}"))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("frame exceeds 1 MiB cap".to_string());
    }
    // Light validation: PNG magic + IHDR dimensions matching the
    // reply (catches a truncated or corrupt write before the bytes
    // cross the wire).
    if bytes.len() < 33
        || bytes[..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        || &bytes[12..16] != b"IHDR"
    {
        return Err("capture failed: frame file is not a PNG".to_string());
    }
    let png_w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let png_h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if png_w != width || png_h != height {
        return Err("capture failed: PNG dimensions do not match the reply".to_string());
    }
    let sha256_hex = hex(&Sha256::digest(&bytes));
    Ok(CapturedPng {
        width,
        height,
        bytes,
        sha256_hex,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A minimal valid 1x1 RGBA PNG (red pixel), generated with
    /// stdlib zlib: signature + IHDR(1x1, 8-bit, colour type 6) +
    /// IDAT + IEND.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn tmp(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "sevyn-capture-test-{}-{}-{tag}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake bridge socket. `on_request` runs after the request
    /// line is read (mirroring the compositor, which writes the PNG
    /// during the capture, after the request) and returns the reply
    /// line to send.
    fn fake_bridge<F>(dir: &Path, on_request: F) -> PathBuf
    where
        F: FnOnce(&str) -> String + Send + 'static,
    {
        let sock = dir.join("sevyn-compositor.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(_) => return,
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let reply = on_request(&line);
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.flush();
        });
        sock
    }

    fn ok_reply(path: &Path) -> String {
        format!(
            "{{\"v\":1,\"ok\":true,\"op\":\"capture\",\"width\":1,\"height\":1,\"path\":\"{}\"}}\n",
            path.display()
        )
    }

    #[test]
    fn ok_reply_reads_the_fresh_png() {
        let dir = tmp("ok");
        let png_path = dir.join("latest.png");
        let png_path2 = png_path.clone();
        let sock = fake_bridge(&dir, move |req| {
            assert!(req.contains("\"op\":\"capture\""), "request: {req}");
            std::fs::write(&png_path2, TINY_PNG).unwrap();
            ok_reply(&png_path2)
        });
        let frame = capture_frame(&sock).unwrap();
        assert_eq!(frame.width, 1);
        assert_eq!(frame.height, 1);
        assert_eq!(frame.bytes, TINY_PNG);
        assert_eq!(frame.sha256_hex, hex(&Sha256::digest(TINY_PNG)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refusal_never_serves_the_stale_frame() {
        let dir = tmp("refused");
        let png_path = dir.join("latest.png");
        // A previous good frame sits at the path (the S3 case: the
        // compositor refused and wrote nothing).
        std::fs::write(&png_path, TINY_PNG).unwrap();
        let before = std::fs::read(&png_path).unwrap();
        let png_path2 = png_path.clone();
        let sock = fake_bridge(&dir, move |_| {
            // Refusal writes nothing.
            "{\"v\":1,\"ok\":false,\"op\":\"capture\",\"error\":\"refused: sensitive surface\"}\n"
                .to_string()
        });
        let err = capture_frame(&sock).unwrap_err();
        assert!(err.contains("refused: sensitive surface"), "err: {err}");
        // The stale file is untouched — and, critically, its bytes
        // were never returned to any caller.
        assert_eq!(std::fs::read(&png_path2).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ok_reply_with_a_stale_file_is_rejected() {
        let dir = tmp("stale");
        let png_path = dir.join("latest.png");
        // Written well before the request (past the MTIME_GRACE):
        // a compositor that replied ok without rewriting the file.
        std::fs::write(&png_path, TINY_PNG).unwrap();
        std::thread::sleep(MTIME_GRACE + Duration::from_secs(1));
        let sock = fake_bridge(&dir, move |_| ok_reply(&png_path));
        let err = capture_frame(&sock).unwrap_err();
        assert!(err.contains("stale"), "err: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversize_png_is_refused() {
        let dir = tmp("big");
        let png_path = dir.join("latest.png");
        let png_path2 = png_path.clone();
        let sock = fake_bridge(&dir, move |_| {
            // PNG magic + junk past the cap.
            let mut big = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
            big.resize(MAX_FRAME_BYTES + 1, 0x00);
            std::fs::write(&png_path2, big).unwrap();
            ok_reply(&png_path2)
        });
        let err = capture_frame(&sock).unwrap_err();
        assert!(err.contains("1 MiB"), "err: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_socket_and_bad_reply_fail_closed() {
        let dir = tmp("nosock");
        let err = capture_frame(&dir.join("no-such.sock")).unwrap_err();
        assert!(err.contains("capture unavailable"), "err: {err}");
        let sock = fake_bridge(&dir, move |_| "this is not json\n".to_string());
        // A non-JSON line is skipped, then the peer closes: the
        // connection ends without a capture reply.
        let err = capture_frame(&sock).unwrap_err();
        assert!(err.contains("capture unavailable"), "err: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
