//! The local daemon client: one `SESSION <task>` line to
//! `/run/sevyn-ai.sock`, one reply line back.
//!
//! The daemon runs a SESSION synchronously and replies with a single
//! final line, `OK backend=<id> allowed=<n> denied=<m> failed=<k>`
//! (or `ERR ...`). There is deliberately **no read timeout** on the
//! UnixStream while a SESSION is in flight: a SESSION blocks the
//! daemon's poll loop, worst case 64 actions x the backend's
//! per-action timeout, so any timeout short of that would kill
//! legitimate long sessions. The TCP heartbeat runs on a separate
//! thread (see session.rs), so a stuck SESSION cannot wedge the
//! heartbeat either.
//!
//! Connect failures (daemon down) retry with backoff before the
//! agent reports the error to the cloud agent.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::thread;
use std::time::Duration;

/// Outcome counts from the daemon's `OK ...` line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionOutcome {
    pub allowed: u64,
    pub denied: u64,
    pub failed: u64,
}

/// Connect attempts before giving up on a daemon connect.
const CONNECT_ATTEMPTS: u32 = 5;
/// First backoff between connect attempts; doubles each retry.
const CONNECT_BACKOFF_FIRST: Duration = Duration::from_millis(100);
/// Longest backoff between connect attempts.
const CONNECT_BACKOFF_MAX: Duration = Duration::from_millis(1000);

/// Send `SESSION <task>` to the daemon and read its one reply line.
/// Retries the connect with backoff while the daemon is unreachable.
pub fn run_session(sock_path: &Path, task: &str) -> Result<SessionOutcome, String> {
    let mut stream = connect_with_backoff(sock_path)?;
    stream
        .write_all(format!("SESSION {task}\n").as_bytes())
        .map_err(|e| format!("daemon write failed: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("daemon flush failed: {e}"))?;
    let mut reader = BufReader::new(&mut stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("daemon read failed: {e}"))?;
    parse_daemon_reply(line.trim())
}

fn connect_with_backoff(sock_path: &Path) -> Result<UnixStream, String> {
    let mut backoff = CONNECT_BACKOFF_FIRST;
    let mut last_err = String::new();
    for attempt in 1..=CONNECT_ATTEMPTS {
        match UnixStream::connect(sock_path) {
            Ok(s) => return Ok(s),
            Err(e) => {
                last_err = format!("{e}");
                if attempt == CONNECT_ATTEMPTS {
                    break;
                }
                thread::sleep(backoff);
                backoff = (backoff * 2).min(CONNECT_BACKOFF_MAX);
            }
        }
    }
    Err(format!(
        "cannot connect to daemon socket {} after {CONNECT_ATTEMPTS} attempts: {last_err}",
        sock_path.display()
    ))
}

/// Parse the daemon's one reply line:
/// `OK backend=<id> allowed=<n> denied=<m> failed=<k>` or `ERR ...`.
pub fn parse_daemon_reply(line: &str) -> Result<SessionOutcome, String> {
    if let Some(rest) = line.strip_prefix("ERR") {
        let msg = rest.trim();
        if msg.is_empty() {
            return Err("daemon replied ERR".to_string());
        }
        return Err(format!("daemon replied ERR: {msg}"));
    }
    let ok = line
        .strip_prefix("OK ")
        .ok_or_else(|| format!("unexpected daemon reply: {line}"))?;
    let mut allowed = None;
    let mut denied = None;
    let mut failed = None;
    for part in ok.split_whitespace() {
        if let Some(v) = part.strip_prefix("allowed=") {
            allowed = v.parse::<u64>().ok();
        } else if let Some(v) = part.strip_prefix("denied=") {
            denied = v.parse::<u64>().ok();
        } else if let Some(v) = part.strip_prefix("failed=") {
            failed = v.parse::<u64>().ok();
        }
    }
    match (allowed, denied, failed) {
        (Some(allowed), Some(denied), Some(failed)) => Ok(SessionOutcome {
            allowed,
            denied,
            failed,
        }),
        _ => Err(format!("daemon OK line missing counts: {line}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ok_line() {
        let o = parse_daemon_reply("OK backend=muse-ai allowed=2 denied=1 failed=0").unwrap();
        assert_eq!(
            o,
            SessionOutcome {
                allowed: 2,
                denied: 1,
                failed: 0,
            }
        );
        // Field order after OK is not significant.
        let o = parse_daemon_reply("OK failed=3 allowed=0 denied=0 backend=x").unwrap();
        assert_eq!(o.failed, 3);
    }

    #[test]
    fn parse_err_and_garbage() {
        assert!(parse_daemon_reply("ERR no backend selected").is_err());
        assert!(parse_daemon_reply("ERR").is_err());
        assert!(parse_daemon_reply("RESULT OK foo").is_err());
        assert!(parse_daemon_reply("OK backend=x allowed=1").is_err());
        assert!(parse_daemon_reply("").is_err());
    }

    #[test]
    fn connect_backoff_gives_up() {
        let t0 = std::time::Instant::now();
        let r = run_session(Path::new("/nonexistent/sevyn-ai.sock"), "test");
        assert!(r.is_err());
        // 4 sleeps: 100 + 200 + 400 + 800 ms = 1.5 s minimum.
        assert!(t0.elapsed() >= Duration::from_millis(1400));
    }
}
