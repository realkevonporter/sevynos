#!/usr/bin/env python3
"""Host-side tests for the M5 `sevyn` CLI verbs (v2/update/sevyn.c):
`browser` (Chromium over CDP) and `net` (link state, DNS, announce).

Builds the CLI with the host gcc, then drives it against a FAKE CDP
server (an HTTP server that records requests and replies like
Chromium's DevTools endpoint: /json/version, /json/list, PUT
/json/new, /json/activate/<id>, /json/close/<id>) and a FAKE statusd
(a Unix socket server that records SET lines and answers GET with
canned STATUS values). No QEMU, no Chromium — the CI harness
(m5-check) covers the guest end to end.

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

TABS = [
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
            self._send_json(200, {
                "description": "",
                "devtoolsFrontendUrl": "",
                "id": "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
                "title": "New Tab",
                "type": "page",
                "url": url,
                "webSocketDebuggerUrl": "",
            })
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
         str(SEVYN_C)],
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

    # --- browser open (Chromium already running: PUT /json/new) ---
    REQUESTS.clear()
    r = run_cli(binary, ["browser", "open", "https://example.com"], env)
    check("browser open: exit 0", r.returncode == 0, r.stderr)
    check("browser open: PUT /json/new with the URL",
          ("PUT", "/json/new?https://example.com") in REQUESTS,
          str(REQUESTS))
    check("browser open: prints opened + new tab",
          "opened: https://example.com" in r.stdout and
          "tab: DDDD" in r.stdout, r.stdout)

    # Bare hostname gets https:// prepended.
    REQUESTS.clear()
    r = run_cli(binary, ["browser", "open", "example.com"], env)
    check("browser open: bare hostname normalized to https",
          ("PUT", "/json/new?https://example.com") in REQUESTS,
          str(REQUESTS))

    # --- browser activate / close ---
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
    # from SEVYN_CDP_PORT, with the launched URL (argv[1]) as its
    # only tab. `browser open` must return "opened:" + that tab's
    # id — this is the path the check relies on for a fast start,
    # and it exercises the find-tab-by-URL lookup. The fake exits
    # on its own after 15 s so no process lingers.
    fake_chromium = tmp / "fake-chromium.py"
    fake_chromium.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, threading, time\n"
        "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n"
        "port = int(os.environ.get('SEVYN_CDP_PORT', '9222'))\n"
        "url = sys.argv[-1] if len(sys.argv) > 1 else 'about:blank'\n"
        "# (The CLI execs Chromium with the URL as its LAST argument,\n"
        "# after the --flags — argv[1] is --no-sandbox, not the URL.)\n"
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

    # files cp: copies a file (binary-safe); missing source exits 1.
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src.bin"
        dst = Path(td) / "dst.bin"
        src.write_bytes(bytes(range(256)) + b"sevyn-cp\n")
        r = run_cli(binary, ["files", "cp", str(src), str(dst)], {})
        check("files cp: copies and reports the byte count",
              r.returncode == 0 and "copied 265 bytes" in r.stdout,
              r.stdout + r.stderr)
        check("files cp: destination is byte-identical",
              dst.exists() and dst.read_bytes() == src.read_bytes(), "")
        r = run_cli(binary, ["files", "cp", str(Path(td) / "nope"),
                             str(dst)], {})
        check("files cp: missing source exits 1", r.returncode == 1,
              r.stdout + r.stderr)

    server.shutdown()
    server.server_close()

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURES: {FAILURES}")
        return 1
    print("\ntest-browser: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
