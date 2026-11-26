#!/usr/bin/env python3
"""Host-side tests for the M5 `sevyn` CLI verbs (v2/update/sevyn.c):
`browser` (Chromium over CDP), `net` (link state, DNS, announce),
and `settings` (wallpaperStyle / wallpaperColor round-trip).

Builds the CLI with the host gcc, then drives it against a FAKE CDP
server (an HTTP server that records requests and replies like
Chromium's DevTools endpoint: /json/version, /json/list, PUT
/json/new, /json/activate/<id>, /json/close/<id>) and a FAKE statusd
(a Unix socket server that records SET lines and answers GET with
canned STATUS values). No QEMU, no Chromium — the CI harness
(m5-check) covers the guest end to end. A warm `browser open`
relaunches Chromium with --app=<url> (no PUT /json/new): /json/new
opens the new tab in a NEW top-level window, and Chrome makes that
window a normal browser window (tab strip + omnibox), not an --app
window — so the relaunch is what keeps every navigation chromeless.

Run: python3 v2/update/test-browser.py
Exit 0 = all checks pass.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEVYN_C = HERE / "sevyn.c"

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok: {name}")
    else:
        print(f"FAIL: {name} {detail}")
        FAILURES.append(name)


# --- fake CDP server ----------------------------------------------------

_INITIAL_TABS = [
    {
        "description": "",
        "devtoolsFrontendUrl": "/devtools/inspector.html?ws=127.0.0.1:1/devtools/page/AAA",
        "id": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "title": "SevynOS M5 Test Page",
        "type": "page",
        "url": "http://10.0.2.2:18080/m5-page.html",
        "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/AAA",
    },
    {
        "description": "",
        "devtoolsFrontendUrl": "/devtools/inspector.html?ws=127.0.0.1:1/devtools/page/BBB",
        "id": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "title": "Example Domain",
        "type": "page",
        "url": "https://example.com/",
        "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/BBB",
    },
    {
        "description": "",
        "devtoolsFrontendUrl": "",
        "id": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        "title": "Omnibox Popup",
        "type": "browser_ui",
        "url": "chrome://omnibox-popup.top-chrome/",
        "webSocketDebuggerUrl": "",
    },
]

# The live tab list: /json/close really removes a tab and PUT
# /json/new really adds one, so the tests can assert the tab list
# afterwards (M13 warm open leaves exactly one page tab).
TABS = [dict(t) for t in _INITIAL_TABS]

REQUESTS = []  # (method, path) in arrival order


class CDPHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):  # keep test output clean
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        REQUESTS.append(("GET", self.path))
        if self.path == "/json/version":
            self._send_json(200, {"Browser": "Chrome/159.0.8150.0",
                                  "Protocol-Version": "1.3"})
        elif self.path == "/json/list":
            self._send_json(200, TABS)
        elif self.path.startswith("/json/activate/"):
            tab = self.path.split("/")[-1]
            if any(t["id"] == tab for t in TABS):
                self._send_json(200, {})
            else:
                self.send_response(404)
                self.end_headers()
        elif self.path.startswith("/json/close/"):
            tab = self.path.split("/")[-1]
            if any(t["id"] == tab for t in TABS):
                TABS[:] = [t for t in TABS if t["id"] != tab]
                self._send_json(200, {})
            else:
                self.send_response(404)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_PUT(self):
        REQUESTS.append(("PUT", self.path))
        if self.path.startswith("/json/new?"):
            url = self.path[len("/json/new?"):]
            tab = {
                "description": "",
                "devtoolsFrontendUrl": "",
                "id": "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
                "title": "New Tab",
                "type": "page",
                "url": url,
                "webSocketDebuggerUrl": "",
            }
            TABS[:] = [t for t in TABS if t["id"] != tab["id"]]
            TABS.append(tab)
            self._send_json(200, tab)
        else:
            self.send_response(405)
            self.end_headers()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# --- fake statusd --------------------------------------------------------

class FakeStatusd(threading.Thread):
    """Unix socket server: answers GET with canned STATUS lines and
    records every SET line it receives."""

    def __init__(self, path):
        super().__init__(daemon=True)
        self.path = path
        self.recorded_lines = []
        self.lock = threading.Lock()
        self.stop = False
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(path)
        self.sock.listen(4)
        self.sock.settimeout(0.2)

    def recorded(self):
        with self.lock:
            return list(self.recorded_lines)

    def run(self):
        while not self.stop:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn.settimeout(5)
            buf = b""
            try:
                while b"\n" not in buf:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                line = buf.decode(errors="replace").strip()
                if line == "GET":
                    conn.sendall(b"STATUS battery unknown\n"
                                 b"STATUS wifi on\n"
                                 b"STATUS volume 50\n")
                elif line.startswith("SET "):
                    with self.lock:
                        self.recorded_lines.append(line)
            except OSError:
                pass
            finally:
                conn.close()

    def close(self):
        self.stop = True
        try:
            self.sock.close()
        except OSError:
            pass
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


def _pid_gone(pid):
    """True when pid no longer exists, or is a zombie (dead but not
    yet reaped by its parent — kill(pid, 0) still answers for a
    zombie, so /proc is the arbiter)."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            state = f.read().rsplit(") ", 1)[-1].split()[0]
        return state == "Z"
    except FileNotFoundError:
        return True
    except OSError:
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def _wait_for_argv(log_path, timeout=5.0):
    """Lines the recording fake wrote, waiting for them: the CLI
    never waits for the launched Chromium (it only reaps the
    intermediate child), and a fast CDP answer lets the CLI exit
    before a short-lived fake has finished starting up."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if log_path.exists():
            lines = log_path.read_text().splitlines()
            if lines:
                return lines
        time.sleep(0.05)
    return log_path.read_text().splitlines() if log_path.exists() else []


def run_cli(binary, args, env_extra):
    env = dict(os.environ)
    env.update(env_extra)
    r = subprocess.run([str(binary)] + args, capture_output=True,
                       text=True, timeout=60, env=env)
    return r


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-browser-test-"))
    binary = tmp / "sevyn"
    # gcc writes its temp files under TMPDIR; point it at the test's
    # own temp dir so the build works even where /tmp is small/full
    # (the sandbox's /tmp is a 512 MB tmpfs).
    build_env = dict(os.environ)
    build_env["TMPDIR"] = str(tmp)
    build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(binary),
         str(SEVYN_C), "-lcrypto"],
        capture_output=True, text=True, env=build_env)
    check("sevyn.c compiles clean", build.returncode == 0, build.stderr)
    if build.returncode != 0:
        print("FAILURES:", FAILURES)
        return 1

    # Fake CDP on a free port.
    port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), CDPHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {"SEVYN_CDP_PORT": str(port)}

    # --- browser status / tabs (Chromium "running") ---
    r = run_cli(binary, ["browser", "status"], env)
    check("browser status: exit 0 when CDP answers", r.returncode == 0, r.stderr)
    check("browser status: running yes", "running: yes" in r.stdout, r.stdout)
    check("browser status: cdp yes", "cdp: yes" in r.stdout, r.stdout)
    check("browser status: 2 page tabs (browser_ui excluded)",
          "tabs: 2" in r.stdout, r.stdout)
    check("browser status: version from /json/version",
          "version: Chrome/159.0.8150.0" in r.stdout, r.stdout)

    r = run_cli(binary, ["browser", "tabs"], env)
    check("browser tabs: exit 0", r.returncode == 0, r.stderr)
    lines = [l for l in r.stdout.splitlines() if l.startswith("TAB ")]
    check("browser tabs: 2 TAB lines", len(lines) == 2, r.stdout)
    check("browser tabs: first tab id/title/url tab-separated",
          lines and lines[0].startswith("TAB AAAA") and
          "\tSevynOS M5 Test Page\t" in lines[0], lines[0] if lines else "")
    check("browser tabs: browser_ui target excluded",
          "Omnibox" not in r.stdout, r.stdout)

    # --- browser open (Chromium already running: relaunch) ---
    # M13 is single-tab by design, and a warm open relaunches
    # Chromium with --app=<url> instead of PUT /json/new: /json/new
    # opens the new tab in a NEW top-level window, and Chrome makes
    # that window a NORMAL browser window (tab strip + omnibox) —
    # not an --app window — so after one navigation the user had a
    # full second Chrome (GF65, 6b3689a). The relaunch keeps every
    # navigation chromeless. The contract: the old Chromium (pid in
    # the state file) is SIGTERMed, the new launch carries
    # --app=<url>, and no PUT /json/new is issued. The fake CDP
    # server keeps answering throughout (it is not the Chromium
    # process), so the CLI's wait succeeds at once.
    # A double-forked dummy stands in for the running Chromium: its
    # child is reparented to init, so init reaps it on SIGTERM and
    # the CLI's exit wait sees it go promptly.
    dummy = tmp / "dummy-chromium.py"
    dummy.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys, time\n"
        "pid = os.fork()\n"
        "if pid > 0:\n"
        "    sys.exit(0)\n"
        "os.setsid()\n"
        "with open(os.environ['DUMMY_PID_FILE'], 'w') as f:\n"
        "    f.write(str(os.getpid()))\n"
        "# Close the inherited pipes so the parent's wait returns.\n"
        "devnull = os.open('/dev/null', os.O_RDWR)\n"
        "for fd in (0, 1, 2):\n"
        "    os.dup2(devnull, fd)\n"
        "time.sleep(60)\n")
    os.chmod(dummy, 0o755)
    rec = tmp / "fake-chromium-record.py"
    rec.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "log = os.environ.get('FAKE_ARGV_LOG', '')\n"
        "if log:\n"
        "    with open(log, 'a') as f:\n"
        "        f.write(json.dumps(sys.argv[1:]) + '\\n')\n")
    os.chmod(rec, 0o755)
    argv_log = tmp / "argv.log"
    state_path = tmp / "chromium.state"
    warm_env = dict(env)
    warm_env["SEVYN_CHROMIUM_BIN"] = str(rec)
    warm_env["SEVYN_CHROMIUM_STATE"] = str(state_path)
    warm_env["FAKE_ARGV_LOG"] = str(argv_log)
    warm_env["SEVYN_CDP_WAIT_S"] = "6"
    # Round 12: the tab list holds ONLY the stale local tab. The
    # example.com tab must NOT already be open here: with the
    # trailing-slash fix, `browser open https://example.com` is
    # idempotent when its tab (canonical URL "https://example.com/")
    # is already listed, so a fixture containing it would take the
    # idempotent path and never relaunch. The already-open case is
    # the idempotent test below; this one is the relaunch path.
    TABS[:] = [dict(_INITIAL_TABS[0])]
    REQUESTS.clear()
    if argv_log.exists():
        argv_log.unlink()
    proc = subprocess.run(
        [sys.executable, str(dummy)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        env={**os.environ,
             "DUMMY_PID_FILE": str(tmp / "dummy.pid")})
    deadline = time.time() + 5
    dummy_pid = None
    while time.time() < deadline:
        try:
            dummy_pid = int((tmp / "dummy.pid").read_text().strip())
            break
        except (FileNotFoundError, ValueError):
            time.sleep(0.05)
    check("browser open: dummy Chromium started",
          dummy_pid is not None, "")
    if dummy_pid is None:
        print("FAILURES:", FAILURES)
        return 1
    state_path.write_text(f"pid={dummy_pid}\ngpu=yes\n")
    try:
        r = run_cli(binary, ["browser", "open", "https://example.com"],
                    warm_env)
    finally:
        # Never leave the dummy behind if the stop failed.
        try:
            os.kill(dummy_pid, 9)
        except OSError:
            pass
    check("browser open: exit 0", r.returncode == 0, r.stderr)
    check("browser open: prints opened",
          "opened: https://example.com" in r.stdout, r.stdout)
    check("browser open: no PUT /json/new on a warm open",
          ("PUT", "/json/new?https://example.com") not in REQUESTS,
          str(REQUESTS))
    check("browser open: old Chromium pid is dead after the stop",
          _pid_gone(dummy_pid), f"pid {dummy_pid} still alive")
    argv_lines = _wait_for_argv(argv_log)
    check("browser open: relaunch carries --app=<url>",
          len(argv_lines) == 1 and
          "--app=https://example.com" in json.loads(argv_lines[0]),
          str(argv_lines))
    check("browser open: warm open closes the stale local tab",
          ("GET", "/json/close/" + "A" * 32) in REQUESTS,
          str(REQUESTS))

    # Bare hostname gets https:// prepended — and also relaunches.
    REQUESTS.clear()
    argv_log.unlink(missing_ok=True)
    r = run_cli(binary, ["browser", "open", "example.com"], warm_env)
    argv_lines = _wait_for_argv(argv_log)
    check("browser open: bare hostname normalized to https on relaunch",
          len(argv_lines) == 1 and
          "--app=https://example.com" in json.loads(argv_lines[0]),
          str(argv_lines))

    # --- browser open: SIGTERM-resistant Chromium is SIGKILLed ---
    # A Chromium that ignores SIGTERM (a starting Chromium under
    # TCG can take longer than the grace to shut down) must still
    # be gone after the open: the stop escalates to SIGKILL and
    # verifies the pid is gone (zombie-aware) before relaunching.
    # The contract: the dummy pid is gone, the relaunch still
    # carries --app=<url>, and the open returns "opened:".
    dummy_term = tmp / "dummy-chromium-ignore-term.py"
    dummy_term.write_text(
        "#!/usr/bin/env python3\n"
        "import os, signal, sys, time\n"
        "pid = os.fork()\n"
        "if pid > 0:\n"
        "    sys.exit(0)\n"
        "os.setsid()\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "with open(os.environ['DUMMY_PID_FILE'], 'w') as f:\n"
        "    f.write(str(os.getpid()))\n"
        "devnull = os.open('/dev/null', os.O_RDWR)\n"
        "for fd in (0, 1, 2):\n"
        "    os.dup2(devnull, fd)\n"
        "time.sleep(60)\n")
    os.chmod(dummy_term, 0o755)
    term_pid_file = tmp / "dummy-term.pid"
    proc = subprocess.run(
        [sys.executable, str(dummy_term)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        env={**os.environ, "DUMMY_PID_FILE": str(term_pid_file)})
    deadline = time.time() + 5
    term_pid = None
    while time.time() < deadline:
        try:
            term_pid = int(term_pid_file.read_text().strip())
            break
        except (FileNotFoundError, ValueError):
            time.sleep(0.05)
    check("browser open: SIGTERM-resistant dummy started",
          term_pid is not None, "")
    if term_pid is None:
        print("FAILURES:", FAILURES)
        return 1
    # Round 12: local tab only (see the warm-open fixture note
    # above — an already-open example.com tab would make this
    # idempotent instead of a relaunch).
    TABS[:] = [dict(_INITIAL_TABS[0])]
    REQUESTS.clear()
    if argv_log.exists():
        argv_log.unlink()
    state_path.write_text(f"pid={term_pid}\ngpu=yes\n")
    try:
        r = run_cli(binary, ["browser", "open", "https://example.com"],
                    warm_env)
    finally:
        # Never leave the dummy behind if the stop failed.
        try:
            os.kill(term_pid, 9)
        except OSError:
            pass
    check("browser open: SIGTERM-resistant Chromium is gone after open",
          _pid_gone(term_pid), f"pid {term_pid} still alive")
    check("browser open: SIGTERM-resistant open exits 0 + opened",
          r.returncode == 0 and "opened: https://example.com" in r.stdout,
          r.stdout + r.stderr)
    argv_lines = _wait_for_argv(argv_log)
    check("browser open: SIGTERM-resistant relaunch carries --app=<url>",
          len(argv_lines) == 1 and
          "--app=https://example.com" in json.loads(argv_lines[0]),
          str(argv_lines))

    # --- browser open: idempotent when the URL is already open ---
    # A re-go / retry for a URL the running tab already shows must
    # return that tab, not relaunch: the tab is already there, and
    # a relaunch while the instance is up just churns the window
    # (and, if the instance is still starting, a duplicate launch
    # hands off and accumulates a tab). The contract: exit 0,
    # "opened:" + the existing tab, NO launch (argv.log empty),
    # the running Chromium stays alive, and no PUT /json/new.
    # Round 12: the running tab's URL is the CANONICAL one
    # ("https://example.com/" — what real Chromium reports for a
    # bare-host URL), and a stale local tab sits beside it. The
    # idempotent open must match the canonical URL (not relaunch),
    # and the single-tab enforcement must close the stale tab while
    # keeping the just-opened one. With the old exact-strcmp
    # comparison the canonical URL never matched: the open
    # relaunched instead of returning, and the enforcement closed
    # the example.com tab itself — every example.com open stalled
    # with zero tabs (M5/M13 round 11).
    TABS[:] = [dict(_INITIAL_TABS[0]), {
        "description": "",
        "devtoolsFrontendUrl": "",
        "id": "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
        "title": "Example Domain",
        "type": "page",
        "url": "https://example.com/",
        "webSocketDebuggerUrl": "",
    }]
    REQUESTS.clear()
    if argv_log.exists():
        argv_log.unlink()
    idem_pid_file = tmp / "dummy-idem.pid"
    proc = subprocess.run(
        [sys.executable, str(dummy)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        env={**os.environ, "DUMMY_PID_FILE": str(idem_pid_file)})
    deadline = time.time() + 5
    idem_pid = None
    while time.time() < deadline:
        try:
            idem_pid = int(idem_pid_file.read_text().strip())
            break
        except (FileNotFoundError, ValueError):
            time.sleep(0.05)
    check("browser open: idempotent dummy started",
          idem_pid is not None, "")
    if idem_pid is None:
        print("FAILURES:", FAILURES)
        return 1
    state_path.write_text(f"pid={idem_pid}\ngpu=yes\n")
    try:
        r = run_cli(binary, ["browser", "open", "https://example.com"],
                    warm_env)
    finally:
        try:
            os.kill(idem_pid, 9)
        except OSError:
            pass
    check("browser open: idempotent open exits 0 + opened + tab id",
          r.returncode == 0 and "opened: https://example.com" in r.stdout
          and "tab: " + "E" * 32 in r.stdout,
          r.stdout + r.stderr)
    check("browser open: idempotent open issues no PUT /json/new",
          ("PUT", "/json/new?https://example.com") not in REQUESTS,
          str(REQUESTS))
    check("browser open: idempotent open launches nothing",
          not argv_log.exists() or not argv_log.read_text().strip(),
          argv_log.read_text() if argv_log.exists() else "")
    check("browser open: idempotent open leaves Chromium alive",
          not _pid_gone(idem_pid), f"pid {idem_pid} is gone")
    check("browser open: idempotent open closes the stale local tab",
          ("GET", "/json/close/" + "A" * 32) in REQUESTS,
          str(REQUESTS))
    check("browser open: idempotent open keeps the canonical-URL tab",
          ("GET", "/json/close/" + "E" * 32) not in REQUESTS
          and any(t["id"] == "E" * 32 for t in TABS),
          str(REQUESTS) + " / " + str([t["id"] for t in TABS]))

    # --- browser open: no duplicate launch while Chromium starts ---
    # CDP is down but a Chromium process is alive (a launch already
    # in flight — a cold start under TCG takes ~13 s). Launching a
    # duplicate here hands off to the in-flight instance and
    # accumulates a tab per open (m13: tabs 1→2→3→4). The contract:
    # the CLI waits briefly for CDP, then returns "launched:"
    # without launching a duplicate (argv.log empty) and without
    # killing the in-flight instance.
    starting = tmp / "fake-chromium-starting.py"
    starting.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys, time\n"
        "pid = os.fork()\n"
        "if pid > 0:\n"
        "    sys.exit(0)\n"
        "os.setsid()\n"
        "with open(os.environ['STARTING_PID_FILE'], 'w') as f:\n"
        "    f.write(str(os.getpid()))\n"
        "devnull = os.open('/dev/null', os.O_RDWR)\n"
        "for fd in (0, 1, 2):\n"
        "    os.dup2(devnull, fd)\n"
        "time.sleep(60)\n")
    os.chmod(starting, 0o755)
    start_port = free_port()  # nothing listening: CDP down
    start_pid_file = tmp / "starting.pid"
    proc = subprocess.run(
        [sys.executable, str(starting),
         f"--remote-debugging-port={start_port}",
         "--user-data-dir=" + str(tmp / "chromium-profile"),
         "--app=https://example.com"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        env={**os.environ, "STARTING_PID_FILE": str(start_pid_file)})
    deadline = time.time() + 5
    start_pid = None
    while time.time() < deadline:
        try:
            start_pid = int(start_pid_file.read_text().strip())
            break
        except (FileNotFoundError, ValueError):
            time.sleep(0.05)
    check("browser open: starting Chromium started",
          start_pid is not None, "")
    if start_pid is None:
        print("FAILURES:", FAILURES)
        return 1
    start_env = {"SEVYN_CDP_PORT": str(start_port),
                 "SEVYN_CHROMIUM_BIN": str(rec),
                 "SEVYN_CHROMIUM_STATE": str(state_path),
                 "SEVYN_CDP_WAIT_S": "6",
                 "FAKE_ARGV_LOG": str(argv_log)}
    state_path.write_text(f"pid={start_pid}\ngpu=yes\n")
    if argv_log.exists():
        argv_log.unlink()
    t0 = time.time()
    try:
        r = run_cli(binary, ["browser", "open", "https://example.com"],
                    start_env)
    finally:
        try:
            os.kill(start_pid, 9)
        except OSError:
            pass
    dt = time.time() - t0
    check("browser open: starting instance returns launched (exit 0)",
          r.returncode == 0 and "launched: https://example.com" in r.stdout,
          r.stdout + r.stderr)
    check("browser open: no duplicate launch while starting",
          not argv_log.exists() or not argv_log.read_text().strip(),
          argv_log.read_text() if argv_log.exists() else "")
    check("browser open: starting instance is not killed",
          not _pid_gone(start_pid), f"pid {start_pid} is gone")
    check("browser open: starting-instance wait bounded (~2 s)",
          dt < 8, f"took {dt:.1f}s")

    # --- browser activate / close ---
    # (Reset the tab list: the `browser close` check above removed
    # BBBB from the fake.)
    TABS[:] = [dict(t) for t in _INITIAL_TABS]
    r = run_cli(binary, ["browser", "activate",
                         "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"], env)
    check("browser activate: exit 0 + prints id",
          r.returncode == 0 and
          "activated: AAAA" in r.stdout, r.stdout + r.stderr)
    r = run_cli(binary, ["browser", "activate", "NOPE"], env)
    check("browser activate: unknown id exits 1",
          r.returncode == 1, r.stdout + r.stderr)
    r = run_cli(binary, ["browser", "close",
                         "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"], env)
    check("browser close: exit 0 + prints id",
          r.returncode == 0 and "closed: BBBB" in r.stdout,
          r.stdout + r.stderr)

    # --- browser status when CDP is down ---
    dead = dict(env)
    dead["SEVYN_CDP_PORT"] = str(free_port())  # nothing listening
    r = run_cli(binary, ["browser", "status"], dead)
    check("browser status: exit 1 + running no when CDP down",
          r.returncode == 1 and "running: no" in r.stdout,
          r.stdout + r.stderr)
    r = run_cli(binary, ["browser", "tabs"], dead)
    check("browser tabs: exit 1 when CDP down", r.returncode == 1)

    # --- browser open launches Chromium when it is not running ---
    # The "binary" is /bin/true: it exits at once, so CDP never
    # answers. The launch must return promptly with "launched:"
    # (exit 0) — the CLI cannot know whether Chromium is just slow,
    # so the failure is observable via `browser status` afterwards,
    # not via the open itself. (The old contract returned exit 1 +
    # "did not answer CDP" after the wait; that blocked the caller
    # under the host's 10 s exec timeout on every cold start.)
    launch_env = dict(dead)
    launch_env["SEVYN_CHROMIUM_BIN"] = "/bin/true"
    launch_env["SEVYN_CDP_WAIT_S"] = "2"
    t0 = time.time()
    r = run_cli(binary, ["browser", "open", "https://example.com"],
                launch_env)
    dt = time.time() - t0
    check("browser open: slow start returns launched (exit 0)",
          r.returncode == 0 and "launched: https://example.com" in r.stdout,
          r.stdout + r.stderr)
    check("browser open: launch wait bounded (~2 s, not 60)",
          dt < 10, f"took {dt:.1f}s")
    r = run_cli(binary, ["browser", "status"], launch_env)
    check("browser status: still running no after a failed launch",
          r.returncode == 1 and "running: no" in r.stdout,
          r.stdout + r.stderr)

    # --- browser open: CDP comes up DURING the wait (slow start) ---
    # A fake Chromium that sleeps 1 s, then serves CDP on the port
    # from SEVYN_CDP_PORT, with the launched URL as its only tab.
    # `browser open` must return "opened:" + that tab's id — this is
    # the path the check relies on for a fast start, and it exercises
    # the find-tab-by-URL lookup. The fake exits on its own after
    # 15 s so no process lingers.
    fake_chromium = tmp / "fake-chromium.py"
    fake_chromium.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, socket, sys, threading, time\n"
        "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n"
        "port = int(os.environ.get('SEVYN_CDP_PORT', '9222'))\n"
        "# M13: the URL rides in --app=<url> (chromeless launch),\n"
        "# never positionally — fall back to argv[-1] for the plain\n"
        "# about:blank launch, whose last arg is --user-data-dir.\n"
        "url = next((a[6:] for a in sys.argv[1:]\n"
        "            if a.startswith('--app=')),\n"
        "           sys.argv[-1] if len(sys.argv) > 1 else 'about:blank')\n"
        "# FAKE_CDP_MODE=silent: bind the port, accept connections,\n"
        "# and never respond — the bound-but-silent CDP server\n"
        "# (m13(a)). The CLI's wait must stay wall-clock bounded\n"
        "# against it; the fake exits on its own after 15 s.\n"
        "if os.environ.get('FAKE_CDP_MODE') == 'silent':\n"
        "    s = socket.socket()\n"
        "    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
        "    s.bind(('127.0.0.1', port))\n"
        "    s.listen(16)\n"
        "    s.settimeout(0.5)\n"
        "    conns = []\n"
        "    end = time.time() + 15\n"
        "    while time.time() < end:\n"
        "        try:\n"
        "            c, _ = s.accept()\n"
        "            conns.append(c)\n"
        "        except socket.timeout:\n"
        "            pass\n"
        "    sys.exit(0)\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    protocol_version = 'HTTP/1.0'\n"
        "    def log_message(self, *a): pass\n"
        "    def _j(self, code, obj):\n"
        "        body = json.dumps(obj).encode()\n"
        "        self.send_response(code)\n"
        "        self.send_header('Content-Type', 'application/json')\n"
        "        self.send_header('Content-Length', str(len(body)))\n"
        "        self.end_headers()\n"
        "        self.wfile.write(body)\n"
        "    def do_GET(self):\n"
        "        if self.path == '/json/version':\n"
        "            self._j(200, {'Browser': 'Chrome/159.0.8150.0'})\n"
        "        elif self.path == '/json/list':\n"
        "            self._j(200, [{'id': 'E' * 32, 'title': 'Delayed Page',\n"
        "                           'type': 'page', 'url': url}])\n"
        "        else:\n"
        "            self.send_response(404); self.end_headers()\n"
        "time.sleep(1)\n"
        "srv = ThreadingHTTPServer(('127.0.0.1', port), H)\n"
        "threading.Thread(target=srv.serve_forever, daemon=True).start()\n"
        "time.sleep(15)\n")
    os.chmod(fake_chromium, 0o755)
    slow_port = free_port()
    slow_env = {"SEVYN_CDP_PORT": str(slow_port),
                "SEVYN_CHROMIUM_BIN": str(fake_chromium),
                "SEVYN_CDP_WAIT_S": "10"}
    t0 = time.time()
    r = run_cli(binary, ["browser", "open", "https://example.com"],
                slow_env)
    dt = time.time() - t0
    check("browser open: CDP up during wait returns opened + tab",
          r.returncode == 0 and "opened: https://example.com" in r.stdout
          and "tab: " + "E" * 32 in r.stdout,
          r.stdout + r.stderr)
    check("browser open: slow-start wait bounded (~1 s, not the full 10)",
          dt < 10, f"took {dt:.1f}s")

    # --- browser open: CDP port bound but silent (m13(a)) ---
    # The fake binds the port, accepts connections, and never
    # responds. The old wait loop's 5 s probe timeout made
    # wait_for_cdp(3) take ~15 s and the host killed the CLI at
    # 10 s. The wait is wall-clock bounded now: the whole cold
    # open (GPU attempt + fallback, SEVYN_CDP_WAIT_S=2) must finish
    # well inside 10 s and print "launched:".
    silent_port = free_port()
    silent_env = {"SEVYN_CDP_PORT": str(silent_port),
                  "SEVYN_CHROMIUM_BIN": str(fake_chromium),
                  "SEVYN_CDP_WAIT_S": "2",
                  "FAKE_CDP_MODE": "silent",
                  "SEVYN_CHROMIUM_STATE": str(tmp / "chromium.state")}
    t0 = time.time()
    r = run_cli(binary, ["browser", "open", "https://example.com"],
                silent_env)
    dt = time.time() - t0
    check("browser open: silent CDP port returns launched (exit 0)",
          r.returncode == 0 and "launched: https://example.com" in r.stdout,
          r.stdout + r.stderr)
    check("browser open: silent-CDP wait bounded (< 8 s)",
          dt < 8, f"took {dt:.1f}s")

    # --- net ---
    r = run_cli(binary, ["net", "status"], {})
    check("net status: exit 0", r.returncode == 0, r.stderr)
    for field in ("interface: ", "address: ", "gateway: ", "dns: ",
                  "wifi: "):
        check(f"net status: prints {field.strip()}", field in r.stdout,
              r.stdout)
    r = run_cli(binary, ["net", "dns", "localhost"], {})
    check("net dns: localhost resolves to 127.0.0.1",
          r.returncode == 0 and r.stdout.strip() == "localhost 127.0.0.1",
          r.stdout + r.stderr)
    # (The sandbox resolver answers every name — wildcard — so an
    # unresolvable name is not a portable negative test; an invalid
    # hostname with a space fails in getaddrinfo before any resolver
    # is consulted.)
    r = run_cli(binary, ["net", "dns", "not a host"], {})
    check("net dns: invalid hostname exits 1", r.returncode == 1)

    # net announce against a fake statusd.
    status_path = str(tmp / "status.sock")
    fake = FakeStatusd(status_path)
    fake.start()
    try:
        r = run_cli(binary, ["net", "announce"],
                    {"SEVYN_STATUS_SOCK": status_path})
        check("net announce: exit 0", r.returncode == 0, r.stderr)
        deadline = time.time() + 5
        seen = []
        while time.time() < deadline:
            seen = fake.recorded()
            if seen:
                break
            time.sleep(0.05)
        check("net announce: sends one SET wifi line",
              len(seen) == 1 and seen[0] in ("SET wifi on", "SET wifi off"),
              str(seen))
        check("net announce: prints the wifi value",
              r.stdout.strip() in ("wifi: on", "wifi: off"), r.stdout)
        # net status reads the live wifi value from the fake statusd.
        r = run_cli(binary, ["net", "status"],
                    {"SEVYN_STATUS_SOCK": status_path})
        check("net status: wifi value comes from statusd",
              "wifi: on" in r.stdout, r.stdout)
    finally:
        fake.close()

    # --- settings: wallpaperStyle (macos / macos-light) ---
    # The Settings UI lists macOS and macOS Light, but the validator
    # only accepted default|solid|cosmic|minimal, so tapping either
    # never stuck — and read_settings repaired a hand-edited "macos"
    # back to default. The verbs honour SEVYN_SETTINGS_PATH, so the
    # whole round-trip is testable off-device against a temp file.
    settings_path = str(tmp / "settings.json")
    settings_env = {"SEVYN_SETTINGS_PATH": settings_path}
    # Fresh system: defaults, no file needed.
    r = run_cli(binary, ["settings", "get", "wallpaperStyle"], settings_env)
    check("settings get: fresh default style is default",
          r.returncode == 0
          and r.stdout.strip() == "wallpaperStyle=default",
          r.stdout + r.stderr)
    r = run_cli(binary, ["settings", "get", "wallpaperColor"], settings_env)
    check("settings get: fresh default color is #090b11",
          r.returncode == 0
          and r.stdout.strip() == "wallpaperColor=#090b11",
          r.stdout + r.stderr)
    # Every style the UI lists sets and survives a read-back.
    for style in ("default", "solid", "cosmic", "minimal",
                  "macos", "macos-light"):
        r = run_cli(binary, ["settings", "set", "wallpaperStyle", style],
                    settings_env)
        check(f"settings set: {style} exits 0",
              r.returncode == 0, r.stdout + r.stderr)
        r = run_cli(binary, ["settings", "get", "wallpaperStyle"],
                    settings_env)
        check(f"settings get: {style} survives a read-back",
              r.returncode == 0
              and r.stdout.strip() == f"wallpaperStyle={style}",
              r.stdout + r.stderr)
    # An invalid style is still refused, and the stored value is
    # untouched by the refused set.
    r = run_cli(binary, ["settings", "set", "wallpaperStyle", "neon"],
                settings_env)
    check("settings set: invalid style exits 1", r.returncode == 1)
    check("settings set: invalid style names the six accepted styles",
          "default|solid|cosmic|minimal|macos|macos-light" in r.stderr,
          r.stderr)
    r = run_cli(binary, ["settings", "get", "wallpaperStyle"], settings_env)
    check("settings get: refused set leaves the stored style alone",
          r.stdout.strip() == "wallpaperStyle=macos-light",
          r.stdout + r.stderr)
    # A hand-edited file with "macos" is honoured, not repaired back
    # to default (the read path gates on the same validator).
    Path(settings_path).write_text(
        '{"wallpaperStyle": "macos", "wallpaperColor": "#090b11"}\n')
    r = run_cli(binary, ["settings", "get", "wallpaperStyle"], settings_env)
    check("settings get: hand-edited macos survives the read",
          r.stdout.strip() == "wallpaperStyle=macos", r.stdout + r.stderr)
    # ... and a hand-edited invalid style still repairs to default.
    Path(settings_path).write_text(
        '{"wallpaperStyle": "neon", "wallpaperColor": "#090b11"}\n')
    r = run_cli(binary, ["settings", "get", "wallpaperStyle"], settings_env)
    check("settings get: hand-edited invalid style repairs to default",
          r.stdout.strip() == "wallpaperStyle=default", r.stdout + r.stderr)

    server.shutdown()
    server.server_close()

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURES: {FAILURES}")
        return 1
    print("\ntest-browser: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
