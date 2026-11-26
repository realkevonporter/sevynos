// sevyn-relay — the SevynOS AI relay agent (Phase 2).
//
// Listens on the tailnet interface (or loopback for tests) for one
// cloud-agent connection at a time, authenticates it (Ed25519 +
// ephemeral X25519, HKDF-SHA256, ChaCha20-Poly1305 sealed frames),
// and forwards its tasks to the AI daemon over /run/sevyn-ai.sock
// as SESSION lines, replying with the daemon's final counts.
// Started by init when /data/ai/relay-agent.json exists, and by
// `sevyn ai relay on`. See ~/workspace/sevynos-ai-relay/phase2/
// INTERFACES.md for the contract.

use std::fs;
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

use sevyn_relay::log::{init_file, log};
use sevyn_relay::logf;
use sevyn_relay::session::{handle_connection, DeviceIdentity, Timers};

const DEFAULT_PORT: u16 = 17893;
const DEFAULT_KEY_DIR: &str = "/data/ai";
const DEFAULT_DAEMON_SOCK: &str = "/run/sevyn-ai.sock";
const DEFAULT_PIDFILE: &str = "/run/sevyn-relay.pid";
/// How long to keep retrying the bind (init may start the agent
/// before the tailnet is up).
const BIND_RETRY_SECS: u64 = 60;

struct Args {
    bind: String,
    port: u16,
    key_dir: PathBuf,
    daemon_sock: PathBuf,
    pidfile: PathBuf,
    log_file: Option<String>,
    idle_timeout_secs: u64,
    max_session_secs: u64,
    heartbeat_secs: u64,
}

fn usage() -> &'static str {
    "sevyn-relay --bind <ip> [--port 17893] [--key-dir /data/ai] \
     [--daemon-sock /run/sevyn-ai.sock] [--pidfile /run/sevyn-relay.pid] \
     [--log-file <path>] [--idle-timeout-secs 900] \
     [--max-session-secs 14400] [--heartbeat-secs 30]"
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut args = Args {
        bind: String::new(),
        port: DEFAULT_PORT,
        key_dir: PathBuf::from(DEFAULT_KEY_DIR),
        daemon_sock: PathBuf::from(DEFAULT_DAEMON_SOCK),
        pidfile: PathBuf::from(DEFAULT_PIDFILE),
        log_file: None,
        idle_timeout_secs: 900,
        max_session_secs: 14_400,
        heartbeat_secs: 30,
    };
    let mut i = 1;
    while i < argv.len() {
        let flag = &argv[i];
        let take = |i: &mut usize| -> Result<String, String> {
            *i += 1;
            argv.get(*i)
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag.as_str() {
            "--bind" => args.bind = take(&mut i)?,
            "--port" => {
                args.port = take(&mut i)?
                    .parse()
                    .map_err(|_| "--port needs a number".to_string())?
            }
            "--key-dir" => args.key_dir = PathBuf::from(take(&mut i)?),
            "--daemon-sock" => args.daemon_sock = PathBuf::from(take(&mut i)?),
            "--pidfile" => args.pidfile = PathBuf::from(take(&mut i)?),
            "--log-file" => args.log_file = Some(take(&mut i)?),
            "--idle-timeout-secs" => {
                args.idle_timeout_secs = take(&mut i)?
                    .parse()
                    .map_err(|_| "--idle-timeout-secs needs a number".to_string())?
            }
            "--max-session-secs" => {
                args.max_session_secs = take(&mut i)?
                    .parse()
                    .map_err(|_| "--max-session-secs needs a number".to_string())?
            }
            "--heartbeat-secs" => {
                args.heartbeat_secs = take(&mut i)?
                    .parse()
                    .map_err(|_| "--heartbeat-secs needs a number".to_string())?
            }
            "--help" | "-h" => return Err("help".to_string()),
            other => return Err(format!("unknown argument: {other}")),
        }
        i += 1;
    }
    if args.bind.is_empty() {
        return Err("--bind <ip> is required (tailnet IP, or 127.0.0.1 for tests)".to_string());
    }
    Ok(args)
}

/// Resets the one-connection guard when the session thread ends.
struct SessionGuard(Arc<AtomicBool>);

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn bind_with_retry(addr: SocketAddr) -> Result<TcpListener, String> {
    let deadline = Instant::now() + Duration::from_secs(BIND_RETRY_SECS);
    loop {
        match TcpListener::bind(addr) {
            Ok(l) => return Ok(l),
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(format!("cannot bind {addr} after {BIND_RETRY_SECS}s: {e}"));
                }
                logf!("bind {addr} failed ({e}), retrying");
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

fn run() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().collect();
    let args = parse_args(&argv).map_err(|e| {
        if e == "help" {
            eprintln!("usage: {}", usage());
            std::process::exit(0);
        }
        format!("{e}\nusage: {}", usage())
    })?;

    if let Some(path) = &args.log_file {
        init_file(path).map_err(|e| format!("cannot open log file {path}: {e}"))?;
    }

    let identity = DeviceIdentity::load(&args.key_dir)?;
    logf!(
        "starting, device {}",
        sevyn_relay::crypto::device_id(&identity.public_key)
    );
    // Log-only read: the auth path re-reads the pin per
    // connection (see session.rs), so this snapshot is never used
    // to decide a handshake.
    match sevyn_relay::crypto::load_pinned_peer(&args.key_dir) {
        Ok(Some(_)) => logf!("cloud-agent key pinned"),
        Ok(None) => logf!("unpaired (no relay-peer.pub)"),
        Err(e) => logf!("unpaired (cannot read pin: {e})"),
    }

    fs::write(&args.pidfile, format!("{}\n", std::process::id()))
        .map_err(|e| format!("cannot write pidfile {}: {e}", args.pidfile.display()))?;

    let addr: SocketAddr = format!("{}:{}", args.bind, args.port)
        .parse()
        .map_err(|e| format!("bad --bind/--port: {e}"))?;
    let listener = bind_with_retry(addr)?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    logf!("listening on {bound}");

    let timers = Timers {
        idle_timeout: Duration::from_secs(args.idle_timeout_secs),
        max_session: Duration::from_secs(args.max_session_secs),
        heartbeat: Duration::from_secs(args.heartbeat_secs),
    };
    let identity = Arc::new(identity);
    let session_active = Arc::new(AtomicBool::new(false));

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                logf!("accept failed: {e}");
                continue;
            }
        };
        // One cloud-agent connection at a time: a second connection
        // while one is live is refused (closed, logged).
        if session_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            let peer = stream
                .peer_addr()
                .map(|a| a.to_string())
                .unwrap_or_else(|_| "?".to_string());
            logf!("refusing second connection from {peer} (session already live)");
            drop(stream);
            continue;
        }
        let guard = SessionGuard(Arc::clone(&session_active));
        let identity = Arc::clone(&identity);
        let key_dir = args.key_dir.clone();
        let daemon_sock = args.daemon_sock.clone();
        thread::spawn(move || {
            let _guard = guard;
            handle_connection(stream, &identity, &key_dir, &daemon_sock, timers);
        });
    }
    Err("listener closed".to_string())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // The logger may not be initialised yet if arg parsing
            // failed, so print to stderr directly as well.
            eprintln!("RELAY fatal: {e}");
            log(&format!("fatal: {e}"));
            ExitCode::FAILURE
        }
    }
}
