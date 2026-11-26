//! The SCREEN mark (S2): while frames are flowing, the device
//! shows a distinct mark — a SCREEN pill in the tray plus a banner
//! line in Settings naming the paired agent and the session start.
//!
//! Two channels, both additive and both owned by the agent (a
//! separate process, not the daemon — the daemon gains no verbs):
//!
//! * statusd: the agent SETs the `ai.screen` key (`on`/`off`) over
//!   `/run/sevyn-status.sock`, the same fire-and-forget `SET k v`
//!   line the daemon's `status_set()` sends (sevyn-aid.c) — the
//!   socket is world-accessible and statusd broadcasts to the tray
//!   with no polling. `ai.screen` must be in statusd's key table
//!   (`v2/services/statusd.c`); an unknown key is ignored there.
//!   A failed SET is logged, never fatal.
//! * screen state file (`/data/ai/relay-screen.json`): the agent
//!   writes it on the first delivered frame of a session and
//!   removes it when the session ends, so `sevyn ai relay status`
//!   (which Settings already reads) can report the paired agent,
//!   the session start, and the frame count for the banner line.
//!   State, not secret: a fingerprint prefix, an ISO timestamp,
//!   and a count. Mode 0644.
//!
//! Semantics: `ai.screen` is `on` from the first delivered frame
//! of a session until that session ends — not per frame (the pill
//! would flicker between requests in one observing session, and
//! the session is the unit the user sees). A session that never
//! delivers a frame (every request refused) never turns it on.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::logf;

/// The statusd key the tray reads for the SCREEN pill.
pub const SCREEN_STATUS_KEY: &str = "ai.screen";

/// Default statusd socket in the image.
pub const DEFAULT_STATUS_SOCK: &str = "/run/sevyn-status.sock";

/// Default screen state file (read by `sevyn ai relay status`).
pub const DEFAULT_SCREEN_STATE: &str = "/data/ai/relay-screen.json";

/// The screen state file's contents while frames are flowing.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScreenState {
    pub screen: String,        // "on"
    pub agent: String,         // paired agent fingerprint, first 16 hex
    pub session_start: String, // ISO-8601 UTC, session established
    pub frames: u64,
}

/// Fire-and-forget `SET ai.screen <on|off>` to statusd. Mirrors
/// the daemon's `status_set()`: connect, one line, close, no reply
/// expected. Errors are the caller's to log, never fatal.
pub fn status_set_screen(sock_path: &Path, on: bool) -> Result<(), String> {
    let mut stream =
        UnixStream::connect(sock_path).map_err(|e| format!("cannot reach statusd: {e}"))?;
    let line = format!(
        "SET {SCREEN_STATUS_KEY} {}\n",
        if on { "on" } else { "off" }
    );
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("cannot talk to statusd: {e}"))?;
    Ok(())
}

/// Write (or rewrite) the screen state file: first frame of the
/// session, then once per delivered frame with the new count.
pub fn write_screen_state(path: &Path, state: &ScreenState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| format!("serialize screen state: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o644)
            .open(path)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, json).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Remove the screen state file at session end (best-effort: a
/// missing file is already the off state).
pub fn clear_screen_state(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => logf!("could not clear screen state {}: {e}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;
    use std::sync::{Arc, Mutex};

    #[test]
    fn status_set_sends_one_set_line() {
        let dir = std::env::temp_dir().join(format!("sevyn-screen-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("status.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let stream = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) > 0 {
                    seen2.lock().unwrap().push(line.trim().to_string());
                }
            }
        });
        status_set_screen(&sock, true).unwrap();
        status_set_screen(&sock, false).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            ["SET ai.screen on", "SET ai.screen off"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn screen_state_round_trip_and_clear() {
        let dir = std::env::temp_dir().join(format!("sevyn-screen-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("relay-screen.json");
        let state = ScreenState {
            screen: "on".to_string(),
            agent: "0123456789abcdef".to_string(),
            session_start: "2026-11-26T07:00:00Z".to_string(),
            frames: 3,
        };
        write_screen_state(&path, &state).unwrap();
        let back: ScreenState =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back, state);
        clear_screen_state(&path);
        assert!(!path.exists());
        clear_screen_state(&path); // missing file is fine
        let _ = std::fs::remove_dir_all(&dir);
    }
}
