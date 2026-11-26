//! Integration tests for sevyn-relay: drive the real binary over
//! loopback with a test cloud agent (Ed25519 + ephemeral X25519,
//! HKDF, ChaCha20-Poly1305 — the same construction as the agent,
//! via the crate's own `crypto` module) and a fake daemon socket.
//!
//! Each test spawns its own agent on `--port 0` (the bound port is
//! read back from the agent's `listening on ...` log line) with its
//! own temp key dir, so tests can run in parallel.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sevyn_relay::crypto::{
    b64_encode, derive_session_key, device_id, ephemeral_keypair, pairing_code, random_32,
    AeadChannel,
};
use sevyn_relay::envelope::MAX_TASK_BYTES;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn tmp_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "sevyn-relay-test-{}-{}-{tag}",
        std::process::id(),
        n
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A device keypair + optional pinned peer, on disk as the agent
/// expects them (raw 32-byte files).
struct KeyDir {
    dir: PathBuf,
    device_pub: [u8; 32],
}

impl KeyDir {
    fn new(pinned_peer: Option<[u8; 32]>) -> Self {
        let dir = tmp_dir("keys");
        let seed = random_32().unwrap();
        let signing = SigningKey::from_bytes(&seed);
        let device_pub = signing.verifying_key().to_bytes();
        fs::write(dir.join("relay-key"), seed).unwrap();
        fs::write(dir.join("relay-key.pub"), device_pub).unwrap();
        if let Some(peer) = pinned_peer {
            fs::write(dir.join("relay-peer.pub"), peer).unwrap();
        }
        Self { dir, device_pub }
    }
}

/// A fake daemon: accepts SESSION lines on a Unix socket and
/// replies `OK backend=test allowed=2 denied=1 failed=0`.
struct FakeDaemon {
    path: PathBuf,
    received: Arc<Mutex<Vec<String>>>,
    _thread: thread::JoinHandle<()>,
}

impl FakeDaemon {
    fn new(dir: &PathBuf) -> Self {
        let path = dir.join("sevyn-ai.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let received2 = Arc::clone(&received);
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                received2.lock().unwrap().push(line.trim().to_string());
                let _ = stream.write_all(b"OK backend=test allowed=2 denied=1 failed=0\n");
            }
        });
        Self {
            path,
            received,
            _thread: thread,
        }
    }
}

/// A spawned agent process + its captured stderr lines.
struct Agent {
    child: Child,
    port: u16,
    lines: Arc<Mutex<Vec<String>>>,
    dir: PathBuf,
}

impl Agent {
    fn spawn(key_dir: &PathBuf, daemon_sock: &PathBuf, extra: &[&str]) -> Self {
        let dir = tmp_dir("agent");
        let bin = env!("CARGO_BIN_EXE_sevyn-relay");
        let mut cmd = Command::new(bin);
        cmd.arg("--bind")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("0")
            .arg("--key-dir")
            .arg(key_dir)
            .arg("--daemon-sock")
            .arg(daemon_sock)
            .arg("--pidfile")
            .arg(dir.join("relay.pid"));
        // No --log-file here: logs go to stderr, which this harness
        // captures to find the bound port. --log-file gets its own
        // test below.
        for a in extra {
            cmd.arg(a);
        }
        cmd.stderr(Stdio::piped()).stdout(Stdio::null());
        let mut child = cmd.spawn().expect("spawn sevyn-relay");
        let stderr: ChildStderr = child.stderr.take().unwrap();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let lines2 = Arc::clone(&lines);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => lines2.lock().unwrap().push(l),
                    Err(_) => break,
                }
            }
        });
        // Wait for the "listening on 127.0.0.1:<port>" line.
        let deadline = Instant::now() + Duration::from_secs(10);
        let port = loop {
            let found = {
                let guard = lines.lock().unwrap();
                guard.iter().find_map(|l| {
                    l.split("listening on 127.0.0.1:")
                        .nth(1)
                        .and_then(|p| p.trim().parse::<u16>().ok())
                })
            };
            if let Some(p) = found {
                break p;
            }
            if Instant::now() > deadline {
                panic!(
                    "agent did not start listening; stderr: {:?}",
                    lines.lock().unwrap()
                );
            }
            // If the child died, surface its output instead of waiting.
            if let Ok(Some(status)) = child.try_wait() {
                panic!(
                    "agent exited early with {status}; stderr: {:?}",
                    lines.lock().unwrap()
                );
            }
            thread::sleep(Duration::from_millis(20));
        };
        Self {
            child,
            port,
            lines,
            dir,
        }
    }

    fn log_text(&self) -> String {
        self.lines.lock().unwrap().join("\n")
    }
}

impl Agent {
    /// Like `spawn`, but with the frame plumbing pointed at fakes:
    /// a fake bridge socket, a fake statusd socket, and a temp
    /// screen-state path.
    fn spawn_frames(
        key_dir: &PathBuf,
        daemon_sock: &PathBuf,
        capture_sock: &PathBuf,
        status_sock: &PathBuf,
        screen_state: &PathBuf,
        extra: &[&str],
    ) -> Self {
        let cap = capture_sock.to_string_lossy().into_owned();
        let sta = status_sock.to_string_lossy().into_owned();
        let scr = screen_state.to_string_lossy().into_owned();
        let mut owned: Vec<&str> = vec![
            "--capture-sock",
            &cap,
            "--status-sock",
            &sta,
            "--screen-state",
            &scr,
        ];
        owned.extend_from_slice(extra);
        Self::spawn(key_dir, daemon_sock, &owned)
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The test cloud agent: speaks the handshake, then sealed frames.
/// A background pump thread answers pings (unless `auto_pong` is
/// false) and forwards other decrypted frames to a channel.
struct Cloud {
    conn: Arc<SealedConn>,
    frames: mpsc::Receiver<String>,
    closed: Arc<AtomicUsize>, // 0 = open, 1 = pump saw EOF/error
    _pump: thread::JoinHandle<()>,
}

struct SealedConn {
    channel: Mutex<AeadChannel>,
    writer: Mutex<TcpStream>,
}

impl SealedConn {
    fn send_json(&self, plaintext: &str) {
        let data = {
            let mut ch = self.channel.lock().unwrap();
            ch.seal(plaintext.as_bytes()).unwrap()
        };
        let frame = json!({"type": "sealed", "data": B64.encode(&data)});
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        let mut w = self.writer.lock().unwrap();
        w.write_all(line.as_bytes()).unwrap();
        w.flush().unwrap();
    }
}

impl Cloud {
    /// Connect + handshake as `cloud_signing`. The device public key
    /// is taken from hello-ok (and its signature over our nonce is
    /// verified) — the client does not need to know it in advance.
    fn connect(port: u16, cloud_signing: &SigningKey, auto_pong: bool) -> Self {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream.try_clone().unwrap();

        // 1. hello
        let (eph_secret, eph_pub) = ephemeral_keypair().unwrap();
        let nonce_c = random_32().unwrap();
        let cloud_pub = cloud_signing.verifying_key().to_bytes();
        let hello = json!({
            "type": "hello",
            "agent_key": b64_encode(&cloud_pub),
            "eph_key": b64_encode(&eph_pub),
            "nonce": b64_encode(&nonce_c),
        });
        write_json(&mut writer, &hello);

        // 2. hello-ok, verify the device signature over nonce_c.
        let line = read_line(&mut reader);
        let ok: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ok["type"], "hello-ok", "hello-ok: {line}");
        let device_pub: [u8; 32] = B64
            .decode(ok["device_key"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            ok["device_id"].as_str().unwrap(),
            device_id(&device_pub),
            "device_id is fingerprint[:16]"
        );
        let device_vk = VerifyingKey::from_bytes(&device_pub).unwrap();
        let sig = ed25519_dalek::Signature::try_from(
            B64.decode(ok["sig"].as_str().unwrap()).unwrap().as_slice(),
        )
        .unwrap();
        device_vk.verify(&nonce_c, &sig).unwrap();

        // 3. hello-ack: sign nonce_d with the cloud key.
        let nonce_d: [u8; 32] = B64
            .decode(ok["nonce"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let ack_sig = cloud_signing.sign(&nonce_d);
        let ack = json!({
            "type": "hello-ack",
            "sig": b64_encode(&ack_sig.to_bytes()),
        });
        write_json(&mut writer, &ack);

        // 4. session key: ECDH + HKDF(salt = nonce_c || nonce_d).
        let peer_eph: [u8; 32] = B64
            .decode(ok["eph_key"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let shared = *eph_secret
            .diffie_hellman(&x25519_dalek::PublicKey::from(peer_eph))
            .as_bytes();
        let key = derive_session_key(&shared, &nonce_c, &nonce_d).unwrap();
        let conn = Arc::new(SealedConn {
            channel: Mutex::new(AeadChannel::new(&key)),
            writer: Mutex::new(writer),
        });

        // Pump thread: decrypt frames, answer pings, forward the rest.
        let (tx, rx) = mpsc::channel::<String>();
        let closed = Arc::new(AtomicUsize::new(0));
        let closed2 = Arc::clone(&closed);
        let conn2 = Arc::clone(&conn);
        let pump = thread::spawn(move || {
            loop {
                let line = match read_line_opt(&mut reader) {
                    Some(l) => l,
                    None => break,
                };
                let frame: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                if frame["type"] != "sealed" {
                    break;
                }
                let ct = match B64.decode(frame["data"].as_str().unwrap_or("")) {
                    Ok(c) => c,
                    Err(_) => break,
                };
                let pt = {
                    let mut ch = conn2.channel.lock().unwrap();
                    match ch.open(&ct) {
                        Ok(p) => p,
                        Err(_) => break,
                    }
                };
                let text = match String::from_utf8(pt) {
                    Ok(t) => t,
                    Err(_) => break,
                };
                let typed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                if typed["type"] == "ping" {
                    if auto_pong {
                        conn2.send_json(r#"{"type":"pong"}"#);
                    }
                    continue;
                }
                if tx.send(text).is_err() {
                    break;
                }
            }
            closed2.store(1, Ordering::SeqCst);
        });

        Self {
            conn,
            frames: rx,
            closed,
            _pump: pump,
        }
    }

    fn send_task(&self, id: &str, task: &str) {
        let frame = json!({"type": "task", "id": id, "task": task});
        self.conn.send_json(&serde_json::to_string(&frame).unwrap());
    }

    fn send_frame_request(&self, id: &str) {
        let frame = json!({"type": "frame-request", "id": id});
        self.conn.send_json(&serde_json::to_string(&frame).unwrap());
    }

    /// Receive one full frame: `frame-start`, its chunks in order,
    /// `frame-end`. Verifies the reassembled byte count and SHA-256
    /// against `frame-start`, and returns (width, height, png).
    fn recv_frame(&self, timeout: Duration) -> (u32, u32, Vec<u8>) {
        use sha2::Digest as _;
        let start = self.next_frame(timeout);
        assert_eq!(start["type"], "frame-start", "frame-start: {start}");
        let id = start["id"].as_str().unwrap().to_string();
        let width = start["width"].as_u64().unwrap() as u32;
        let height = start["height"].as_u64().unwrap() as u32;
        let total = start["bytes"].as_u64().unwrap() as usize;
        let want_sha = start["sha256"].as_str().unwrap().to_string();
        let mut png: Vec<u8> = Vec::new();
        let mut expect_seq = 0u64;
        loop {
            let frame = self.next_frame(timeout);
            let ty = frame["type"].as_str().unwrap().to_string();
            if ty == "frame-end" {
                assert_eq!(frame["id"], id, "frame-end id");
                break;
            }
            assert_eq!(ty, "frame-chunk", "expected chunk, got {frame}");
            assert_eq!(frame["id"], id, "chunk id");
            assert_eq!(
                frame["seq"].as_u64().unwrap(),
                expect_seq,
                "chunk seq must be contiguous"
            );
            expect_seq += 1;
            let data = B64.decode(frame["data"].as_str().unwrap()).unwrap();
            assert!(
                data.len() <= 16 * 1024,
                "chunk over the 16 KiB raw cap: {}",
                data.len()
            );
            png.extend_from_slice(&data);
        }
        assert_eq!(png.len(), total, "reassembled byte count");
        let got_sha = format!("{:x}", sha2::Sha256::digest(&png));
        assert_eq!(got_sha, want_sha, "frame sha256");
        (width, height, png)
    }

    fn send_bye(&self) {
        self.conn.send_json(r#"{"type":"bye"}"#);
    }

    /// Next non-ping frame, waiting up to `timeout`.
    fn next_frame(&self, timeout: Duration) -> Value {
        let text = self
            .frames
            .recv_timeout(timeout)
            .expect("timed out waiting for a frame");
        serde_json::from_str(&text).unwrap()
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst) == 1
    }

    fn wait_closed(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.is_closed() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.is_closed()
    }
}

fn write_json(w: &mut TcpStream, v: &Value) {
    let mut s = serde_json::to_string(v).unwrap();
    s.push('\n');
    w.write_all(s.as_bytes()).unwrap();
    w.flush().unwrap();
}

fn read_line(reader: &mut BufReader<TcpStream>) -> String {
    read_line_opt(reader).expect("peer closed the connection")
}

fn read_line_opt(reader: &mut BufReader<TcpStream>) -> Option<String> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => None,
        Ok(_) => Some(line.trim().to_string()),
        Err(_) => None,
    }
}

fn cloud_keypair() -> SigningKey {
    SigningKey::from_bytes(&random_32().unwrap())
}

/// --- frame-test harness -------------------------------------------------
///
/// A fake compositor bridge socket: accepts capture requests in a
/// loop and answers them the way the test dictates (serve a PNG, or
/// refuse). The serving bridge writes the PNG *after* reading the
/// request — mirroring the real compositor, which writes the file
/// during the capture — so the agent's S3 freshness check sees a
/// fresh mtime.
struct FakeBridge {
    sock: PathBuf,
    png_path: PathBuf,
    _thread: thread::JoinHandle<()>,
}

impl FakeBridge {
    fn new<F>(dir: &PathBuf, serve: F) -> Self
    where
        F: Fn(&Path) -> String + Send + Sync + 'static,
    {
        let sock = dir.join("sevyn-compositor.sock");
        let png_path = dir.join("latest.png");
        let listener = UnixListener::bind(&sock).unwrap();
        let png_path2 = png_path.clone();
        let serve = std::sync::Arc::new(serve);
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let reply = serve(&png_path2);
                let _ = stream.write_all(reply.as_bytes());
                let _ = stream.flush();
            }
        });
        Self {
            sock,
            png_path,
            _thread: thread,
        }
    }

    fn serving(dir: &PathBuf, png: Vec<u8>, width: u32, height: u32) -> Self {
        Self::new(dir, move |path| {
            fs::write(path, &png).unwrap();
            format!(
                "{{\"v\":1,\"ok\":true,\"op\":\"capture\",\"width\":{width},\"height\":{height},\"path\":\"{}\"}}\n",
                path.display()
            )
        })
    }

    fn refusing(dir: &PathBuf, error: &'static str) -> Self {
        Self::new(dir, move |_| {
            format!("{{\"v\":1,\"ok\":false,\"op\":\"capture\",\"error\":\"{error}\"}}\n")
        })
    }
}

/// A fake statusd socket: records every `SET ...` line the agent
/// sends (the `ai.screen` mark), answering nothing.
struct FakeStatusd {
    path: PathBuf,
    recorded: Arc<Mutex<Vec<String>>>,
    _thread: thread::JoinHandle<()>,
}

impl FakeStatusd {
    fn new(dir: &PathBuf) -> Self {
        let path = dir.join("status.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let recorded2 = Arc::clone(&recorded);
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) > 0 {
                    recorded2.lock().unwrap().push(line.trim().to_string());
                }
            }
        });
        Self {
            path,
            recorded,
            _thread: thread,
        }
    }
}

/// CRC-32 (IEEE) and Adler-32 for the test PNG builder below.
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn png_chunk(kind: &[u8; 4], data: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_data = kind.to_vec();
    crc_data.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_data).to_be_bytes());
}

/// Build a valid RGBA PNG of the given size (gradient pixels, one
/// filter-0 scanline per row, zlib stored blocks — no encoder
/// needed). A 200x200 frame is ~160 KB, i.e. 11 chunks at 16 KiB.
fn make_png(width: u32, height: u32) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..height {
        raw.push(0u8);
        for x in 0..width {
            raw.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
    }
    let mut z = vec![0x78, 0x01];
    let mut off = 0;
    while off < raw.len() {
        let n = (raw.len() - off).min(65535);
        let last = off + n == raw.len();
        z.push(if last { 0x01 } else { 0x00 });
        z.extend_from_slice(&(n as u16).to_le_bytes());
        z.extend_from_slice(&(!(n as u16)).to_le_bytes());
        z.extend_from_slice(&raw[off..off + n]);
        off += n;
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(b"IHDR", &ihdr, &mut png);
    png_chunk(b"IDAT", &z, &mut png);
    png_chunk(b"IEND", &[], &mut png);
    png
}

/// A minimal valid 1x1 RGBA PNG (red pixel) — the same bytes as
/// `capture::tests::TINY_PNG`.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn frame_fixtures() -> (
    SigningKey,
    KeyDir,
    FakeDaemon,
    PathBuf,
    FakeBridge,
    FakeStatusd,
    PathBuf,
) {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let dir = tmp_dir("frames");
    let png = make_png(200, 200);
    let bridge = FakeBridge::serving(&dir, png, 200, 200);
    let statusd = FakeStatusd::new(&dir);
    let screen_state = dir.join("relay-screen.json");
    (cloud, keys, daemon, dir, bridge, statusd, screen_state)
}

#[test]
fn handshake_and_session_round_trip() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(&keys.dir, &daemon.path, &[]);

    // The pidfile holds the agent's pid.
    let pid: u32 = fs::read_to_string(agent.dir.join("relay.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(pid, agent.child.id());

    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_task("task-1", "read a log");
    let end = client.next_frame(Duration::from_secs(10));
    assert_eq!(end["type"], "session-end");
    assert_eq!(end["id"], "task-1");
    assert_eq!(end["allowed"], 2);
    assert_eq!(end["denied"], 1);
    assert_eq!(end["failed"], 0);
    assert_eq!(
        daemon.received.lock().unwrap().as_slice(),
        ["SESSION read a log"]
    );
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    assert!(agent.log_text().contains("session established"));
    let _ = keys;
}

#[test]
fn wrong_key_is_refused_and_pending_is_recorded() {
    let pinned = cloud_keypair();
    let other = cloud_keypair();
    let keys = KeyDir::new(Some(pinned.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(&keys.dir, &daemon.path, &[]);

    // Present a key that differs from the pinned one.
    let mut stream = TcpStream::connect(("127.0.0.1", agent.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let (eph_secret, eph_pub) = ephemeral_keypair().unwrap();
    let _ = eph_secret;
    let hello = json!({
        "type": "hello",
        "agent_key": b64_encode(&other.verifying_key().to_bytes()),
        "eph_key": b64_encode(&eph_pub),
        "nonce": b64_encode(&random_32().unwrap()),
    });
    write_json(&mut stream, &hello);
    let line = read_line(&mut reader);
    let err: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(err["type"], "error");
    assert_eq!(err["message"], "pairing required — approve on the device");
    let expected_code = pairing_code(&keys.device_pub, &other.verifying_key().to_bytes());
    assert_eq!(err["pairing_code"], expected_code);
    // The peer closed after the error.
    assert!(read_line_opt(&mut reader).is_none());

    let pending: Value =
        serde_json::from_str(&fs::read_to_string(keys.dir.join("relay-pending.json")).unwrap())
            .unwrap();
    assert_eq!(
        pending["peer_key"],
        b64_encode(&other.verifying_key().to_bytes())
    );
    assert_eq!(pending["pairing_code"], expected_code);
    assert!(pending["first_seen"].as_str().unwrap().ends_with('Z'));
    assert!(agent.log_text().contains("pairing pending"));
}

#[test]
fn unknown_key_when_unpaired_is_pairing_required() {
    let cloud = cloud_keypair();
    // No pinned peer at all.
    let keys = KeyDir::new(None);
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(&keys.dir, &daemon.path, &[]);

    let mut stream = TcpStream::connect(("127.0.0.1", agent.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let (_s, eph_pub) = ephemeral_keypair().unwrap();
    let hello = json!({
        "type": "hello",
        "agent_key": b64_encode(&cloud.verifying_key().to_bytes()),
        "eph_key": b64_encode(&eph_pub),
        "nonce": b64_encode(&random_32().unwrap()),
    });
    write_json(&mut stream, &hello);
    let line = read_line(&mut reader);
    let err: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(err["type"], "error");
    assert!(err["pairing_code"].as_str().unwrap().len() == 6);
    assert!(keys.dir.join("relay-pending.json").exists());
}

#[test]
fn pair_then_reconnect_without_restart() {
    // Regression: the agent used to snapshot the pinned peer at
    // startup, so a `pair --confirm` that landed while it was
    // running never took effect — the cloud agent looped on
    // pairing-required until reboot/off-on. The pin is re-read on
    // every connection now.
    let cloud = cloud_keypair();
    let keys = KeyDir::new(None);
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(&keys.dir, &daemon.path, &[]);

    // 1. Unpaired: the first connect gets pairing-required.
    let mut stream = TcpStream::connect(("127.0.0.1", agent.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let (_s, eph_pub) = ephemeral_keypair().unwrap();
    let hello = json!({
        "type": "hello",
        "agent_key": b64_encode(&cloud.verifying_key().to_bytes()),
        "eph_key": b64_encode(&eph_pub),
        "nonce": b64_encode(&random_32().unwrap()),
    });
    write_json(&mut stream, &hello);
    let line = read_line(&mut reader);
    let err: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(err["type"], "error");
    assert_eq!(err["message"], "pairing required — approve on the device");
    assert!(keys.dir.join("relay-pending.json").exists());
    drop(reader);
    drop(stream);

    // 2. `pair --confirm` (as the CLI does it): pin the peer key,
    //    clear the pending file. The agent is NOT restarted.
    fs::write(
        keys.dir.join("relay-peer.pub"),
        cloud.verifying_key().to_bytes(),
    )
    .unwrap();
    let _ = fs::remove_file(keys.dir.join("relay-pending.json"));

    // 3. The same cloud key reconnects and the handshake succeeds.
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_task("task-1", "read a log");
    let end = client.next_frame(Duration::from_secs(10));
    assert_eq!(end["type"], "session-end");
    assert_eq!(end["id"], "task-1");
    assert_eq!(end["allowed"], 2);
    assert_eq!(end["denied"], 1);
    assert_eq!(end["failed"], 0);
    assert_eq!(
        daemon.received.lock().unwrap().as_slice(),
        ["SESSION read a log"]
    );
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    let _ = keys;
}

#[test]
fn overlong_task_is_refused_and_session_survives() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(&keys.dir, &daemon.path, &[]);
    let client = Cloud::connect(agent.port, &cloud, true);

    let big = "x".repeat(MAX_TASK_BYTES + 1);
    client.send_task("too-big", &big);
    let err = client.next_frame(Duration::from_secs(10));
    assert_eq!(err["type"], "error");
    assert_eq!(err["id"], "too-big");
    assert!(err["message"].as_str().unwrap().contains("16 KiB"));
    assert!(daemon.received.lock().unwrap().is_empty());

    // The session is still alive: a normal task goes through.
    client.send_task("ok-task", "hello");
    let end = client.next_frame(Duration::from_secs(10));
    assert_eq!(end["type"], "session-end");
    assert_eq!(end["id"], "ok-task");
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
}

#[test]
fn daemon_unreachable_reports_error() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let missing = keys.dir.join("no-such.sock");
    let agent = Agent::spawn(&keys.dir, &missing, &[]);
    let client = Cloud::connect(agent.port, &cloud, true);
    let t0 = Instant::now();
    client.send_task("t1", "do a thing");
    let err = client.next_frame(Duration::from_secs(15));
    assert_eq!(err["type"], "error");
    assert_eq!(err["id"], "t1");
    assert!(
        err["message"].as_str().unwrap().contains("daemon"),
        "message: {}",
        err["message"]
    );
    // The connect retry/backoff is visible in the timing (~1.5 s).
    assert!(t0.elapsed() >= Duration::from_millis(1000));
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
}

#[test]
fn second_connection_is_refused_while_one_is_live() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(&keys.dir, &daemon.path, &[]);
    let first = Cloud::connect(agent.port, &cloud, true);

    // Second connection while the first is live: closed at once.
    let mut second = TcpStream::connect(("127.0.0.1", agent.port)).unwrap();
    second
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut buf = [0u8; 16];
    match second.read(&mut buf) {
        Ok(0) => {} // refused: clean EOF
        other => panic!("second connection was not refused: {other:?}"),
    }
    assert!(agent.log_text().contains("refusing second connection"));

    // Once the first session ends, the slot frees up.
    first.send_bye();
    assert!(first.wait_closed(Duration::from_secs(5)));
    let third = Cloud::connect(agent.port, &cloud, true);
    third.send_task("after", "still works");
    let end = third.next_frame(Duration::from_secs(10));
    assert_eq!(end["type"], "session-end");
    third.send_bye();
    assert!(third.wait_closed(Duration::from_secs(5)));
}

#[test]
fn idle_timeout_drops_the_session() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(
        &keys.dir,
        &daemon.path,
        &[
            "--idle-timeout-secs",
            "2",
            "--heartbeat-secs",
            "1",
            "--max-session-secs",
            "300",
        ],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    // No task: the idle timer (checked on each 1 s heartbeat tick)
    // must drop the connection within a few seconds.
    assert!(client.wait_closed(Duration::from_secs(10)));
    assert!(agent.log_text().contains("idle timeout"));
}

#[test]
fn max_session_drops_an_active_session() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(
        &keys.dir,
        &daemon.path,
        &[
            "--idle-timeout-secs",
            "300",
            "--heartbeat-secs",
            "1",
            "--max-session-secs",
            "3",
        ],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    // Pongs keep the heartbeat happy; the max-session timer still fires.
    assert!(client.wait_closed(Duration::from_secs(10)));
    assert!(agent.log_text().contains("max session length"));
}

#[test]
fn heartbeat_pong_keeps_session_alive_and_missed_pong_drops_it() {
    // With pongs answered, the session survives past 2x heartbeat.
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let agent = Agent::spawn(
        &keys.dir,
        &daemon.path,
        &[
            "--idle-timeout-secs",
            "300",
            "--heartbeat-secs",
            "1",
            "--max-session-secs",
            "300",
        ],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    thread::sleep(Duration::from_millis(3500));
    assert!(!client.is_closed(), "session dropped despite pongs");
    client.send_task("alive", "ping-pong works");
    let end = client.next_frame(Duration::from_secs(10));
    assert_eq!(end["type"], "session-end");
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));

    // Without pongs, the missed-pong rule drops the session.
    let agent2 = Agent::spawn(
        &keys.dir,
        &daemon.path,
        &[
            "--idle-timeout-secs",
            "300",
            "--heartbeat-secs",
            "1",
            "--max-session-secs",
            "300",
        ],
    );
    let silent = Cloud::connect(agent2.port, &cloud, false);
    assert!(silent.wait_closed(Duration::from_secs(10)));
    assert!(agent2.log_text().contains("heartbeat missed"));
}

#[test]
fn log_file_receives_startup_lines() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let dir = tmp_dir("logfile");
    let log_path = dir.join("relay.log");
    let mut child = Command::new(env!("CARGO_BIN_EXE_sevyn-relay"))
        .arg("--bind")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--key-dir")
        .arg(&keys.dir)
        .arg("--daemon-sock")
        .arg(&daemon.path)
        .arg("--pidfile")
        .arg(dir.join("relay.pid"))
        .arg("--log-file")
        .arg(&log_path)
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    // Poll the log file for the listening line (the agent writes
    // the bound port there when --log-file is set).
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut found = false;
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(&log_path) {
            if text.contains("listening on 127.0.0.1:") {
                found = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(&dir);
    assert!(found, "--log-file never got the listening line");
}

#[test]
fn bind_is_required_and_missing_keys_fail_startup() {
    // No --bind: the agent refuses to start.
    let out = Command::new(env!("CARGO_BIN_EXE_sevyn-relay"))
        .arg("--port")
        .arg("0")
        .output()
        .unwrap();
    assert!(!out.status.success());

    // --bind given but no keypair on disk: startup fails.
    let empty = tmp_dir("empty-keys");
    let out = Command::new(env!("CARGO_BIN_EXE_sevyn-relay"))
        .arg("--bind")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--key-dir")
        .arg(&empty)
        .arg("--pidfile")
        .arg(empty.join("relay.pid"))
        .output()
        .unwrap();
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("relay-key"), "stderr: {stderr}");
}

#[test]
fn frame_request_round_trip_multi_chunk() {
    // A 200x200 PNG (~160 KB) arrives as frame-start + 11 chunks +
    // frame-end; the reassembled bytes are byte-identical to the
    // PNG the bridge wrote, with the sha256 from frame-start.
    let (cloud, keys, daemon, dir, bridge, statusd, screen_state) = frame_fixtures();
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &bridge.sock,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let (width, height, png) = client.recv_frame(Duration::from_secs(15));
    assert_eq!((width, height), (200, 200));
    assert_eq!(png, make_png(200, 200));
    // The SCREEN mark went on exactly once for the first frame, and
    // the state file carries the paired agent + session start +
    // frame count for `sevyn ai relay status` / Settings.
    thread::sleep(Duration::from_millis(200));
    let sets = statusd.recorded.lock().unwrap().clone();
    assert_eq!(sets, ["SET ai.screen on"], "statusd sets: {sets:?}");
    let state: Value = serde_json::from_str(&fs::read_to_string(&screen_state).unwrap()).unwrap();
    assert_eq!(state["screen"], "on");
    assert_eq!(state["frames"], 1);
    assert_eq!(
        state["agent"].as_str().unwrap().len(),
        16,
        "agent is the fp16"
    );
    assert!(state["session_start"].as_str().unwrap().ends_with('Z'));
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    // Session end: the mark goes off, the state file is removed,
    // and the agent log carries the frame count with via=relay.
    thread::sleep(Duration::from_millis(200));
    let sets = statusd.recorded.lock().unwrap().clone();
    assert_eq!(
        sets,
        ["SET ai.screen on", "SET ai.screen off"],
        "statusd sets: {sets:?}"
    );
    assert!(!screen_state.exists());
    assert!(
        agent.log_text().contains("ended frames=1 via=relay"),
        "agent log: {}",
        agent.log_text()
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}

#[test]
fn second_frame_updates_the_count_without_re_marking() {
    let (cloud, keys, daemon, dir, bridge, statusd, screen_state) = frame_fixtures();
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &bridge.sock,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let (_, _, _) = client.recv_frame(Duration::from_secs(15));
    thread::sleep(Duration::from_millis(1200)); // past the 1 s rate window
    client.send_frame_request("frame-2");
    let (_, _, _) = client.recv_frame(Duration::from_secs(15));
    thread::sleep(Duration::from_millis(200));
    // Still one SET on (no flicker), and the count is 2.
    let sets = statusd.recorded.lock().unwrap().clone();
    assert_eq!(sets, ["SET ai.screen on"], "statusd sets: {sets:?}");
    let state: Value = serde_json::from_str(&fs::read_to_string(&screen_state).unwrap()).unwrap();
    assert_eq!(state["frames"], 2);
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    assert!(
        agent.log_text().contains("ended frames=2 via=relay"),
        "agent log: {}",
        agent.log_text()
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}

#[test]
fn frame_request_rate_limited_within_one_second() {
    let (cloud, keys, daemon, dir, bridge, statusd, screen_state) = frame_fixtures();
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &bridge.sock,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let (_, _, _) = client.recv_frame(Duration::from_secs(15));
    // Inside the 1 s window: refused, never queued — the cloud
    // gets an explicit error for the request id.
    client.send_frame_request("frame-2");
    let err = client.next_frame(Duration::from_secs(10));
    assert_eq!(err["type"], "error");
    assert_eq!(err["id"], "frame-2");
    assert!(
        err["message"].as_str().unwrap().contains("rate limited"),
        "message: {}",
        err["message"]
    );
    // Past the window the same flow works again.
    thread::sleep(Duration::from_millis(1200));
    client.send_frame_request("frame-3");
    let (_, _, _) = client.recv_frame(Duration::from_secs(15));
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    assert!(
        agent.log_text().contains("ended frames=2 via=relay"),
        "agent log: {}",
        agent.log_text()
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}

#[test]
fn sensitive_refusal_sends_no_frame_and_no_stale_pixels() {
    // S3: the bridge refuses (sensitive surface on screen) while a
    // previous good frame sits at the path. The cloud gets an
    // explicit refusal for the request id — never the stale bytes —
    // the SCREEN mark never turns on, and the stale file is
    // untouched.
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let dir = tmp_dir("frames-refused");
    let bridge = FakeBridge::refusing(&dir, "refused: sensitive surface");
    fs::write(bridge.png_path.clone(), TINY_PNG).unwrap();
    let statusd = FakeStatusd::new(&dir);
    let screen_state = dir.join("relay-screen.json");
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &bridge.sock,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let err = client.next_frame(Duration::from_secs(10));
    assert_eq!(err["type"], "error");
    assert_eq!(err["id"], "frame-1");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("refused: sensitive surface"),
        "message: {}",
        err["message"]
    );
    assert!(
        statusd.recorded.lock().unwrap().is_empty(),
        "no ai.screen SET on a refusal"
    );
    assert!(!screen_state.exists());
    assert_eq!(fs::read(&bridge.png_path).unwrap(), TINY_PNG);
    assert!(
        agent.log_text().contains("refused: sensitive surface"),
        "agent log: {}",
        agent.log_text()
    );
    // The session survives the refusal: a task still runs.
    client.send_task("after", "still works");
    let end = client.next_frame(Duration::from_secs(10));
    assert_eq!(end["type"], "session-end");
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    assert!(
        agent.log_text().contains("ended frames=0 via=relay"),
        "agent log: {}",
        agent.log_text()
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}

#[test]
fn oversize_frame_is_refused() {
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let dir = tmp_dir("frames-big");
    // PNG magic + junk past the 1 MiB cap.
    let mut big = b"\x89PNG\r\n\x1a\n".to_vec();
    big.resize(1024 * 1024 + 1, 0x00);
    let bridge = FakeBridge::serving(&dir, big, 1, 1);
    let statusd = FakeStatusd::new(&dir);
    let screen_state = dir.join("relay-screen.json");
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &bridge.sock,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let err = client.next_frame(Duration::from_secs(10));
    assert_eq!(err["type"], "error");
    assert_eq!(err["id"], "frame-1");
    assert!(
        err["message"].as_str().unwrap().contains("1 MiB"),
        "message: {}",
        err["message"]
    );
    assert!(statusd.recorded.lock().unwrap().is_empty());
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}

#[test]
fn frame_request_without_a_compositor_is_an_explicit_error() {
    // No bridge socket at all (the m13 guest today: Weston boots,
    // not the Genesis compositor). The cloud gets an explicit
    // "capture unavailable" error — never a frame, never a hang.
    let cloud = cloud_keypair();
    let keys = KeyDir::new(Some(cloud.verifying_key().to_bytes()));
    let daemon = FakeDaemon::new(&keys.dir);
    let dir = tmp_dir("frames-nocomp");
    let missing = dir.join("no-such.sock");
    let statusd = FakeStatusd::new(&dir);
    let screen_state = dir.join("relay-screen.json");
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &missing,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let err = client.next_frame(Duration::from_secs(10));
    assert_eq!(err["type"], "error");
    assert_eq!(err["id"], "frame-1");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("capture unavailable"),
        "message: {}",
        err["message"]
    );
    assert!(statusd.recorded.lock().unwrap().is_empty());
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}

#[test]
fn view_only_the_agent_writes_no_frame_file() {
    // S4: the agent streams the PNG it read; it never writes a
    // frame file of its own. No *.png appears under the key dir or
    // the agent's own dir after a delivery.
    let (cloud, keys, daemon, dir, bridge, statusd, screen_state) = frame_fixtures();
    let agent = Agent::spawn_frames(
        &keys.dir,
        &daemon.path,
        &bridge.sock,
        &statusd.path,
        &screen_state,
        &[],
    );
    let client = Cloud::connect(agent.port, &cloud, true);
    client.send_frame_request("frame-1");
    let (_, _, _) = client.recv_frame(Duration::from_secs(15));
    client.send_bye();
    assert!(client.wait_closed(Duration::from_secs(5)));
    fn png_files(root: &PathBuf) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            if let Ok(entries) = fs::read_dir(&d) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().is_some_and(|x| x == "png") {
                        found.push(p);
                    }
                }
            }
        }
        found
    }
    assert!(
        png_files(&keys.dir).is_empty(),
        "agent wrote a PNG under the key dir"
    );
    assert!(
        png_files(&agent.dir).is_empty(),
        "agent wrote a PNG under its own dir"
    );
    // The only frame bytes on disk are the bridge's own file (the
    // compositor's single overwritten file, not the agent's).
    assert_eq!(fs::read(&bridge.png_path).unwrap(), make_png(200, 200));
    let _ = fs::remove_dir_all(&dir);
    let _ = keys;
}
