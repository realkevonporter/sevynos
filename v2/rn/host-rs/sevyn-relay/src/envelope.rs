//! NDJSON framing (one JSON object per line) and the envelope
//! frame types (INTERFACES.md §4.2 as corrected: no `result` frames
//! in Phase 2 — task -> wait -> session-end with final counts only).
//!
//! Caps: a task line is at most 16 KiB; a single NDJSON line is at
//! most 64 KiB (a 16 KiB task inside a sealed frame is ~22 KiB of
//! base64, so 64 KiB leaves ample headroom while bounding memory).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

/// Maximum task text, bytes (16 KiB).
pub const MAX_TASK_BYTES: usize = 16 * 1024;

/// Maximum bytes of one NDJSON line, including the newline.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Read one NDJSON line (without the trailing newline). Returns
/// `Ok(None)` on clean EOF. Over-long lines are an error — the peer
/// is misbehaving and the session must be dropped. Reads through
/// `fill_buf`/`consume` so a line longer than the cap is rejected
/// without ever buffering it in full.
pub fn read_line_capped<R: BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            if buf.is_empty() {
                return Ok(None);
            }
            break;
        }
        let newline = chunk.iter().position(|&b| b == b'\n');
        let upto = newline.map(|i| i + 1).unwrap_or(chunk.len());
        // Never buffer more than the cap + 1 byte: one byte past
        // the cap is enough to prove the line is over-long.
        let room = MAX_LINE_BYTES + 1 - buf.len();
        let take_n = upto.min(room);
        buf.extend_from_slice(&chunk[..take_n]);
        reader.consume(take_n);
        if buf.len() > MAX_LINE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame line exceeds 64 KiB cap",
            ));
        }
        if newline.is_some() && take_n == upto {
            break;
        }
    }
    let mut line = String::from_utf8(buf).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "frame is not valid UTF-8")
    })?;
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    Ok(Some(line))
}

/// Write one JSON value as a single NDJSON line.
pub fn write_json_line<W: Write>(writer: &mut W, value: &impl Serialize) -> std::io::Result<()> {
    let mut s = serde_json::to_string(value).map_err(std::io::Error::other)?;
    s.push('\n');
    writer.write_all(s.as_bytes())?;
    writer.flush()
}

/// The plaintext handshake frames (public keys + nonces +
/// signatures only — no secrets, so these go over the wire
/// unsealed).

#[derive(Debug, Serialize, Deserialize)]
pub struct Hello {
    #[serde(rename = "type")]
    pub kind: String, // "hello"
    pub agent_key: String,
    pub eph_key: String,
    pub nonce: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelloOk {
    #[serde(rename = "type")]
    pub kind: String, // "hello-ok"
    pub device_id: String,
    pub device_key: String,
    pub eph_key: String,
    pub nonce: String,
    pub sig: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelloAck {
    #[serde(rename = "type")]
    pub kind: String, // "hello-ack"
    pub sig: String,
}

/// Everything after the handshake is AEAD-sealed:
/// `{"type":"sealed","data":"<base64>"}`, where the plaintext is
/// one of the envelope JSON objects below.
#[derive(Debug, Serialize, Deserialize)]
pub struct SealedFrame {
    #[serde(rename = "type")]
    pub kind: String, // "sealed"
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskFrame {
    #[serde(rename = "type")]
    pub kind: String, // "task"
    pub id: String,
    pub task: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionEndFrame {
    #[serde(rename = "type")]
    pub kind: String, // "session-end"
    pub id: String,
    pub allowed: u64,
    pub denied: u64,
    pub failed: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PingFrame {
    #[serde(rename = "type")]
    pub kind: String, // "ping"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PongFrame {
    #[serde(rename = "type")]
    pub kind: String, // "pong"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ByeFrame {
    #[serde(rename = "type")]
    pub kind: String, // "bye"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorFrame {
    #[serde(rename = "type")]
    pub kind: String, // "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_code: Option<String>,
}

/// The `type` field of an incoming sealed plaintext, used to
/// dispatch before full deserialization.
#[derive(Debug, Deserialize)]
pub struct TypedFrame {
    #[serde(rename = "type")]
    pub kind: String,
}

pub fn sealed_json(data_b64: &str) -> SealedFrame {
    SealedFrame {
        kind: "sealed".to_string(),
        data: data_b64.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn line_round_trip_and_cap() {
        let mut buf: Vec<u8> = Vec::new();
        let task = TaskFrame {
            kind: "task".to_string(),
            id: "abc".to_string(),
            task: "do a thing".to_string(),
        };
        write_json_line(&mut buf, &task).unwrap();
        let mut reader = Cursor::new(buf);
        let line = read_line_capped(&mut reader).unwrap().unwrap();
        let back: TaskFrame = serde_json::from_str(&line).unwrap();
        assert_eq!(back.task, "do a thing");
        assert!(read_line_capped(&mut reader).unwrap().is_none());

        // Over-long line errors instead of growing memory.
        let huge = vec![b'x'; MAX_LINE_BYTES + 10];
        let mut reader = Cursor::new(huge);
        assert!(read_line_capped(&mut reader).is_err());
    }

    #[test]
    fn task_cap_boundary() {
        assert_eq!(MAX_TASK_BYTES, 16384);
        let ok = "x".repeat(MAX_TASK_BYTES);
        assert!(ok.len() <= MAX_TASK_BYTES);
        let over = "x".repeat(MAX_TASK_BYTES + 1);
        assert!(over.len() > MAX_TASK_BYTES);
    }
}
