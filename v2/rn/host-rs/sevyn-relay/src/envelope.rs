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

/// Maximum bytes of one delivered frame (1 MiB). A frame over the
/// cap is refused, never truncated or split across sessions.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Raw bytes per `frame-chunk` (16 KiB). Base64 expands that to
/// ~22 KiB of JSON text, comfortably inside the 64 KiB line cap.
pub const FRAME_CHUNK_BYTES: usize = 16 * 1024;

/// Minimum interval between accepted frame requests (1 s): the
/// ≤1 fps rate cap (S1). A request inside the interval is refused
/// with an error, never queued.
pub const FRAME_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

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

/// Screen observation (R8, S1–S4) — on-demand still frames, JSON
/// chunked, NOT binary (see FRAMES.md in the relay design dir for
/// the decision): a 150–600 KB PNG cannot fit one 64 KiB NDJSON
/// line, so the agent splits it into sealed `frame-chunk` frames.
/// Each chunk is individually AEAD-sealed (the same channel as
/// tasks), so confidentiality and integrity hold per chunk; the
/// cloud reassembles and checks `sha256` + `bytes` from
/// `frame-start` before trusting the pixels. Wire cost is ~1.33x
/// the PNG (base64), trivial at ≤1 fps, and the framing stays the
/// existing NDJSON reader — no mode-switching binary reader, no
/// second framing implementation in every peer, no new desync
/// failure mode in the most security-sensitive reader.

/// Cloud → device: ask for one still frame now (S1 — off unless
/// asked; each request is logged by the agent).
#[derive(Debug, Serialize, Deserialize)]
pub struct FrameRequestFrame {
    #[serde(rename = "type")]
    pub kind: String, // "frame-request"
    pub id: String,
}

/// Device → cloud: a frame is coming; `sha256` is the hex SHA-256
/// of the whole PNG, `bytes` its length. The cloud must verify both
/// after reassembly and discard the frame on mismatch.
#[derive(Debug, Serialize, Deserialize)]
pub struct FrameStartFrame {
    #[serde(rename = "type")]
    pub kind: String, // "frame-start"
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub sha256: String,
}

/// Device → cloud: one chunk of the PNG (`data` is base64, at most
/// `FRAME_CHUNK_BYTES` raw bytes). `seq` starts at 0 and rises by
/// one per chunk; the cloud must check the sequence is contiguous.
#[derive(Debug, Serialize, Deserialize)]
pub struct FrameChunkFrame {
    #[serde(rename = "type")]
    pub kind: String, // "frame-chunk"
    pub id: String,
    pub seq: u64,
    pub data: String,
}

/// Device → cloud: the last chunk was sent; the frame is complete.
#[derive(Debug, Serialize, Deserialize)]
pub struct FrameEndFrame {
    #[serde(rename = "type")]
    pub kind: String, // "frame-end"
    pub id: String,
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

    #[test]
    fn frame_chunk_fits_the_line_cap() {
        // A full 16 KiB raw chunk, base64'd inside a sealed-frame
        // JSON line, must stay inside the 64 KiB NDJSON cap — the
        // invariant the JSON-chunked choice rests on.
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let raw = vec![0xABu8; FRAME_CHUNK_BYTES];
        let chunk = FrameChunkFrame {
            kind: "frame-chunk".to_string(),
            id: "00000000-0000-0000-0000-000000000000".to_string(),
            seq: 0,
            data: B64.encode(&raw),
        };
        let mut buf: Vec<u8> = Vec::new();
        write_json_line(&mut buf, &chunk).unwrap();
        assert!(
            buf.len() < MAX_LINE_BYTES,
            "chunk line is {} bytes",
            buf.len()
        );
        // And a max-size frame is 64 chunks at most.
        assert_eq!(MAX_FRAME_BYTES / FRAME_CHUNK_BYTES, 64);
    }
}
