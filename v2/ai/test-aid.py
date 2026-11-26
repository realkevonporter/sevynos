#!/usr/bin/env python3
"""Host-side tests for sevyn-aid (v2/ai/sevyn-aid.c).

Builds the AI daemon with the host gcc, then drives it against FAKE
appd + statusd socket servers (threads that record commands and
reply like the real daemons) and the REAL stub backends (echo-ai,
plan-ai) copied from the repo, plus a slow backend (timeout) and a
chatty one (garbage lines, no END). No QEMU, no Hermes — the CI
harness (m4.5-check) covers the guest end to end.

§17 covers the relay 1a CLI (`sevyn tailscale status`, read-only)
against a fake `tailscale` binary on PATH, plus the first_up_iface
tailscale0 exclusion in a user namespace (no privilege needed).
§18 covers the relay 1b CLI (`tailscale up/down/revoke`, the /data
marker, and the pending auth-URL file) against the same fake
(extended with up/down/logout) and a fresh fake statusd. No
Headscale, no tailnet, no network anywhere in this file. Phase 2
moved ai.relay ownership: `tailscale up/down/revoke` NO LONGER
SET ai.relay (that key is the relay SESSION state, owned by the
daemon + `sevyn ai relay`); §18 asserts the absence.
§19 covers the relay Phase 2 CLI (`sevyn ai relay
on|off|status|revoke|pair`, two-step confirms, keypair + marker +
pidfile, pairing approve/malformed) and the daemon's via=relay
marking + ai.relay on/idle transitions + the grant boundary over
the relay, driven by a fake `sevyn-relay` binary against a second
daemon instance booted with the agent marker present.

Run: python3 v2/ai/test-aid.py
Exit 0 = all checks pass.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
AID_C = HERE / "sevyn-aid.c"
JSON_C = HERE.parent / "loader" / "json.c"
JSON_H_DIR = HERE.parent / "loader"

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok: {name}")
    else:
        print(f"FAIL: {name} {detail}")
        FAILURES.append(name)


def wait_for(name, pred, timeout=10.0, interval=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(interval)
    print(f"FAIL: timeout waiting for {name}")
    FAILURES.append(name)
    return False


def wait_recorded(fake, line, timeout=5.0):
    """Poll a fake daemon's recorded commands: the fire-and-forget
    statusd has no reply, so its server thread may not have appended
    the line yet when the ASK reply lands. Returns True when seen."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if line in fake.recorded():
            return True
        time.sleep(0.05)
    return line in fake.recorded()


def wait_no_recorded(fake, prefix, grace=0.5):
    """Absence check: a statusd SET is fire-and-forget but sent
    before the CLI exits, so after a short grace the fake thread
    has recorded anything that was sent. Returns True when no
    recorded line starts with prefix."""
    time.sleep(grace)
    return not any(c.startswith(prefix) for c in fake.recorded())


class SockClient:
    """Line-based Unix socket client with a small receive buffer."""

    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(path)
        self.s.settimeout(15)
        self.buf = b""

    def send(self, line):
        self.s.sendall((line + "\n").encode())

    def readline(self):
        while b"\n" not in self.buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode()

    def close(self):
        self.s.close()


class FakeDaemon(threading.Thread):
    """A fake appd/statusd: records one line per connection, replies
    per the handler, then closes. daemon=True so the process can exit
    even if a thread is stuck in accept()."""

    def __init__(self, sock_path, handler):
        super().__init__(daemon=True)
        self.sock_path = sock_path
        self.handler = handler
        self.commands = []
        self.lock = threading.Lock()
        self.stop = False
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        self.server.bind(sock_path)
        self.server.listen(8)
        self.server.settimeout(0.5)

    def run(self):
        while not self.stop:
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn.settimeout(5)
            try:
                data = b""
                while b"\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                line = data.decode(errors="replace").strip()
                if line:
                    with self.lock:
                        self.commands.append(line)
                    reply = self.handler(line)
                    if reply:
                        conn.sendall(reply.encode())
            except OSError:
                pass
            finally:
                conn.close()

    def recorded(self):
        with self.lock:
            return list(self.commands)

    def close(self):
        self.stop = True
        self.server.close()
        if os.path.exists(self.sock_path):
            os.unlink(self.sock_path)


def appd_handler(line):
    if line.startswith("LAUNCH "):
        return f"OK launched {line[7:]}\n"
    if line.startswith("CLOSE "):
        return f"OK closed {line[6:]}\n"
    if line.startswith("INSTALL "):
        return f"OK installed {line[8:]}\n"
    if line.startswith("UNINSTALL "):
        return f"OK uninstalled {line[10:]}\n"
    if line == "LIST":
        return ("APP files|Files|1.0.0|#3b82f6|F\n"
                "APP terminal|Terminal|1.0.0|#111827|>\n"
                "OK list\n")
    return "ERR not-installed\n"


# ----------------------------------------------------------------------
# Fake Muse API (P0 §14): a Chat Completions server on loopback.
# The test sets a scenario (a queue of responses, one per request);
# each request body is recorded so the test can assert what the
# backend sent (model, tools, the read result fed back in round 2).
# A response is {"status": int, "body": dict|str} or {"sleep": secs}
# (never answers — the timeout test). An empty queue answers "no
# tool calls", so the agent loop ends.
# ----------------------------------------------------------------------
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def resp_no_tools():
    return {"status": 200, "body": {
        "choices": [{"message": {"role": "assistant", "content": "done"},
                     "finish_reason": "stop"}]}}


def resp_tool_calls(calls):
    """calls: [(id, name, args_dict)] -> one Chat Completions reply."""
    return {"status": 200, "body": {
        "choices": [{"message": {
            "role": "assistant", "content": None,
            "tool_calls": [
                {"id": cid, "type": "function",
                 "function": {"name": name,
                              "arguments": json.dumps(args)}}
                for cid, name, args in calls]},
            "finish_reason": "tool_calls"}]}}


class FakeMuseAPI:
    def __init__(self):
        self.responses = []
        self.requests = []
        self.lock = threading.Lock()
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                try:
                    body = json.loads(raw.decode())
                except Exception:
                    body = {"_raw": raw.decode(errors="replace")}
                with api.lock:
                    api.requests.append(body)
                    resp = (api.responses.pop(0) if api.responses
                            else resp_no_tools())
                if "sleep" in resp:
                    time.sleep(resp["sleep"])
                status = resp.get("status", 200)
                payload = resp.get("body", {})
                data = (payload if isinstance(payload, str)
                        else json.dumps(payload)).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/v1"

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def set_scenario(self, responses):
        with self.lock:
            self.responses = list(responses)
            self.requests = []


def statusd_handler(line):
    # statusd sends no reply — fire and forget.
    return None


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-aid-test-"))
    print(f"work dir: {tmp}")
    aid_bin = tmp / "sevyn-aid"
    build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-I", str(JSON_H_DIR),
         "-o", str(aid_bin), str(AID_C), str(JSON_C)],
        capture_output=True, text=True)
    if build.returncode != 0:
        print("FAIL: build of sevyn-aid failed")
        print(build.stdout)
        print(build.stderr)
        return 1
    print("  ok: sevyn-aid builds clean (-Wall -Wextra)")

    backends = tmp / "backends"
    backends.mkdir()
    for name in ("echo-ai", "plan-ai"):
        src = HERE / "backends" / name
        dst = backends / name
        shutil.copy(src, dst)
        dst.chmod(0o755)
    # slow-ai: sleeps past the 5 s backend timeout, prints nothing.
    slow = backends / "slow-ai"
    slow.write_text("#!/bin/sh\nsleep 10\n")
    slow.chmod(0o755)
    # chatty-ai: garbage lines, one real action, exits without END.
    chatty = backends / "chatty-ai"
    chatty.write_text("#!/bin/sh\n"
                      "echo \"thinking...\"\n"
                      "echo \"not an action\"\n"
                      "echo \"LAUNCH files\"\n")
    chatty.chmod(0o755)

    # muse-ai (P0 §14): build the real backend, ship its limits file.
    muse_bin = tmp / "muse-ai"
    muse_build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-I", str(JSON_H_DIR),
         "-o", str(muse_bin), str(HERE / "muse-ai.c"), str(JSON_C),
         "-lssl", "-lcrypto"],
        capture_output=True, text=True)
    if muse_build.returncode != 0:
        print("FAIL: build of muse-ai failed")
        print(muse_build.stdout)
        print(muse_build.stderr)
        return 1
    print("  ok: muse-ai builds clean (-Wall -Wextra)")
    muse_dst = backends / "muse-ai"
    shutil.copy(muse_bin, muse_dst)
    muse_dst.chmod(0o755)
    shutil.copy(HERE / "backends" / "muse-ai.limits",
                backends / "muse-ai.limits")

    # sevyn CLI (P1 §15): build the real CLI so the test can drive
    # `ai session` / `ai status` against the test daemon.
    sevyn_bin = tmp / "sevyn"
    sevyn_build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra",
         "-o", str(sevyn_bin), str(HERE.parent / "update" / "sevyn.c"),
         "-lcrypto"],
        capture_output=True, text=True)
    if sevyn_build.returncode != 0:
        print("FAIL: build of sevyn failed")
        print(sevyn_build.stdout)
        print(sevyn_build.stderr)
        return 1
    print("  ok: sevyn builds clean (-Wall -Wextra)")

    # §14 fixtures: a read root (the backend + daemon only read under
    # SEVYN_AI_READ_ROOT in the host test), a small file + an over-cap
    # file, a fake `sevyn` CLI (the EXEC target), a god-mode grant
    # file (present but ignored while god mode is off), a key file,
    # and the fake Muse API on loopback.
    read_root = tmp / "readdata"
    read_root.mkdir()
    (read_root / "settings.json").write_text('{"volume": 42}')
    (read_root / "registry.json").write_text(
        '{"apps": [{"id": "files"}, {"id": "terminal"}]}')
    (read_root / "big.bin").write_bytes(b"x" * (100 * 1024))
    fake_cli = tmp / "sevyn-fake"
    cli_calls = tmp / "cli-calls.log"
    fake_cli.write_text(
        f"#!/bin/sh\necho \"$@\" >> {cli_calls}\n"
        "if [ \"$1\" = \"update\" ] && [ \"$2\" = \"check\" ]; then "
        "echo \"update available: 1.2.3\"; fi\n"
        "exit 0\n")
    fake_cli.chmod(0o755)
    # P2: the god-mode grant (the full 11-permission list, a copy of
    # the repo's grant-god.json) sits next to the standard grant but
    # is ignored while god mode is off (§14g proves that). The
    # template is the file `sevyn ai god on --confirm` copies the
    # runtime god grant from; the runtime god grant is the file the
    # daemon reads when the marker is present.
    god_grant = tmp / "grant-god.json"
    shutil.copy(HERE / "grant-god.json", god_grant)
    god_template = tmp / "grant-god-template.json"
    shutil.copy(HERE / "grant-god.json", god_template)
    god_marker = tmp / "god-mode.json"
    audit_log = tmp / "ai-audit.log"
    key_file = tmp / "muse-key"
    key_file.write_text("test-key-abc123\n")
    key_file.chmod(0o600)
    fake_api = FakeMuseAPI()
    fake_api.start()

    # §15 fixtures (P1): the write root is the same directory as
    # the read root, so a file the backend reads it may also fix.
    # target.txt (ASK WRITE), mode.txt (mode preservation, 0600),
    # session-target.txt (session WRITE), muse-target.txt (muse-ai
    # session read -> fix -> re-check). one-action.txt holds the
    # single action line one-action-ai emits (the test rewrites it
    # per check).
    (read_root / "target.txt").write_text("broken=false\n")
    mode_file = read_root / "mode.txt"
    mode_file.write_text("secret\n")
    mode_file.chmod(0o600)
    (read_root / "session-target.txt").write_text("old\n")
    (read_root / "muse-target.txt").write_text("broken=false\n")
    one_action_file = tmp / "one-action.txt"
    one_action_file.write_text("LIST\n")
    session_results = tmp / "session-results.log"

    def write_backend(name, code):
        p = backends / name
        p.write_text(code)
        p.chmod(0o755)
        return p

    # one-action-ai: emits the single action line stored in
    # one-action.txt, then END (ASK mode). The test rewrites the
    # file per check, so one backend covers every single-action
    # WRITE / UPDATE case.
    write_backend("one-action-ai",
                  "#!/usr/bin/env python3\n"
                  "import sys\n"
                  "sys.stdin.readline()\n"
                  f"print(open({str(one_action_file)!r}).read().strip())\n"
                  "print('END')\n")
    # session-ai: reads SESSION + task, then READ, WRITE, LIST —
    # one per round, reading the RESULT after each — and records
    # the RESULTs. The WRITE content carries a \\n escape, so the
    # file must gain a real newline.
    write_backend("session-ai",
                  "#!/usr/bin/env python3\n"
                  "import sys\n"
                  f"RESULTS = {str(session_results)!r}\n"
                  f"READ_PATH = {str(read_root / 'settings.json')!r}\n"
                  f"WRITE_PATH = {str(read_root / 'session-target.txt')!r}\n"
                  "first = sys.stdin.readline().strip()\n"
                  "task = sys.stdin.readline().strip()\n"
                  "if first != 'SESSION':\n"
                  "    print('END')\n"
                  "    sys.exit(0)\n"
                  "results = []\n"
                  "print(f'READ {READ_PATH}', flush=True)\n"
                  "results.append(sys.stdin.readline().strip())\n"
                  "print(f'WRITE {WRITE_PATH} fixed=true\\\\nmode=on',\n"
                  "      flush=True)\n"
                  "results.append(sys.stdin.readline().strip())\n"
                  "print('LIST', flush=True)\n"
                  "results.append(sys.stdin.readline().strip())\n"
                  "print('END', flush=True)\n"
                  "open(RESULTS, 'w').write('\\n'.join(results) + '\\n')\n")
    # slow-session-ai: emits one action, reads the RESULT, then
    # sleeps far past its 2 s per-action budget. The daemon must
    # reply OK with the partial progress, not hang.
    write_backend("slow-session-ai",
                  "#!/usr/bin/env python3\n"
                  "import sys, time\n"
                  "sys.stdin.readline()\n"
                  "sys.stdin.readline()\n"
                  "print('LIST', flush=True)\n"
                  "sys.stdin.readline()\n"
                  "time.sleep(30)\n"
                  "print('END', flush=True)\n")
    (backends / "slow-session-ai.limits").write_text(
        "timeout=2\nmax_actions=32\n")
    # greedy-session-ai: emits LIST forever. Its 3-action cap must
    # end the session normally (OK, allowed=3).
    write_backend("greedy-session-ai",
                  "#!/usr/bin/env python3\n"
                  "import sys\n"
                  "sys.stdin.readline()\n"
                  "sys.stdin.readline()\n"
                  "for _ in range(20):\n"
                  "    print('LIST', flush=True)\n"
                  "    if not sys.stdin.readline():\n"
                  "        break\n"
                  "print('END', flush=True)\n")
    (backends / "greedy-session-ai.limits").write_text(
        "timeout=5\nmax_actions=3\n")

    grant = tmp / "grant.json"
    shutil.copy(HERE / "grant.json", grant)
    sock_path = tmp / "aid.sock"
    ctl_path = tmp / "ctl"
    os.mkfifo(ctl_path)
    selected_path = tmp / "ai-selected.json"
    appd_sock = tmp / "appd.sock"
    status_sock = tmp / "status.sock"

    fake_appd = FakeDaemon(str(appd_sock), appd_handler)
    fake_statusd = FakeDaemon(str(status_sock), statusd_handler)
    fake_appd.start()
    fake_statusd.start()

    env = {
        **os.environ,
        "SEVYN_AI_SOCK": str(sock_path),
        "SEVYN_AI_CTL": str(ctl_path),
        "SEVYN_AI_BACKENDS_DIR": str(backends),
        "SEVYN_AI_GRANT": str(grant),
        "SEVYN_AI_SELECTED": str(selected_path),
        "SEVYN_AI_APPD_SOCK": str(appd_sock),
        "SEVYN_AI_STATUS_SOCK": str(status_sock),
        # muse-ai (P0 §14): the backend inherits the daemon's env.
        # The fake API is on loopback; no real key or network is used.
        "SEVYN_AI_KEY_FILE": str(key_file),
        "MUSE_API_BASE": fake_api.url,
        "SEVYN_AI_READ_ROOT": str(read_root),
        "SEVYN_AI_WRITE_ROOT": str(read_root),
        "SEVYN_AI_CLI": str(fake_cli),
        "SEVYN_AI_SETTINGS": str(read_root / "settings.json"),
        "SEVYN_AI_REGISTRY": str(read_root / "registry.json"),
        "SEVYN_AI_LOG": str(tmp / "aid.log"),
        # P2 (god mode): the runtime god grant + marker + audit log.
        "SEVYN_AI_GOD_GRANT": str(god_grant),
        "SEVYN_AI_GOD_MARKER": str(god_marker),
        "SEVYN_AI_AUDIT_LOG": str(audit_log),
    }
    aid_log = open(tmp / "aid.log", "w")
    aid = subprocess.Popen([str(aid_bin)], env=env, stdout=aid_log,
                           stderr=subprocess.STDOUT)

    def log_text():
        aid_log.flush()
        return (tmp / "aid.log").read_text(errors="replace")

    try:
        # 1. aid starts: grant loaded, backends found, default echo.
        check("aid starts", wait_for(
            "AID ready", lambda: "AID ready" in log_text()))
        check("grant loaded (4 permissions)",
              "AID grant loaded (4 permissions)" in log_text())
        check("ready line names backends + selected",
              wait_for("ready line",
                       lambda: "backends=chatty-ai,echo-ai,greedy-session-ai,muse-ai,one-action-ai,plan-ai,session-ai,slow-ai,slow-session-ai "
                       "selected=echo-ai" in log_text()))

        c = SockClient(str(sock_path))

        # 2. socket: PING / LIST / STATUS.
        c.send("PING")
        check("PING -> OK pong", c.readline() == "OK pong")
        c.send("LIST")
        check("LIST -> selected + backends",
              c.readline() ==
              "OK selected=echo-ai backends=chatty-ai,echo-ai,greedy-session-ai,muse-ai,one-action-ai,plan-ai,session-ai,slow-ai,slow-session-ai")
        c.send("STATUS")
        check("STATUS -> grant csv",
              c.readline() ==
              "OK selected=echo-ai backends=chatty-ai,echo-ai,greedy-session-ai,muse-ai,one-action-ai,plan-ai,session-ai,slow-ai,slow-session-ai "
              "grant=app.launch,app.close,app.list,status.set god_mode=off relay=off")

        # 3. SELECT: valid, unknown, usage.
        c.send("SELECT plan-ai")
        check("SELECT plan-ai ok",
              c.readline() == "OK selected plan-ai")
        c.send("SELECT bogus-ai")
        check("SELECT unknown refused",
              c.readline() == "ERR unknown backend bogus-ai")
        c.send("SELECT echo-ai")
        check("SELECT echo-ai back",
              c.readline() == "OK selected echo-ai")
        check("selection persisted to file",
              selected_path.read_text().strip() == "echo-ai")

        # 4. ASK via echo-ai: LAUNCH (allowed, runs against fake appd).
        c.send("ASK launch files")
        check("ASK launch files -> allowed=1",
              c.readline() ==
              "OK backend=echo-ai allowed=1 denied=0 failed=0")
        check("fake appd saw LAUNCH files",
              "LAUNCH files" in fake_appd.recorded())
        check("ALLOW logged",
              "AID ALLOW echo-ai LAUNCH files" in log_text())

        # 5. ASK via echo-ai: SET (allowed, runs against fake statusd).
        c.send("ASK set volume 42")
        check("ASK set volume 42 -> allowed=1",
              c.readline() ==
              "OK backend=echo-ai allowed=1 denied=0 failed=0")
        check("fake statusd saw SET volume 42",
              wait_recorded(fake_statusd, "SET volume 42"))

        # 6. ASK via echo-ai: LIST (allowed, counts fake appd's apps).
        c.send("ASK list")
        check("ASK list -> allowed=1",
              c.readline() ==
              "OK backend=echo-ai allowed=1 denied=0 failed=0")
        check("fake appd saw LIST",
              "LIST" in fake_appd.recorded())

        # 7. The permission boundary: UNINSTALL + REBOOT are refused
        #    and never reach appd.
        before = fake_appd.recorded()
        c.send("ASK uninstall files and reboot")
        check("ASK uninstall+reboot -> denied=2",
              c.readline() ==
              "OK backend=echo-ai allowed=0 denied=2 failed=0")
        check("DENIED UNINSTALL logged",
              "AID DENIED echo-ai UNINSTALL files (app.uninstall)"
              in log_text())
        check("DENIED REBOOT logged",
              "AID DENIED echo-ai REBOOT (system.reboot)" in log_text())
        check("UNINSTALL never reached appd",
              fake_appd.recorded() == before)

        # 8. Swap backends, no code change: plan-ai plans the same
        #    goal differently through the same connector.
        c.send("SELECT plan-ai")
        check("SELECT plan-ai ok (swap)",
              c.readline() == "OK selected plan-ai")
        c.send("ASK list apps, open files and set the volume to 55")
        check("ASK plan-ai -> allowed=3",
              c.readline() ==
              "OK backend=plan-ai allowed=3 denied=0 failed=0")
        check("plan-ai ran LIST + LAUNCH + SET",
              "LIST" in fake_appd.recorded() and
              "LAUNCH files" in fake_appd.recorded() and
              wait_recorded(fake_statusd, "SET volume 55"))

        # 9. chatty-ai: garbage ignored, real action runs, missing
        #    END is tolerated.
        c.send("SELECT chatty-ai")
        check("SELECT chatty-ai ok",
              c.readline() == "OK selected chatty-ai")
        c.send("ASK anything")
        check("ASK chatty-ai -> allowed=1 (garbage ignored)",
              c.readline() ==
              "OK backend=chatty-ai allowed=1 denied=0 failed=0")
        check("chatty-ai missing END logged",
              "ended without END" in log_text())

        # 10. slow-ai: the backend timeout kills it, the daemon
        #     still answers PING afterwards.
        c.send("SELECT slow-ai")
        check("SELECT slow-ai ok",
              c.readline() == "OK selected slow-ai")
        t0 = time.time()
        c.send("ASK hello")
        reply = c.readline()
        elapsed = time.time() - t0
        check("ASK slow-ai -> backend timed out",
              reply == "ERR backend slow-ai failed: backend timed out",
              reply)
        check("timeout took ~5 s, not 10",
              4.0 <= elapsed < 9.0, f"elapsed={elapsed:.1f}s")
        c.send("PING")
        check("daemon still answers PING after timeout",
              c.readline() == "OK pong")

        # 11. Control serial: PING / STATUS / SELECT / ASK.
        ctl_w = open(ctl_path, "w")
        ctl_w.write("PING\n")
        ctl_w.flush()
        check("ctl PING -> AID PONG", wait_for(
            "PONG", lambda: "AID PONG" in log_text()))
        ctl_w.write("STATUS\n")
        ctl_w.flush()
        check("ctl STATUS logged", wait_for(
            "ctl STATUS",
            lambda: "AID STATUS selected=slow-ai" in log_text()))
        ctl_w.write("SELECT echo-ai\n")
        ctl_w.flush()
        check("ctl SELECT ok", wait_for(
            "ctl SELECT",
            lambda: "AID SELECT OK echo-ai" in log_text()))
        ctl_w.write("ASK launch files\n")
        ctl_w.flush()
        check("ctl ASK ok", wait_for(
            "ctl ASK",
            lambda: "AID ASK OK backend=echo-ai allowed=1 denied=0 "
            "failed=0" in log_text()))
        ctl_w.write("BOGUS\n")
        ctl_w.flush()
        check("ctl unknown command logged", wait_for(
            "unknown cmd",
            lambda: "AID unknown command: BOGUS" in log_text()))

        # 14. muse-ai (P0): the real backend against the fake Muse
        #     API on loopback. No real key, no real network.
        c.send("SELECT muse-ai")
        check("SELECT muse-ai ok",
              c.readline() == "OK selected muse-ai")

        # 14a. Happy path: the model launches an app.
        fake_api.set_scenario([resp_tool_calls(
            [("call_1", "launch", {"id": "files"})])])
        c.send("ASK launch the files app")
        check("ASK muse-ai launch -> allowed=1",
              c.readline() ==
              "OK backend=muse-ai allowed=1 denied=0 failed=0")
        check("muse-ai launch reached appd",
              "LAUNCH files" in fake_appd.recorded())
        check("muse-ai sent model muse-spark-1.3 + tools",
              len(fake_api.requests) == 1 and
              fake_api.requests[0].get("model") == "muse-spark-1.3" and
              "tools" in fake_api.requests[0])

        # 14b. Two rounds: read state, then act on it. The backend
        #     feeds the read result back to the model (round 2) and
        #     emits a READ action line for the audit trail.
        fake_api.set_scenario([
            resp_tool_calls([("call_1", "read",
                              {"path": str(read_root / "settings.json")})]),
            resp_tool_calls([("call_2", "launch", {"id": "files"})]),
        ])
        c.send("ASK read the settings then launch files")
        check("ASK muse-ai read+launch -> allowed=2",
              c.readline() ==
              "OK backend=muse-ai allowed=2 denied=0 failed=0")
        check("muse-ai made 2 API calls (read fed back)",
              len(fake_api.requests) == 2)
        check("round 2 carried the read result",
              len(fake_api.requests) == 2 and
              "volume" in json.dumps(fake_api.requests[1]))
        check("READ logged in the audit trail",
              "AID ALLOW muse-ai READ " in log_text())

        # 14c. No key: a clear failure, not a crash — no actions, no
        #     API call, and the daemon stays up.
        key_file.unlink()
        fake_api.set_scenario([resp_tool_calls(
            [("call_1", "launch", {"id": "files"})])])
        c.send("ASK launch files")
        check("ASK muse-ai no key -> allowed=0",
              c.readline() ==
              "OK backend=muse-ai allowed=0 denied=0 failed=0")
        check("no key made no API call",
              len(fake_api.requests) == 0)
        key_file.write_text("test-key-abc123\n")
        key_file.chmod(0o600)
        direct = subprocess.run(
            [str(muse_bin)], input="hello\n", capture_output=True,
            text=True,
            env={**os.environ,
                 "SEVYN_AI_KEY_FILE": str(tmp / "no-such-key"),
                 "MUSE_API_BASE": fake_api.url},
            timeout=10)
        check("muse-ai direct, no key -> clear ERR + END",
              "ERR no Muse API key configured" in direct.stdout and
              direct.stdout.strip().endswith("END"))

        # 14d. Bad key: the API answers 401, the backend fails closed
        #     (no actions, END) — directly and through the daemon.
        fake_api.set_scenario([{"status": 401, "body": {
            "error": {"message": "invalid key"}}}])
        direct401 = subprocess.run(
            [str(muse_bin)], input="hello\n", capture_output=True,
            text=True,
            env={**os.environ, "SEVYN_AI_KEY_FILE": str(key_file),
                 "MUSE_API_BASE": fake_api.url},
            timeout=10)
        check("muse-ai direct, 401 -> ERR + END, no actions",
              "ERR Muse API returned HTTP 401" in direct401.stdout and
              direct401.stdout.strip().endswith("END") and
              "LAUNCH" not in direct401.stdout)
        fake_api.set_scenario([{"status": 401, "body": {
            "error": {"message": "invalid key"}}}])
        c.send("ASK launch files")
        check("ASK muse-ai bad key -> allowed=0",
              c.readline() ==
              "OK backend=muse-ai allowed=0 denied=0 failed=0")

        # 14e. Context cap: a READ over 64 KiB is refused by the
        #     backend itself — the model is told the read failed, and
        #     no READ action reaches the daemon.
        fake_api.set_scenario([
            resp_tool_calls([("call_1", "read",
                              {"path": str(read_root / "big.bin")})]),
            resp_no_tools(),
        ])
        c.send("ASK read the big file")
        check("ASK muse-ai read over cap -> allowed=0",
              c.readline() ==
              "OK backend=muse-ai allowed=0 denied=0 failed=0")
        check("over-cap refusal told to the model",
              len(fake_api.requests) == 2 and
              "over the 64 KiB read cap" in json.dumps(fake_api.requests[1]))
        check("over-cap READ never reached the daemon",
              "big.bin" not in log_text())

        # 14f. Timeout kill: the mock never answers; the daemon's
        #     per-backend limit (shortened here to 5 s) kills the run.
        (backends / "muse-ai.limits").write_text(
            "timeout=5\nmax_actions=64\n")
        fake_api.set_scenario([{"sleep": 30, "status": 200,
                                "body": resp_no_tools()["body"]}])
        t0 = time.time()
        c.send("ASK hello")
        reply = c.readline()
        elapsed = time.time() - t0
        check("ASK muse-ai timeout -> backend timed out",
              reply == "ERR backend muse-ai failed: backend timed out",
              reply)
        check("muse-ai timeout took ~5 s",
              4.0 <= elapsed < 9.0, f"elapsed={elapsed:.1f}s")
        c.send("PING")
        check("daemon still answers PING after muse-ai timeout",
              c.readline() == "OK pong")
        shutil.copy(HERE / "backends" / "muse-ai.limits",
                    backends / "muse-ai.limits")

        # 14g. God-mode-off boundary: a grant-god.json (the full
        #     11-permission list) sits next to the grant (it would
        #     allow cli.exec), but god mode is off, so the standard
        #     grant still governs — EXEC denied.
        fake_api.set_scenario([resp_tool_calls(
            [("call_1", "exec", {"args": "update status"})])])
        c.send("ASK check for updates")
        check("ASK muse-ai EXEC, god mode off -> denied=1",
              c.readline() ==
              "OK backend=muse-ai allowed=0 denied=1 failed=0")
        check("EXEC never reached the fake sevyn CLI",
              not cli_calls.exists() or cli_calls.read_text() == "")
        check("god-mode grant did not widen the grant",
              "AID DENIED muse-ai EXEC update status (cli.exec)"
              in log_text())

        # 14h. EXEC runs when the grant names cli.exec, and RELOAD
        #     swaps the grant in without a restart.
        wide_grant = tmp / "grant-wide.json"
        wide_grant.write_text(json.dumps({"permissions": [
            "app.launch", "app.close", "app.list", "status.set",
            "cli.exec"]}))
        shutil.copy(wide_grant, grant)
        c.send("RELOAD")
        check("RELOAD -> OK grant reloaded",
              c.readline().startswith("OK grant reloaded"))
        c.send("STATUS")
        check("STATUS shows the widened grant",
              "cli.exec" in c.readline())
        fake_api.set_scenario([resp_tool_calls(
            [("call_1", "exec", {"args": "update status"})])])
        c.send("ASK check for updates")
        check("ASK muse-ai EXEC, grant allows -> allowed=1",
              c.readline() ==
              "OK backend=muse-ai allowed=1 denied=0 failed=0")
        check("EXEC reached the fake sevyn CLI",
              cli_calls.exists() and
              "update status" in cli_calls.read_text())

        # 14i. A bad reload keeps the old grant (never fails open).
        bad = tmp / "grant-bad.json"
        bad.write_text('{"permissions": "not-an-array"}')
        shutil.copy(bad, grant)
        c.send("RELOAD")
        check("RELOAD bad grant -> ERR, old grant kept",
              c.readline().startswith("ERR grant reload failed"))
        c.send("STATUS")
        check("STATUS still shows the widened grant",
              "cli.exec" in c.readline())
        shutil.copy(HERE / "grant.json", grant)
        c.send("RELOAD")
        check("RELOAD restores the standard grant",
              c.readline().startswith("OK grant reloaded"))

        # 14j. SIGHUP reloads the grant too (no restart, no RELOAD).
        # Count first: the log already has a "(5 permissions)" line
        # from §14h, so wait for a NEW one, not a stale match.
        def reloads(n):
            return log_text().count(
                f"AID grant reloaded ({n} permissions)")
        shutil.copy(wide_grant, grant)
        before = reloads(5)
        aid.send_signal(signal.SIGHUP)
        check("SIGHUP -> grant reloaded logged", wait_for(
            "sighup reload",
            lambda: reloads(5) > before))
        c.send("STATUS")
        check("STATUS after SIGHUP shows the widened grant",
              "cli.exec" in c.readline())
        shutil.copy(HERE / "grant.json", grant)
        before = reloads(4)
        aid.send_signal(signal.SIGHUP)
        check("SIGHUP restores the standard grant", wait_for(
            "sighup reload back",
            lambda: reloads(4) > before))

        # 15. P1: WRITE (+ .sevyn-bak undo), UPDATE, session
        #     protocol. The widened grant names file.write +
        #     system.update; the standard grant names neither.
        p1_grant = tmp / "grant-p1.json"
        p1_grant.write_text(json.dumps({"permissions": [
            "app.launch", "app.close", "app.list", "status.set",
            "cli.exec", "file.write", "system.update"]}))

        def set_grant(path):
            shutil.copy(path, grant)
            c.send("RELOAD")
            return c.readline().startswith("OK grant reloaded")

        def ask_one(action_line):
            """Run one-action-ai with the given action line (ASK)."""
            one_action_file.write_text(action_line + "\n")
            c.send("SELECT one-action-ai")
            c.readline()
            c.send("ASK do it")
            return c.readline()

        # 15a. WRITE allowed (widened grant): the file gains the new
        #      content (the \\n escape becomes a real newline), the
        #      previous copy is kept as .sevyn-bak, and the write is
        #      logged with the full path.
        check("RELOAD to the P1 grant", set_grant(p1_grant))
        target = read_root / "target.txt"
        reply = ask_one(
            f"WRITE {target} line1\\nline2")
        check("ASK WRITE (grant allows) -> allowed=1",
              reply == "OK backend=one-action-ai allowed=1 denied=0 "
              "failed=0", reply)
        check("WRITE replaced the content (escape decoded)",
              target.read_text() == "line1\nline2")
        check("WRITE kept the previous copy as .sevyn-bak",
              (read_root / "target.txt.sevyn-bak").read_text() ==
              "broken=false\n")
        check("WRITE logged with the full path",
              f"AID WRITE {target} (11 bytes, backup "
              f"{target}.sevyn-bak)" in log_text())

        # 15a2. WRITE preserves the file's mode (a 0600 file stays
        #      0600) and backs it up.
        mode_file = read_root / "mode.txt"
        reply = ask_one(f"WRITE {mode_file} newsecret")
        check("ASK WRITE mode file -> allowed=1",
              reply == "OK backend=one-action-ai allowed=1 denied=0 "
              "failed=0", reply)
        check("WRITE preserved mode 0600",
              oct(mode_file.stat().st_mode & 0o777) == "0o600")
        check("WRITE backed up the mode file",
              (read_root / "mode.txt.sevyn-bak").read_text() ==
              "secret\n")

        # 15b. WRITE denied under the standard grant: the file is
        #      untouched and the grant refusal is logged.
        check("RELOAD to the standard grant", set_grant(
            HERE / "grant.json"))
        reply = ask_one(f"WRITE {target} hacked")
        check("ASK WRITE (standard grant) -> denied=1",
              reply == "OK backend=one-action-ai allowed=0 denied=1 "
              "failed=0", reply)
        check("denied WRITE left the file untouched",
              target.read_text() == "line1\nline2")
        check("WRITE denial logged",
              "AID DENIED one-action-ai WRITE " in log_text() and
              "(file.write)" in log_text())
        check("RELOAD to the P1 grant (again)", set_grant(p1_grant))

        # 15c. WRITE over the cap: a file the backend could not have
        #      fully read is refused (failed, not denied — the grant
        #      allows it, the executor refuses it).
        reply = ask_one(f"WRITE {read_root / 'big.bin'} small")
        check("ASK WRITE over-cap file -> failed=1",
              reply == "OK backend=one-action-ai allowed=0 denied=0 "
              "failed=1", reply)
        check("over-cap file untouched",
              (read_root / "big.bin").stat().st_size == 100 * 1024)

        # 15d. WRITE to the pristine stock bundles is refused.
        reply = ask_one(
            "WRITE /usr/share/sevyn/pristine/x.txt hi")
        check("ASK WRITE pristine -> failed=1",
              reply == "OK backend=one-action-ai allowed=0 denied=0 "
              "failed=1", reply)
        check("pristine write never created a file",
              not (Path("/usr/share/sevyn/pristine/x.txt").exists()))

        # 15e. WRITE a new file: created, and no .sevyn-bak (there
        #      was nothing to back up).
        new_file = read_root / "new.txt"
        reply = ask_one(f"WRITE {new_file} fresh")
        check("ASK WRITE new file -> allowed=1",
              reply == "OK backend=one-action-ai allowed=1 denied=0 "
              "failed=0", reply)
        check("new file created with the content",
              new_file.read_text() == "fresh")
        check("new file has no .sevyn-bak",
              not (read_root / "new.txt.sevyn-bak").exists())

        # 15f. WRITE with .. traversal is refused.
        reply = ask_one(f"WRITE {read_root}/../evil.txt hi")
        check("ASK WRITE .. traversal -> failed=1",
              reply == "OK backend=one-action-ai allowed=0 denied=0 "
              "failed=1", reply)
        check("traversal wrote nothing outside the root",
              not (tmp / "evil.txt").exists())

        # 15g. WRITE with a missing parent directory is refused.
        reply = ask_one(f"WRITE {read_root}/nodir/x.txt hi")
        check("ASK WRITE missing parent -> failed=1",
              reply == "OK backend=one-action-ai allowed=0 denied=0 "
              "failed=1", reply)

        # 15h. UPDATE (check): the fake CLI saw "update check" and
        #      its output is the result.
        if cli_calls.exists():
            cli_calls.unlink()
        reply = ask_one("UPDATE")
        check("ASK UPDATE check -> allowed=1",
              reply == "OK backend=one-action-ai allowed=1 denied=0 "
              "failed=0", reply)
        check("UPDATE check reached the fake sevyn CLI",
              cli_calls.exists() and
              "update check" in cli_calls.read_text())
        check("UPDATE check result logged",
              "AID UPDATE check: update available: 1.2.3" in log_text())

        # 15i. UPDATE apply: requested, the fake CLI saw it.
        if cli_calls.exists():
            cli_calls.unlink()
        reply = ask_one("UPDATE apply")
        check("ASK UPDATE apply -> allowed=1",
              reply == "OK backend=one-action-ai allowed=1 denied=0 "
              "failed=0", reply)
        check("UPDATE apply reached the fake sevyn CLI",
              cli_calls.exists() and
              "update apply" in cli_calls.read_text())

        # 15j. UPDATE denied under the standard grant: the CLI is
        #      never called.
        check("RELOAD to the standard grant (UPDATE)",
              set_grant(HERE / "grant.json"))
        if cli_calls.exists():
            cli_calls.unlink()
        reply = ask_one("UPDATE")
        check("ASK UPDATE (standard grant) -> denied=1",
              reply == "OK backend=one-action-ai allowed=0 denied=1 "
              "failed=0", reply)
        check("denied UPDATE never reached the fake CLI",
              not cli_calls.exists() or cli_calls.read_text() == "")
        check("RELOAD to the P1 grant (session)", set_grant(p1_grant))

        # 15k. SESSION: read -> fix (write) -> list, one action per
        #      round, the daemon reporting each RESULT. The backend
        #      records the RESULTs it saw.
        if session_results.exists():
            session_results.unlink()
        c.send("SELECT session-ai")
        check("SELECT session-ai ok",
              c.readline() == "OK selected session-ai")
        c.send("SESSION fix the session target")
        reply = c.readline()
        check("SESSION -> allowed=3 denied=0 failed=0",
              reply == "OK backend=session-ai allowed=3 denied=0 "
              "failed=0", reply)
        check("session backend saw three RESULT OK lines",
              session_results.exists() and
              session_results.read_text().count("RESULT OK") == 3,
              session_results.read_text() if session_results.exists()
              else "(no results file)")
        check("session WRITE replaced the content",
              (read_root / "session-target.txt").read_text() ==
              "fixed=true\nmode=on")
        check("session WRITE kept the .sevyn-bak",
              (read_root / "session-target.txt.sevyn-bak").read_text()
              == "old\n")
        check("SESSION logged",
              "AID SESSION backend=session-ai" in log_text() and
              "allowed=3 denied=0 failed=0" in log_text())

        # 15l. SESSION per-action budget: the backend stalls after
        #      one action; the daemon replies OK with the partial
        #      progress after ~2 s (not 30) and still answers PING.
        c.send("SELECT slow-session-ai")
        check("SELECT slow-session-ai ok",
              c.readline() == "OK selected slow-session-ai")
        t0 = time.time()
        c.send("SESSION hello")
        reply = c.readline()
        elapsed = time.time() - t0
        check("SESSION slow backend -> OK with partial progress",
              reply == "OK backend=slow-session-ai allowed=1 denied=0 "
              "failed=0", reply)
        check("session timeout took ~2-4 s, not 30",
              1.5 <= elapsed < 10.0, f"elapsed={elapsed:.1f}s")
        c.send("PING")
        check("daemon still answers PING after session timeout",
              c.readline() == "OK pong")

        # 15m. SESSION action cap: the backend never stops, but the
        #      3-action cap ends the session normally.
        c.send("SELECT greedy-session-ai")
        check("SELECT greedy-session-ai ok",
              c.readline() == "OK selected greedy-session-ai")
        c.send("SESSION hello")
        reply = c.readline()
        check("SESSION greedy backend -> OK allowed=3 (capped)",
              reply == "OK backend=greedy-session-ai allowed=3 "
              "denied=0 failed=0", reply)
        c.send("PING")
        check("daemon still answers PING after capped session",
              c.readline() == "OK pong")

        # 15n. muse-ai in a session: read -> fix -> re-check. The
        #      fake API scripts the model: read the target, write the
        #      fix, read it again to check, then stop. The re-check
        #      (round 4's request) must carry the NEW content.
        c.send("SELECT muse-ai")
        check("SELECT muse-ai ok (session)",
              c.readline() == "OK selected muse-ai")
        muse_target = read_root / "muse-target.txt"
        fake_api.set_scenario([
            resp_tool_calls([("call_1", "read",
                              {"path": str(muse_target)})]),
            resp_tool_calls([("call_2", "write",
                              {"path": str(muse_target),
                               "content": "fixed=true\n"})]),
            resp_tool_calls([("call_3", "read",
                              {"path": str(muse_target)})]),
            resp_no_tools(),
        ])
        c.send("SESSION fix the muse target file")
        reply = c.readline()
        check("SESSION muse-ai read+write+read -> allowed=3",
              reply == "OK backend=muse-ai allowed=3 denied=0 "
              "failed=0", reply)
        check("muse-ai session made 4 API calls",
              len(fake_api.requests) == 4,
              f"requests={len(fake_api.requests)}")
        check("round 2 saw the old content (broken)",
              len(fake_api.requests) >= 2 and
              "broken=false" in json.dumps(fake_api.requests[1]))
        check("round 4 saw the new content (re-check)",
              len(fake_api.requests) == 4 and
              "fixed=true" in json.dumps(fake_api.requests[3]))
        check("muse-ai session wrote the fix to the file",
              muse_target.read_text() == "fixed=true\n")
        check("muse-ai session kept the .sevyn-bak",
              (read_root / "muse-target.txt.sevyn-bak").read_text() ==
              "broken=false\n")

        # 15o. SESSION grant-checked at every step: under the
        #      standard grant the WRITE is denied, the READ and LIST
        #      still run, and the backend is told DENIED.
        check("RELOAD to the standard grant (session deny)",
              set_grant(HERE / "grant.json"))
        if session_results.exists():
            session_results.unlink()
        c.send("SELECT session-ai")
        check("SELECT session-ai ok (deny)",
              c.readline() == "OK selected session-ai")
        c.send("SESSION fix the session target")
        reply = c.readline()
        check("SESSION standard grant -> allowed=2 denied=1",
              reply == "OK backend=session-ai allowed=2 denied=1 "
              "failed=0", reply)
        check("session backend saw the DENIED result",
              session_results.exists() and
              "RESULT DENIED file.write" in session_results.read_text(),
              session_results.read_text() if session_results.exists()
              else "(no results file)")
        check("denied session WRITE left the file untouched",
              (read_root / "session-target.txt").read_text() ==
              "fixed=true\nmode=on")

        # 15p. SESSION on the control serial: the same verb works
        #      there, and the daemon logs the outcome.
        ctl_w.write("SESSION fix the session target\n")
        ctl_w.flush()
        check("ctl SESSION logged", wait_for(
            "ctl SESSION",
            lambda: "AID SESSION OK backend=session-ai allowed=2 "
            "denied=1 failed=0" in log_text()))

        # 15q. The sevyn CLI (P1): `ai session` + `ai status` work
        #      against the daemon, and an unknown verb is usage.
        cli_env = {**os.environ, "SEVYN_AI_SOCK": str(sock_path)}
        cli_status = subprocess.run(
            [str(sevyn_bin), "ai", "status"], capture_output=True,
            text=True, env=cli_env, timeout=10)
        check("sevyn ai status runs (exit 0)",
              cli_status.returncode == 0 and
              "selected=session-ai" in cli_status.stdout,
              cli_status.stdout)
        cli_session = subprocess.run(
            [str(sevyn_bin), "ai", "session", "fix", "the",
             "session", "target"],
            capture_output=True, text=True, env=cli_env, timeout=30)
        check("sevyn ai session runs (exit 0, allowed=2 denied=1)",
              cli_session.returncode == 0 and
              "backend=session-ai allowed=2 denied=1 failed=0"
              in cli_session.stdout,
              cli_session.stdout)
        cli_bogus = subprocess.run(
            [str(sevyn_bin), "ai", "bogus"], capture_output=True,
            text=True, env=cli_env, timeout=10)
        check("sevyn ai bogus -> usage (non-zero exit)",
              cli_bogus.returncode != 0)

        # Leave the selection where §11/§12 expect it (echo-ai): §14
        # selected muse-ai, and the restart test confirms the
        # persisted choice is echo-ai.
        c.send("SELECT echo-ai")
        check("SELECT echo-ai back (leave for restart)",
              c.readline() == "OK selected echo-ai")

        # 16. God mode (P2): the two-step confirm, the marker, the
        #     god grant, the audit log, and the INSTALL / UNINSTALL /
        #     REBOOT executors. §2 already proved STATUS reports
        #     god_mode=off on a fresh start.
        cli_god = {**os.environ,
                   "SEVYN_AI_SOCK": str(sock_path),
                   "SEVYN_AI_GOD_GRANT": str(god_grant),
                   "SEVYN_AI_GOD_MARKER": str(god_marker),
                   "SEVYN_AI_GOD_GRANT_TEMPLATE": str(god_template),
                   "SEVYN_AI_AUDIT_LOG": str(audit_log)}

        # 16b. A bare `god on` refuses (the two-step confirm, D1):
        #      it prints the powers and exits 1, and no marker is
        #      created.
        bare = subprocess.run([str(sevyn_bin), "ai", "god", "on"],
                              capture_output=True, text=True,
                              env=cli_god, timeout=10)
        check("bare `god on` refuses (exit 1, powers printed)",
              bare.returncode != 0 and
              "install and uninstall apps" in bare.stderr,
              bare.stdout + bare.stderr)
        check("bare `god on` created no marker", not god_marker.exists())

        # 16c. `god on --confirm` enables: the marker is written,
        #      the daemon reloads under the 11-permission god grant,
        #      the boot-style line + the audit enable event land.
        on = subprocess.run(
            [str(sevyn_bin), "ai", "god", "on", "--confirm",
             "--via", "cli"],
            capture_output=True, text=True, env=cli_god, timeout=10)
        check("`god on --confirm` succeeds",
              on.returncode == 0, on.stdout + on.stderr)
        marker_json = (json.loads(god_marker.read_text())
                       if god_marker.exists() else {})
        check("marker written (god_mode true, via cli)",
              marker_json.get("god_mode") is True and
              marker_json.get("enabled_by") == "cli",
              god_marker.read_text() if god_marker.exists() else "(none)")
        c.send("STATUS")
        status = c.readline()
        check("STATUS god_mode=on + 11-perm god grant",
              "god_mode=on" in status and
              "app.uninstall" in status and
              "app.install" in status and
              "system.reboot" in status and
              "file.write" in status and
              "system.update" in status, status)
        check("daemon logged god mode active",
              wait_for("god active",
                       lambda: "AID god mode active" in log_text()))
        check("statusd was SET ai.god_mode on (the tray mark)",
              wait_recorded(fake_statusd, "SET ai.god_mode on"))
        check("audit log has the GOD_MODE ON event",
              audit_log.exists() and
              "GOD_MODE ON" in audit_log.read_text(),
              audit_log.read_text() if audit_log.exists() else "(none)")

        # 16d. UNINSTALL runs under god mode (through appd).
        c.send("ASK uninstall files")
        check("ASK uninstall files, god on -> allowed=1",
              c.readline() ==
              "OK backend=echo-ai allowed=1 denied=0 failed=0")
        check("appd saw UNINSTALL files",
              wait_recorded(fake_appd, "UNINSTALL files"))

        # 16e. INSTALL runs under god mode (through appd).
        c.send("ASK install /tmp/test.sevyn")
        check("ASK install, god on -> allowed=1",
              c.readline() ==
              "OK backend=echo-ai allowed=1 denied=0 failed=0")
        check("appd saw INSTALL /tmp/test.sevyn",
              wait_recorded(fake_appd, "INSTALL /tmp/test.sevyn"))

        # 16f. The protected-apps guard: UNINSTALL terminal is a
        #      denial, never reaches appd, and is logged distinctly.
        c.send("ASK uninstall terminal")
        check("ASK uninstall terminal -> denied=1",
              c.readline() ==
              "OK backend=echo-ai allowed=0 denied=1 failed=0")
        check("appd never saw UNINSTALL terminal",
              "UNINSTALL terminal" not in fake_appd.recorded())
        check("protected app denial logged",
              "AID DENIED echo-ai UNINSTALL terminal (protected app)"
              in log_text())

        # 16g. REBOOT runs under god mode (the existing `sevyn
        #      reboot` path — the fake CLI records the invocation).
        c.send("ASK reboot")
        check("ASK reboot, god on -> allowed=1",
              c.readline() ==
              "OK backend=echo-ai allowed=1 denied=0 failed=0")
        check("fake CLI saw reboot",
              cli_calls.exists() and
              "reboot" in cli_calls.read_text(),
              cli_calls.read_text() if cli_calls.exists() else "(none)")

        # 16h. The audit log records the god-mode actions, and
        #      `sevyn ai audit` prints them.
        audit_text = audit_log.read_text()
        check("audit log records the god-mode actions",
              "UNINSTALL files" in audit_text and
              "INSTALL /tmp/test.sevyn" in audit_text and
              "REBOOT" in audit_text and
              "UNINSTALL terminal" in audit_text, audit_text)
        audit_cli = subprocess.run([str(sevyn_bin), "ai", "audit"],
                                   capture_output=True, text=True,
                                   env=cli_god, timeout=10)
        check("`sevyn ai audit` prints the log (exit 0)",
              audit_cli.returncode == 0 and
              "UNINSTALL files" in audit_cli.stdout,
              audit_cli.stdout + audit_cli.stderr)

        # 16i. `god off` revokes: the marker is deleted, the daemon
        #      reloads under the standard grant, and UNINSTALL is
        #      denied again.
        off = subprocess.run([str(sevyn_bin), "ai", "god", "off"],
                             capture_output=True, text=True,
                             env=cli_god, timeout=10)
        check("`god off` succeeds",
              off.returncode == 0, off.stdout + off.stderr)
        check("marker removed by `god off`", not god_marker.exists())
        c.send("STATUS")
        status = c.readline()
        check("STATUS god_mode=off + standard grant again",
              "god_mode=off" in status and
              "app.uninstall" not in status, status)
        check("daemon logged god mode off",
              wait_for("god off",
                       lambda: "AID god mode off" in log_text()))
        check("statusd was SET ai.god_mode off",
              wait_recorded(fake_statusd, "SET ai.god_mode off"))
        check("audit log has the GOD_MODE OFF event",
              "GOD_MODE OFF" in audit_log.read_text())
        c.send("ASK uninstall files")
        check("ASK uninstall files, god off -> denied=1",
              c.readline() ==
              "OK backend=echo-ai allowed=0 denied=1 failed=0")

        # 16j. Marker present + corrupt god grant: RELOAD falls back
        #      to the standard grant and logs it — god mode does not
        #      come on from a grant the daemon cannot parse.
        god_marker.write_text(
            '{"god_mode": true, "enabled_at": "2026-11-25T00:00:00Z", '
            '"enabled_by": "cli"}')
        god_grant.write_text('{"permissions": "not-an-array"}')
        c.send("RELOAD")
        check("RELOAD with corrupt god grant -> OK",
              c.readline().startswith("OK grant reloaded"))
        c.send("STATUS")
        status = c.readline()
        check("corrupt god grant falls back to standard (god_mode=off)",
              "god_mode=off" in status and
              "app.uninstall" not in status, status)
        check("invalid god grant logged",
              "AID god grant invalid, standard grant in force"
              in log_text())

        # Leave god mode ON at the end of §16: the §12 restart below
        # proves the marker survives a daemon restart (the CLI
        # re-copies the template over the corrupt god grant).
        on2 = subprocess.run(
            [str(sevyn_bin), "ai", "god", "on", "--confirm",
             "--via", "cli"],
            capture_output=True, text=True, env=cli_god, timeout=10)
        check("re-enable god mode for the restart proof",
              on2.returncode == 0, on2.stdout + on2.stderr)
        c.send("STATUS")
        check("STATUS god_mode=on before the restart",
              "god_mode=on" in c.readline())

        # 16k. Audit fail-closed: a second daemon whose audit log
        #      sits under a path whose parent is a file can never
        #      write the log, so its actions are refused, not run
        #      unlogged.
        not_a_dir = tmp / "not-a-dir"
        not_a_dir.write_text("a file, not a directory\n")
        fc_sock = tmp / "fc.sock"
        fc_ctl = tmp / "fc-ctl"
        os.mkfifo(fc_ctl)
        fc_selected = tmp / "fc-selected.json"
        fc_log = open(tmp / "aid-fc.log", "w")
        fc_env = {**env,
                  "SEVYN_AI_SOCK": str(fc_sock),
                  "SEVYN_AI_CTL": str(fc_ctl),
                  "SEVYN_AI_SELECTED": str(fc_selected),
                  "SEVYN_AI_AUDIT_LOG": str(not_a_dir / "ai-audit.log")}
        fc = subprocess.Popen([str(aid_bin)], env=fc_env,
                              stdout=fc_log, stderr=subprocess.STDOUT)
        try:
            def fc_log_text():
                fc_log.flush()
                return (tmp / "aid-fc.log").read_text(errors="replace")

            check("fail-closed daemon starts (god mode on from marker)",
                  wait_for("fc ready",
                           lambda: "AID ready" in fc_log_text()))
            launches_before = len(
                [line for line in fake_appd.recorded()
                 if line.startswith("LAUNCH ")])
            fc_c = SockClient(str(fc_sock))
            fc_c.send("ASK launch files")
            check("ASK with unwritable audit log -> failed=1",
                  fc_c.readline() ==
                  "OK backend=echo-ai allowed=0 denied=0 failed=1")
            fc_c.close()
            check("appd never saw the refused LAUNCH",
                  len([line for line in fake_appd.recorded()
                       if line.startswith("LAUNCH ")]) == launches_before)
            check("audit failure logged",
                  "AID AUDIT FAIL echo-ai LAUNCH files" in fc_log_text())
        finally:
            fc.send_signal(signal.SIGTERM)
            try:
                fc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                fc.kill()
                fc.wait()
            fc_log.close()

        ctl_w.close()
        c.close()
    finally:
        aid.send_signal(signal.SIGTERM)
        try:
            aid.wait(timeout=5)
        except subprocess.TimeoutExpired:
            aid.kill()
            aid.wait()
        aid_log.close()

    check("aid exits 0 on SIGTERM", aid.returncode == 0,
          f"rc={aid.returncode}")
    check("socket file removed on exit", not sock_path.exists())

    # 12. Persistence across restart: the selection made in step 8
    #     (plan-ai) was overwritten by the ctl SELECT in step 11, so
    #     restart and confirm echo-ai is the persisted choice.
    aid_log2 = open(tmp / "aid2.log", "w")
    aid2 = subprocess.Popen([str(aid_bin)], env=env, stdout=aid_log2,
                            stderr=subprocess.STDOUT)
    try:
        def log2():
            aid_log2.flush()
            return (tmp / "aid2.log").read_text(errors="replace")

        check("restart keeps persisted selection (echo-ai)", wait_for(
            "restart ready",
            lambda: "selected=echo-ai" in log2()))
        # P2: god mode was left ON at the end of §16, so the marker
        # survives the restart — the daemon starts under the god
        # grant and logs it, never silently.
        check("restart logs god mode active (marker survives)",
              wait_for("god active on restart",
                       lambda: "AID god mode active" in log2()))
        check("restart socket exists", wait_for(
            "aid2 socket", lambda: sock_path.exists()))
        c2 = SockClient(str(sock_path))
        c2.send("STATUS")
        check("restart STATUS god_mode=on",
              "god_mode=on" in c2.readline())
        c2.close()
    finally:
        aid2.send_signal(signal.SIGTERM)
        try:
            aid2.wait(timeout=5)
        except subprocess.TimeoutExpired:
            aid2.kill()
            aid2.wait()
        aid_log2.close()
    check("second aid exits 0 on SIGTERM", aid2.returncode == 0,
          f"rc={aid2.returncode}")

    # 13. Bad grant: fail-closed — the daemon refuses to start.
    #     P2: the marker is still present (god mode was left on at
    #     the end of §16), so this also proves a bad standard grant
    #     refuses to start even with god mode on — god mode does not
    #     rescue a broken standard grant.
    check("marker still present for the bad-grant run (god mode on)",
          god_marker.exists())
    bad_grant = tmp / "bad-grant.json"
    bad_grant.write_text('{"permissions": "not-an-array"}')
    bad_env = {**env, "SEVYN_AI_GRANT": str(bad_grant),
               "SEVYN_AI_SOCK": str(tmp / "bad.sock")}
    bad = subprocess.run([str(aid_bin)], env=bad_env,
                         capture_output=True, text=True, timeout=10)
    check("bad grant -> non-zero exit (fail-closed)",
          bad.returncode != 0, f"rc={bad.returncode}")
    check("bad grant logged",
          "AID fatal" in bad.stderr)

    fake_appd.close()
    fake_statusd.close()
    fake_api.stop()

    # 17. Relay 1a: `sevyn tailscale status` (read-only) + the
    #     first_up_iface tailscale0 exclusion. The CLI shells out
    #     to the staged `tailscale` binary, so the test fakes that
    #     binary on PATH (canned output per scenario) and drives
    #     the real `sevyn` build.
    fake_ts_dir = tmp / "fake-tailscale"
    fake_ts_dir.mkdir()
    fake_ts = fake_ts_dir / "tailscale"
    fake_ts.write_text(
        "#!/bin/sh\n"
        "# 1b: up/down/logout are driven by their own scenario vars\n"
        "# (default: success). The interactive `up` prints the auth\n"
        "# URL, then sleeps — the CLI streams it to the auth-URL\n"
        "# file while the join waits, so the test can observe the\n"
        "# file mid-join.\n"
        "case \"$1\" in\n"
        "  up)\n"
        "    case \"$TAILSCALE_FAKE_UP\" in\n"
        "      fail)\n"
        "        echo \"error: login failed\" >&2\n"
        "        exit 1;;\n"
        "      auth-url)\n"
        "        echo \"To authenticate, visit:\"\n"
        "        echo \"\"\n"
        "        echo \"        https://headscale.example.com/auth/TESTKEY123\"\n"
        "        echo \"\"\n"
        "        echo \"Success.\"\n"
        "        sleep 2\n"
        "        exit 0;;\n"
        "      *)\n"
        "        exit 0;;\n"
        "    esac;;\n"
        "  down)\n"
        "    case \"$TAILSCALE_FAKE_DOWN\" in\n"
        "      fail)\n"
        "        echo \"error: no daemon\" >&2\n"
        "        exit 1;;\n"
        "      *)\n"
        "        exit 0;;\n"
        "    esac;;\n"
        "  logout)\n"
        "    case \"$TAILSCALE_FAKE_LOGOUT\" in\n"
        "      fail)\n"
        "        echo \"error: logout failed\" >&2\n"
        "        exit 1;;\n"
        "      *)\n"
        "        exit 0;;\n"
        "    esac;;\n"
        "  status)\n"
        "    case \"$TAILSCALE_FAKE_SCENARIO\" in\n"
        "      logged-out)\n"
        "        echo \"Logged out.\"\n"
        "        echo \"Log in at: https://login.tailscale.com/a/test\"\n"
        "        exit 0;;\n"
        "      running)\n"
        "        echo \"# Health check:\"\n"
        "        echo \"#     - warning example, skipped by the parser\"\n"
        "        echo \"100.64.0.5 sevynos-gf65 kevon@ linux -\"\n"
        "        echo \"100.64.0.6 muse kevon@ linux active; direct "
        "10.0.2.2:41641, tx 123 rx 456\"\n"
        "        echo \"100.64.0.7 phone kevon@ iOS idle\"\n"
        "        exit 0;;\n"
        "      stopped)\n"
        "        echo \"Tailscale is stopped.\"\n"
        "        exit 1;;\n"
        "      garbage)\n"
        "        echo \"hello world\"\n"
        "        exit 0;;\n"
        "    esac;;\n"
        "esac\n"
        "echo \"unknown scenario\" >&2\n"
        "exit 2\n")
    fake_ts.chmod(0o755)
    empty_path = tmp / "empty-path"
    empty_path.mkdir()

    def tailscale_status(scenario=None, with_fake=True):
        env = {**os.environ}
        if with_fake:
            env["PATH"] = f"{fake_ts_dir}:{os.environ['PATH']}"
        else:
            # No `tailscale` anywhere on PATH (an empty dir, not
            # a scrubbed system PATH — a system install must not
            # leak in): the verb must report "not installed".
            env["PATH"] = str(empty_path)
        if scenario is not None:
            env["TAILSCALE_FAKE_SCENARIO"] = scenario
        return subprocess.run(
            [str(sevyn_bin), "tailscale", "status"],
            capture_output=True, text=True, env=env, timeout=10)

    out = tailscale_status("logged-out")
    check("tailscale status (logged out) -> 'not logged in', exit 0",
          out.returncode == 0 and
          "status: not logged in" in out.stdout, out.stdout + out.stderr)
    out = tailscale_status("running")
    check("tailscale status (running) -> tailnet + peers + dns",
          out.returncode == 0 and
          "status: running" in out.stdout and
          "tailnet: 100.64.0.5" in out.stdout and
          "hostname: sevynos-gf65" in out.stdout and
          "peers: 2" in out.stdout and
          "peer: 100.64.0.6 muse" in out.stdout and
          "peer: 100.64.0.7 phone" in out.stdout and
          "dns: " in out.stdout,
          out.stdout + out.stderr)
    out = tailscale_status("stopped")
    check("tailscale status (stopped) -> 'stopped', exit 0",
          out.returncode == 0 and
          "status: stopped" in out.stdout, out.stdout + out.stderr)
    out = tailscale_status("garbage")
    check("tailscale status (garbage output) -> exit 1",
          out.returncode != 0 and
          "unexpected tailscale status output" in out.stderr,
          out.stdout + out.stderr)
    out = tailscale_status(with_fake=False)
    check("tailscale status (binary missing) -> exit 1, 'not installed'",
          out.returncode != 0 and
          "tailscale not installed" in out.stderr,
          out.stdout + out.stderr)
    bogus = subprocess.run(
        [str(sevyn_bin), "tailscale", "up"], capture_output=True,
        text=True, timeout=10)
    check("sevyn tailscale up (no --login-server) -> usage",
          bogus.returncode != 0)

    # 17b. first_up_iface skips tailscale* interfaces: in a user
    #      namespace (no privilege needed — unshare -rn), create a
    #      tailscale0 veth FIRST (lowest ifindex, so getifaddrs
    #      returns it first) with a 100.x address, then eth0 with
    #      a 10.x address, both up. The namespace's interfaces are
    #      invisible to the host's /sys, so operstate comes from a
    #      fake tree via SEVYN_SYS_CLASS_NET (the test hook in
    #      first_up_iface). `net status` must still report eth0 —
    #      and with tailscale0 as the only up interface, "none".
    #      Skips (never fails) when unshare/ip is unavailable or
    #      the namespace setup itself fails.
    if shutil.which("unshare") and shutil.which("ip"):
        fake_sys = tmp / "fakesys"
        (fake_sys / "tailscale0").mkdir(parents=True)
        (fake_sys / "eth0").mkdir(parents=True)
        (fake_sys / "tailscale0" / "operstate").write_text("up\n")
        (fake_sys / "eth0" / "operstate").write_text("up\n")

        def ns_script(name, ifaces):
            p = tmp / name
            lines = ["#!/bin/sh"]
            for iface, peer, addr in ifaces:
                lines.append(
                    f"ip link add {iface} type veth peer name {peer} "
                    "|| exit 1")
                lines.append(f"ip link set {peer} up || exit 1")
                lines.append(f"ip addr add {addr} dev {iface} || exit 1")
                lines.append(f"ip link set {iface} up || exit 1")
            lines.append(
                f"SEVYN_SYS_CLASS_NET={fake_sys} {sevyn_bin} net status")
            p.write_text("\n".join(lines) + "\n")
            p.chmod(0o755)
            return p

        both = subprocess.run(
            ["unshare", "-rn", str(ns_script(
                "ns-both.sh",
                [("tailscale0", "tspeer", "100.64.0.99/32"),
                 ("eth0", "ethpeer", "10.0.2.15/24")]))],
            capture_output=True, text=True, timeout=15)
        if both.returncode != 0 or "interface:" not in both.stdout:
            print("  skip: first_up_iface namespace probe "
                  "(unshare/ip unavailable here)")
            print(f"        rc={both.returncode} out={both.stdout!r} "
                  f"err={both.stderr!r}")
        else:
            check("net status skips tailscale0, reports eth0",
                  "interface: eth0" in both.stdout and
                  "address: 10.0.2.15" in both.stdout, both.stdout)
            only = subprocess.run(
                ["unshare", "-rn", str(ns_script(
                    "ns-only.sh",
                    [("tailscale0", "tspeer", "100.64.0.99/32")]))],
                capture_output=True, text=True, timeout=15)
            check("net status with only tailscale0 up -> interface: none",
                  "interface: none" in only.stdout, only.stdout)
    else:
        print("  skip: first_up_iface namespace probe (no unshare/ip)")

    # 17c. Host-side tailscaled smoke (optional): if a real
    #      tailscaled binary is on PATH, prove it starts in
    #      userspace-networking mode (no TUN, no routes, no
    #      resolv.conf changes — no hardware, no network) and its
    #      socket appears. Absent in the sandbox and in CI, so
    #      this skips there; the guest check is the real proof.
    tsd = shutil.which("tailscaled")
    if tsd is None:
        print("  skip: tailscaled userspace smoke (no tailscaled on PATH)")
    else:
        ts_state = tmp / "ts-state"
        ts_state.mkdir()
        ts_sock = tmp / "ts.sock"
        proc = subprocess.Popen(
            [tsd, "--tun=userspace-networking",
             f"--statedir={ts_state}", f"--socket={ts_sock}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            up = wait_for("tailscaled socket",
                          lambda: ts_sock.exists(), timeout=10)
            check("tailscaled userspace-networking starts (socket appears)",
                  up)
            ver = subprocess.run([tsd, "--version"], capture_output=True,
                                 text=True, timeout=10)
            check("tailscaled --version runs",
                  ver.returncode == 0 and ver.stdout.strip() != "",
                  ver.stdout + ver.stderr)
        finally:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    # 18. Relay 1b: `sevyn tailscale up/down/revoke`, the /data
    #     marker (R6), the statusd ai.relay mark, and the pending
    #     auth-URL file. The fake statusd was closed before §17,
    #     so §18 starts a fresh one on its own socket.
    relay_status_sock = tmp / "relay-status.sock"
    relay_statusd = FakeDaemon(str(relay_status_sock), statusd_handler)
    relay_statusd.start()
    relay_marker = tmp / "relay.json"
    relay_auth_url = tmp / "relay-auth-url"

    def relay_env(up=None, down=None, logout=None):
        env = {**os.environ,
               "PATH": f"{fake_ts_dir}:{os.environ['PATH']}",
               "SEVYN_AI_RELAY_MARKER": str(relay_marker),
               "SEVYN_AI_RELAY_AUTH_URL": str(relay_auth_url),
               "SEVYN_STATUS_SOCK": str(relay_status_sock)}
        if up is not None:
            env["TAILSCALE_FAKE_UP"] = up
        if down is not None:
            env["TAILSCALE_FAKE_DOWN"] = down
        if logout is not None:
            env["TAILSCALE_FAKE_LOGOUT"] = logout
        return env

    def relay_run(args, env):
        return subprocess.run(
            [str(sevyn_bin), "tailscale"] + args,
            capture_output=True, text=True, env=env, timeout=15)

    login = "https://headscale.example.com"

    # 18a. A bare `up` refuses (the two-step confirm): it prints
    #      what joining exposes and exits 1, and no marker is
    #      created.
    out = relay_run(["up", "--login-server", login], relay_env())
    check("bare `tailscale up` refuses (exit 1, exposure printed)",
          out.returncode != 0 and
          "any node the tailnet ACL allows" in out.stderr,
          out.stdout + out.stderr)
    check("bare `up` created no marker", not relay_marker.exists())

    # 18b. `up` without a login server, and with a non-http(s)
    #      server, are usage errors.
    out = relay_run(["up", "--authkey", "hskey-test", "--confirm"],
                    relay_env())
    check("`up` without --login-server -> usage",
          out.returncode != 0)
    out = relay_run(["up", "--login-server", "headscale.example.com",
                     "--authkey", "hskey-test", "--confirm"], relay_env())
    check("`up` with a non-URL login server -> exit 1",
          out.returncode != 0 and
          "--login-server must be an http(s) URL" in out.stderr,
          out.stdout + out.stderr)

    # 18c. `up --authkey --confirm` joins: the marker is written
    #      (login server + via), and `status` reports relay: enabled
    #      + the login server. Phase 2 moved ai.relay ownership:
    #      joining the tailnet no longer SETs ai.relay — that key is
    #      the relay SESSION state (daemon + `ai relay` own it), so
    #      the join must leave the statusd log untouched.
    out = relay_run(["up", "--login-server", login,
                     "--authkey", "hskey-test", "--confirm", "--via",
                     "cli"], relay_env())
    check("`up --authkey --confirm` succeeds",
          out.returncode == 0 and "Joined the tailnet." in out.stdout,
          out.stdout + out.stderr)
    marker_json = (json.loads(relay_marker.read_text())
                   if relay_marker.exists() else {})
    check("relay marker written (login server + via cli)",
          marker_json.get("relay") is True and
          marker_json.get("login_server") == login and
          marker_json.get("enabled_by") == "cli",
          relay_marker.read_text() if relay_marker.exists()
          else "(none)")
    check("`up` SETs no ai.relay (ownership moved to daemon + ai relay)",
          wait_no_recorded(relay_statusd, "SET ai.relay"))
    out = relay_run(["status"], {**relay_env(),
                                 "TAILSCALE_FAKE_SCENARIO": "running"})
    check("status after join -> relay: enabled + login_server",
          out.returncode == 0 and
          "relay: enabled" in out.stdout and
          f"login_server: {login}" in out.stdout,
          out.stdout + out.stderr)
    # The marker is the intent, not the live state: it survives a
    # logged-out daemon.
    out = relay_run(["status"], {**relay_env(),
                                 "TAILSCALE_FAKE_SCENARIO": "logged-out"})
    check("status (logged out, marker present) -> relay: enabled",
          out.returncode == 0 and
          "status: not logged in" in out.stdout and
          "relay: enabled" in out.stdout,
          out.stdout + out.stderr)

    # 18d. `up` with a failing login: exit 1, no marker.
    relay_marker.unlink()
    out = relay_run(["up", "--login-server", login,
                     "--authkey", "hskey-bad", "--confirm"],
                    relay_env(up="fail"))
    check("`up` with a failing login -> exit 1, no marker",
          out.returncode != 0 and not relay_marker.exists(),
          out.stdout + out.stderr)

    # 18e. `up --file`: the key is read from the file (which the
    #      CLI unlinks at once) and the join succeeds.
    key_file = tmp / "relay-key.txt"
    key_file.write_text("hskey-from-file\n")
    out = relay_run(["up", "--login-server", login,
                     "--file", str(key_file), "--confirm"],
                    relay_env())
    check("`up --file` succeeds and unlinks the key file",
          out.returncode == 0 and not key_file.exists(),
          out.stdout + out.stderr)
    check("marker written after --file join", relay_marker.exists())

    # 18f. Interactive login: `up` without an authkey prints the
    #      auth URL and waits; the URL lands in the auth-URL file
    #      while the join is still waiting, and the file is gone
    #      once the join completes.
    relay_marker.unlink()
    proc = subprocess.Popen(
        [str(sevyn_bin), "tailscale", "up", "--login-server", login,
         "--confirm"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env=relay_env(up="auth-url"))
    try:
        seen = wait_for("auth-URL file while joining",
                        lambda: relay_auth_url.exists(), timeout=10)
        check("auth-URL file appears mid-join",
              seen and "https://headscale.example.com/auth/TESTKEY123"
              in relay_auth_url.read_text(),
              relay_auth_url.read_text() if relay_auth_url.exists()
              else "(none)")
        rc = proc.wait(timeout=15)
        check("interactive `up` succeeds after approval",
              rc == 0)
        check("auth-URL file removed after the join",
              not relay_auth_url.exists())
        check("marker written after the interactive join",
              relay_marker.exists())
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()

    # 18g. `down` leaves: the marker is removed, and `status`
    #      reports relay: disabled. Leaving the tailnet ends the
    #      transport only — it no longer SETs ai.relay (Phase 2
    #      ownership: the daemon + `ai relay` own that key).
    out = relay_run(["down"], relay_env())
    check("`down` succeeds",
          out.returncode == 0 and "Left the tailnet." in out.stdout,
          out.stdout + out.stderr)
    check("marker removed by `down`", not relay_marker.exists())
    check("`down` SETs no ai.relay (ownership moved to daemon + ai relay)",
          wait_no_recorded(relay_statusd, "SET ai.relay"))
    out = relay_run(["status"], {**relay_env(),
                                 "TAILSCALE_FAKE_SCENARIO": "logged-out"})
    check("status after down -> relay: disabled",
          out.returncode == 0 and
          "relay: disabled" in out.stdout,
          out.stdout + out.stderr)

    # 18h. `down` with a dead daemon (the kill switch): the
    #      disconnect fails, but the marker is still removed and
    #      the verb succeeds — the device must not re-join at boot.
    relay_marker.write_text(
        '{"relay": true, "login_server": "%s", '
        '"joined_at": "2026-11-25T00:00:00Z", '
        '"enabled_by": "cli"}\n' % login)
    out = relay_run(["down"], relay_env(down="fail"))
    check("`down` with a dead daemon still removes the marker",
          out.returncode == 0 and not relay_marker.exists(),
          out.stdout + out.stderr)

    # 18i. `revoke` needs --confirm; with it, the node is
    #      forgotten and the marker is removed. (Phase 2: revoke no
    #      longer SETs ai.relay — the daemon + `ai relay` own it.)
    relay_marker.write_text(
        '{"relay": true, "login_server": "%s", '
        '"joined_at": "2026-11-25T00:00:00Z", '
        '"enabled_by": "cli"}\n' % login)
    out = relay_run(["revoke"], relay_env())
    check("bare `revoke` refuses (exit 1, marker kept)",
          out.returncode != 0 and relay_marker.exists(),
          out.stdout + out.stderr)
    out = relay_run(["revoke", "--confirm"], relay_env())
    check("`revoke --confirm` succeeds and removes the marker",
          out.returncode == 0 and
          "Tailnet revoked." in out.stdout and
          not relay_marker.exists(),
          out.stdout + out.stderr)

    # 18j. `revoke --confirm` with a failing logout is strict:
    #      exit 1, the marker stays (no half-forgotten node).
    relay_marker.write_text(
        '{"relay": true, "login_server": "%s", '
        '"joined_at": "2026-11-25T00:00:00Z", '
        '"enabled_by": "cli"}\n' % login)
    out = relay_run(["revoke", "--confirm"], relay_env(logout="fail"))
    check("`revoke --confirm` with a failing logout keeps the marker",
          out.returncode != 0 and relay_marker.exists(),
          out.stdout + out.stderr)

    relay_statusd.close()

    # 19. Relay Phase 2: `sevyn ai relay on|off|status|revoke|pair`
    #     and the daemon's via=relay marking. No tailnet, no network:
    #     `on` binds loopback (--bind 127.0.0.1), the agent is a sleep
    #     stand-in, and the relay client is a small C binary NAMED
    #     sevyn-relay — the daemon detects the relay by the peer
    #     exe basename (SO_PEERCRED + /proc/<pid>/exe) — driving
    #     SESSIONs against a second daemon instance booted with the
    #     agent marker present.
    import base64
    import hashlib

    s19 = tmp / "s19"
    s19.mkdir()
    r_key = s19 / "relay-key"
    r_key_pub = s19 / "relay-key.pub"
    r_peer_pub = s19 / "relay-peer.pub"
    r_pending = s19 / "relay-pending.json"
    r_marker = s19 / "relay-agent.json"
    r_pidfile = s19 / "sevyn-relay.pid"
    r_audit = s19 / "ai-audit.log"
    r_screen = s19 / "relay-screen.json"
    s19_sock = s19 / "aid.sock"
    s19_ctl = s19 / "ctl"
    os.mkfifo(s19_ctl)
    s19_status_sock = s19 / "status.sock"
    s19_appd_sock = s19 / "appd.sock"
    s19_statusd = FakeDaemon(str(s19_status_sock), statusd_handler)
    s19_appd = FakeDaemon(str(s19_appd_sock), appd_handler)
    s19_statusd.start()
    s19_appd.start()

    # The sleep stand-in agent: it behaves like the real agent
    # (which writes its own pidfile — main.rs:162 — the CLI only
    # reads it), then stays alive until SIGTERM (the `off` kill
    # switch). The CLI passes --bind/--port only, so the pidfile
    # path comes from the inherited SEVYN_RELAY_PIDFILE env, the
    # same override the CLI reads.
    sleep_agent = s19 / "sleep-agent"
    sleep_agent.write_text(
        "#!/bin/sh\n"
        "echo $$ > \"$SEVYN_RELAY_PIDFILE\"\n"
        "sleep 60\n")
    sleep_agent.chmod(0o755)

    def r_env(agent=None):
        env = {**os.environ,
               "PATH": f"{fake_ts_dir}:{os.environ['PATH']}",
               "TAILSCALE_FAKE_SCENARIO": "logged-out",
               "SEVYN_AI_SOCK": str(s19_sock),
               "SEVYN_STATUS_SOCK": str(s19_status_sock),
               "SEVYN_AI_RELAY_AGENT_MARKER": str(r_marker),
               "SEVYN_AI_RELAY_KEY": str(r_key),
               "SEVYN_AI_RELAY_KEY_PUB": str(r_key_pub),
               "SEVYN_AI_RELAY_PEER_PUB": str(r_peer_pub),
               "SEVYN_AI_RELAY_PENDING": str(r_pending),
               "SEVYN_AI_RELAY_SCREEN_STATE": str(r_screen),
               "SEVYN_RELAY_PIDFILE": str(r_pidfile)}
        if agent is not None:
            env["SEVYN_RELAY_AGENT_BIN"] = str(agent)
        return env

    def r_cli(args, env):
        return subprocess.run(
            [str(sevyn_bin), "ai", "relay"] + args,
            capture_output=True, text=True, env=env, timeout=15)

    def agent_pid_from_status(out):
        for line in out.splitlines():
            if line.startswith("agent: running (pid ") and \
                    line.endswith(")"):
                try:
                    return int(line[len("agent: running (pid "):-1])
                except ValueError:
                    return None
        return None

    def pid_alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    # 19a. Bare `on` / `revoke` refuse (two-step confirm, D1
    #      style); `pair` with nothing pending refuses; an unknown
    #      action is a usage error. Nothing is created.
    out = r_cli(["on"], r_env())
    check("bare `ai relay on` refuses (exit 1, exposure printed)",
          out.returncode != 0 and
          "To enable the relay agent, run: sevyn ai relay on --confirm"
          in out.stderr, out.stdout + out.stderr)
    out = r_cli(["revoke"], r_env())
    check("bare `ai relay revoke` refuses (exit 1)",
          out.returncode != 0 and
          "sevyn ai relay revoke --confirm" in out.stderr,
          out.stdout + out.stderr)
    out = r_cli(["pair"], r_env())
    check("`ai relay pair` with nothing pending refuses",
          out.returncode != 0 and "nothing to pair" in out.stderr,
          out.stdout + out.stderr)
    out = r_cli(["frobnicate"], r_env())
    check("unknown `ai relay` action -> usage, exit 1",
          out.returncode != 0)
    check("bare verbs created no keypair or marker",
          not r_key.exists() and not r_marker.exists())

    # 19b. `on --confirm --bind 127.0.0.1` with the sleep stand-in:
    #      keypair (seed 32 bytes 0600, pub 32 bytes 0644), marker
    #      (relay_agent true, enabled_by cli), status shows the
    #      fingerprint + unpaired + the live agent pid. The daemon
    #      is not up yet, so status reports it unreachable and
    #      still exits 0. A second `on` is already-on, exit 0.
    out = r_cli(["on", "--confirm", "--bind", "127.0.0.1"],
                r_env(agent=sleep_agent))
    check("`on --confirm --bind` succeeds on port 17893",
          out.returncode == 0 and
          "listening on 127.0.0.1:17893" in out.stdout and
          "Waiting for the cloud agent to pair" in out.stdout,
          out.stdout + out.stderr)
    check("keypair created (seed 32B 0600, pub 32B 0644)",
          r_key.exists() and len(r_key.read_bytes()) == 32 and
          (r_key.stat().st_mode & 0o777) == 0o600 and
          r_key_pub.exists() and len(r_key_pub.read_bytes()) == 32 and
          (r_key_pub.stat().st_mode & 0o777) == 0o644)
    marker_json = json.loads(r_marker.read_text()) \
        if r_marker.exists() else {}
    check("agent marker written (relay_agent true, enabled_by cli)",
          marker_json.get("relay_agent") is True and
          marker_json.get("enabled_by") == "cli",
          r_marker.read_text() if r_marker.exists() else "(none)")
    out = r_cli(["status"], r_env())
    dev_fp = hashlib.sha256(r_key_pub.read_bytes()).hexdigest()
    check("status: enabled + full fingerprint + unpaired + daemon unreachable",
          out.returncode == 0 and
          "relay agent: enabled" in out.stdout and
          f"fingerprint: {dev_fp}" in out.stdout and
          "paired: unpaired" in out.stdout and
          "daemon: unreachable" in out.stdout,
          out.stdout + out.stderr)
    agent_pid = agent_pid_from_status(out.stdout)
    check("status: agent running (pid alive)",
          agent_pid is not None and pid_alive(agent_pid))
    out = r_cli(["on", "--confirm", "--bind", "127.0.0.1"],
                r_env(agent=sleep_agent))
    check("second `on` is already-on, exit 0",
          out.returncode == 0 and
          "Relay agent is already on." in out.stdout,
          out.stdout + out.stderr)

    # 19c. Pairing: the cloud agent's pending file (peer_key +
    #      pairing_code, the code being SHA-256(device_pub ||
    #      peer_pub) first 6 hex) shows in status; bare `pair`
    #      prints the peer fingerprint + code and refuses; `pair
    #      --confirm` pins the peer (0644) and clears the pending.
    #      A pending file with the wrong code is malformed: status
    #      shows no pairing line and `pair` refuses.
    peer_raw = os.urandom(32)
    peer_fp = hashlib.sha256(peer_raw).hexdigest()
    pair_code = hashlib.sha256(
        r_key_pub.read_bytes() + peer_raw).hexdigest()[:6]
    r_pending.write_text(json.dumps({
        "peer_key": base64.b64encode(peer_raw).decode(),
        "pairing_code": pair_code}))
    out = r_cli(["status"], r_env())
    check("status shows the pending pairing (fp16 + code)",
          f"pairing: pending {peer_fp[:16]} code {pair_code}" in out.stdout,
          out.stdout + out.stderr)
    out = r_cli(["pair"], r_env())
    check("bare `pair` prints peer fingerprint + code and refuses",
          out.returncode != 0 and
          f"peer fingerprint: {peer_fp}" in out.stdout and
          f"pairing code: {pair_code}" in out.stdout,
          out.stdout + out.stderr)
    out = r_cli(["pair", "--confirm"], r_env())
    check("`pair --confirm` pins the peer and clears the pending",
          out.returncode == 0 and
          f"Paired with {peer_fp[:16]}." in out.stdout and
          r_peer_pub.exists() and
          len(r_peer_pub.read_bytes()) == 32 and
          (r_peer_pub.stat().st_mode & 0o777) == 0o644 and
          not r_pending.exists(),
          out.stdout + out.stderr)
    out = r_cli(["status"], r_env())
    check("status after pairing shows paired fp16",
          f"paired: {peer_fp[:16]}" in out.stdout,
          out.stdout + out.stderr)
    r_pending.write_text(json.dumps({
        "peer_key": base64.b64encode(peer_raw).decode(),
        "pairing_code": "000000"}))
    out = r_cli(["status"], r_env())
    check("malformed pending (wrong code) shows no pairing line",
          "pairing: pending" not in out.stdout,
          out.stdout + out.stderr)
    out = r_cli(["pair"], r_env())
    check("malformed pending -> `pair` refuses as malformed",
          out.returncode != 0 and
          "malformed" in out.stderr,
          out.stdout + out.stderr)

    # 19d. `off` is the kill switch: the agent process dies, the
    #      marker is removed, statusd is SET ai.relay off. `off`
    #      with an already-dead agent still succeeds.
    out = r_cli(["off"], r_env())
    check("`off` stops the agent and removes the marker",
          out.returncode == 0 and
          "Relay agent off." in out.stdout and
          not r_marker.exists() and
          (agent_pid is None or not pid_alive(agent_pid)),
          out.stdout + out.stderr)
    check("statusd was SET ai.relay off by `off`",
          wait_recorded(s19_statusd, "SET ai.relay off"))
    out = r_cli(["off"], r_env())
    check("`off` with a dead agent still succeeds",
          out.returncode == 0 and "Relay agent off." in out.stdout,
          out.stdout + out.stderr)

    # 19d2. Screen state (relay frames, R8/S2): `status` reads the
    #       agent's screen state file — live since + frames when a
    #       session is delivering frames, off otherwise (missing or
    #       corrupt file). `off` removes the state file and SETs
    #       ai.screen off, so the SCREEN mark clears even when the
    #       agent is already dead (it never runs its teardown on
    #       SIGTERM).
    out = r_cli(["status"], r_env())
    check("status with no screen state reads screen: off",
          out.returncode == 0 and "screen: off" in out.stdout,
          out.stdout + out.stderr)
    r_screen.write_text(json.dumps({
        "screen": "on",
        "agent": peer_fp[:16],
        "session_start": "2026-11-26T07:00:00Z",
        "frames": 3}))
    out = r_cli(["status"], r_env())
    check("status with a live screen state shows since + frames",
          out.returncode == 0 and
          "screen: live since 2026-11-26T07:00:00Z frames=3" in out.stdout,
          out.stdout + out.stderr)
    r_screen.write_text("not json")
    out = r_cli(["status"], r_env())
    check("status with a corrupt screen state reads screen: off",
          out.returncode == 0 and "screen: off" in out.stdout,
          out.stdout + out.stderr)
    r_screen.write_text(json.dumps({
        "screen": "on",
        "agent": peer_fp[:16],
        "session_start": "2026-11-26T07:00:00Z",
        "frames": 1}))
    screen_off_before = sum(1 for c in s19_statusd.recorded()
                            if c == "SET ai.screen off")
    out = r_cli(["off"], r_env())
    check("`off` removes the screen state file",
          out.returncode == 0 and not r_screen.exists(),
          out.stdout + out.stderr)
    check("`off` SET ai.screen off",
          wait_recorded(s19_statusd, "SET ai.screen off") and
          sum(1 for c in s19_statusd.recorded()
              if c == "SET ai.screen off") == screen_off_before + 1)
    out = r_cli(["status"], r_env())
    check("status after `off` reads screen: off",
          out.returncode == 0 and "screen: off" in out.stdout,
          out.stdout + out.stderr)

    # 19e. `on` without --bind refuses when not joined to a
    #      tailnet (the fake prints logged-out); a non-IPv4 --bind
    #      is a usage error; a missing agent binary refuses with
    #      no marker.
    out = r_cli(["on", "--confirm"], r_env(agent=sleep_agent))
    check("`on --confirm` without --bind refuses (not joined)",
          out.returncode != 0 and
          "not joined to a tailnet" in out.stderr and
          not r_marker.exists(),
          out.stdout + out.stderr)
    out = r_cli(["on", "--confirm", "--bind", "not-an-ip"],
                r_env(agent=sleep_agent))
    check("`on --confirm --bind not-an-ip` -> usage error",
          out.returncode != 0 and
          "--bind needs an IPv4 address" in out.stderr,
          out.stdout + out.stderr)
    out = r_cli(["on", "--confirm", "--bind", "127.0.0.1"],
                r_env(agent=s19 / "no-such-agent"))
    check("`on` with a missing agent binary refuses, no marker",
          out.returncode != 0 and
          "cannot start the relay agent" in out.stderr and
          not r_marker.exists(),
          out.stdout + out.stderr)

    # 19f. The daemon side: a second daemon instance booted with
    #      the agent marker present logs "AID relay enabled" and
    #      starts idle (STATUS relay=idle, statusd SET ai.relay
    #      idle at boot). The fake sevyn-relay binary drives
    #      SESSIONs through it.
    r_marker.write_text(
        '{"relay_agent": true, "enabled_at": "2026-11-26T00:00:00Z", '
        '"enabled_by": "cli"}\n')
    s19_env = {**env,
               "SEVYN_AI_SOCK": str(s19_sock),
               "SEVYN_AI_CTL": str(s19_ctl),
               "SEVYN_AI_BACKENDS_DIR": str(backends),
               "SEVYN_AI_GRANT": str(grant),
               "SEVYN_AI_SELECTED": str(s19 / "ai-selected.json"),
               "SEVYN_AI_APPD_SOCK": str(s19_appd_sock),
               "SEVYN_AI_STATUS_SOCK": str(s19_status_sock),
               "SEVYN_AI_KEY_FILE": str(key_file),
               "MUSE_API_BASE": fake_api.url,
               "SEVYN_AI_READ_ROOT": str(read_root),
               "SEVYN_AI_WRITE_ROOT": str(read_root),
               "SEVYN_AI_CLI": str(fake_cli),
               "SEVYN_AI_SETTINGS": str(read_root / "settings.json"),
               "SEVYN_AI_REGISTRY": str(read_root / "registry.json"),
               "SEVYN_AI_LOG": str(s19 / "aid.log"),
               "SEVYN_AI_GOD_GRANT": str(god_grant),
               "SEVYN_AI_GOD_MARKER": str(s19 / "god-mode.json"),
               "SEVYN_AI_AUDIT_LOG": str(r_audit),
               "SEVYN_AI_RELAY_AGENT_MARKER": str(r_marker)}
    s19_log = open(s19 / "aid.log", "w")
    aid2 = subprocess.Popen([str(aid_bin)], env=s19_env, stdout=s19_log,
                            stderr=subprocess.STDOUT)
    c2 = None

    def s19_log_text():
        s19_log.flush()
        return (s19 / "aid.log").read_text(errors="replace")

    def audit_relay_count():
        return (r_audit.read_text(errors="replace").count("via=relay")
                if r_audit.exists() else 0)

    def relay_set_count(state):
        return sum(1 for c in s19_statusd.recorded()
                   if c == f"SET ai.relay {state}")

    try:
        check("second daemon starts with the marker present",
              wait_for("AID ready (s19)",
                       lambda: "AID ready" in s19_log_text()))
        check("daemon logs AID relay enabled at boot",
              "AID relay enabled" in s19_log_text(), s19_log_text())
        check("statusd was SET ai.relay idle at boot",
              wait_recorded(s19_statusd, "SET ai.relay idle"))
        c2 = SockClient(str(s19_sock))
        c2.send("STATUS")
        s19_status = c2.readline()
        check("STATUS relay=idle with the marker present (god off)",
              "relay=idle" in s19_status and
              "god_mode=off" in s19_status, s19_status)
        # The session backend: echo-ai is NOT session-aware (it
        # reads the first stdin line as its task, so the daemon's
        # "SESSION" marker becomes its task and it emits nothing).
        # one-action-ai reads one line and emits the action stored
        # in one-action.txt, so it covers SESSION too — the test
        # rewrites the file per check. (§15 is long done, so the
        # shared file is free to reuse here.)
        c2.send("SELECT one-action-ai")
        check("SELECT one-action-ai for the relay daemon",
              c2.readline() == "OK selected one-action-ai")

        # The fake relay: a minimal SESSION client named
        # sevyn-relay, so the daemon's peer-exe detection marks
        # it via=relay. One reply line per SESSION.
        fake_relay_c = s19 / "fake-relay.c"
        fake_relay_c.write_text(
            "#include <stdio.h>\n"
            "#include <stdlib.h>\n"
            "#include <string.h>\n"
            "#include <sys/socket.h>\n"
            "#include <sys/un.h>\n"
            "#include <unistd.h>\n"
            "int main(int argc, char **argv) {\n"
            "    if (argc < 3) return 2;\n"
            "    int fd = socket(AF_UNIX, SOCK_STREAM, 0);\n"
            "    if (fd < 0) return 1;\n"
            "    struct sockaddr_un a;\n"
            "    memset(&a, 0, sizeof a);\n"
            "    a.sun_family = AF_UNIX;\n"
            "    if (strlen(argv[1]) >= sizeof a.sun_path) return 1;\n"
            "    strcpy(a.sun_path, argv[1]);\n"
            "    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0)\n"
            "        return 1;\n"
            "    FILE *f = fdopen(fd, \"r+\");\n"
            "    if (!f) return 1;\n"
            "    fprintf(f, \"SESSION\");\n"
            "    for (int i = 2; i < argc; i++)\n"
            "        fprintf(f, \" %s\", argv[i]);\n"
            "    fprintf(f, \"\\n\");\n"
            "    fflush(f);\n"
            "    char line[2048];\n"
            "    if (!fgets(line, sizeof line, f)) return 1;\n"
            "    fputs(line, stdout);\n"
            "    return strncmp(line, \"OK \", 3) == 0 ? 0 : 1;\n"
            "}\n")
        fake_relay = s19 / "sevyn-relay"
        fr_build = subprocess.run(
            ["gcc", "-O2", "-Wall", "-Wextra",
             "-o", str(fake_relay), str(fake_relay_c)],
            capture_output=True, text=True)
        check("fake sevyn-relay builds clean",
              fr_build.returncode == 0,
              fr_build.stdout + fr_build.stderr)

        def relay_session(*task_words):
            return subprocess.run(
                [str(fake_relay), str(s19_sock)] + list(task_words),
                capture_output=True, text=True, timeout=15)

        # An allowed action over the relay: the grant applies
        # identically, the audit line gains via=relay, ai.relay
        # goes on for the run and back to idle, and the console
        # line names the relay.
        one_action_file.write_text("LAUNCH files\n")
        before = audit_relay_count()
        on_before = relay_set_count("on")
        idle_before = relay_set_count("idle")
        out = relay_session("launch", "files")
        check("relay SESSION launch files -> allowed=1",
              out.returncode == 0 and
              "OK backend=one-action-ai allowed=1 denied=0 failed=0"
              in out.stdout, out.stdout + out.stderr)
        check("audit gains a via=relay line for the relay action",
              audit_relay_count() == before + 1,
              r_audit.read_text(errors="replace") if r_audit.exists()
              else "(none)")
        check("ai.relay went on then idle around the relay SESSION",
              wait_for("relay on/idle SETs",
                       lambda: relay_set_count("on") == on_before + 1 and
                       relay_set_count("idle") == idle_before + 1,
                       timeout=5))
        check("console SESSION line names via=relay",
              "AID SESSION backend=one-action-ai via=relay" in s19_log_text(),
              s19_log_text())
        c2.send("STATUS")
        s19_status = c2.readline()
        check("STATUS relay=idle after the relay SESSION",
              "relay=idle" in s19_status, s19_status)

        # The grant boundary holds over the relay: UNINSTALL is
        # not in the standard grant, so the relay SESSION is
        # denied — and the denial is still audited via=relay.
        one_action_file.write_text("UNINSTALL files\n")
        before = audit_relay_count()
        out = relay_session("uninstall", "files")
        check("relay SESSION uninstall files -> denied=1 (grant holds)",
              out.returncode == 0 and
              "OK backend=one-action-ai allowed=0 denied=1 failed=0"
              in out.stdout, out.stdout + out.stderr)
        check("denied relay action is still audited via=relay",
              audit_relay_count() == before + 1 and
              "UNINSTALL files" in r_audit.read_text(errors="replace"))

        # Negative control: the SAME session from a non-relay
        # client (this Python process — exe basename python3, not
        # sevyn-relay) is NOT marked via=relay and touches no
        # ai.relay key.
        one_action_file.write_text("LAUNCH files\n")
        before = audit_relay_count()
        on_before = relay_set_count("on")
        c2.send("SESSION launch files")
        check("non-relay SESSION launch files -> allowed=1",
              c2.readline() ==
              "OK backend=one-action-ai allowed=1 denied=0 failed=0")
        check("non-relay SESSION adds no via=relay audit line",
              audit_relay_count() == before)
        check("non-relay SESSION touches no ai.relay key",
              relay_set_count("on") == on_before)
        c2.send("STATUS")
        s19_status = c2.readline()
        check("STATUS relay=idle after the non-relay SESSION",
              "relay=idle" in s19_status, s19_status)

        # 19g. Relay-down: the fake relay against a dead socket
        #      fails fast (no hang, exit 1); `status` against a
        #      dead daemon socket reports unreachable, exit 0.
        out = subprocess.run(
            [str(fake_relay), str(s19 / "no-such.sock"),
             "launch", "files"],
            capture_output=True, text=True, timeout=10)
        check("fake relay against a dead socket fails fast (exit 1)",
              out.returncode == 1)
        out = r_cli(["status"], {**r_env(),
                                 "SEVYN_AI_SOCK": str(s19 / "no-such.sock")})
        check("`status` with the daemon down -> unreachable, exit 0",
              out.returncode == 0 and
              "daemon: unreachable" in out.stdout,
              out.stdout + out.stderr)
    finally:
        aid2.send_signal(signal.SIGTERM)
        try:
            aid2.wait(timeout=5)
        except subprocess.TimeoutExpired:
            aid2.kill()
            aid2.wait()
        s19_log.close()
        if c2 is not None:
            c2.close()
        # s19_statusd stays up: `revoke` (19h) SETs ai.relay off
        # through it after the daemon is gone.
        s19_appd.close()

    # 19h. `revoke --confirm` forgets everything: the keypair,
    #      the pinned peer key, the (malformed) pending file, and
    #      the marker are all deleted, and statusd is SET ai.relay
    #      off. Status afterwards reads disabled/unpaired.
    off_before = sum(1 for c in s19_statusd.recorded()
                     if c == "SET ai.relay off")
    out = r_cli(["revoke", "--confirm"], r_env())
    check("`revoke --confirm` succeeds",
          out.returncode == 0 and
          "Relay pairing revoked." in out.stdout,
          out.stdout + out.stderr)
    check("revoke deleted keypair + peer pin + pending + marker",
          not r_key.exists() and not r_key_pub.exists() and
          not r_peer_pub.exists() and not r_pending.exists() and
          not r_marker.exists())
    check("revoke SET ai.relay off",
          wait_for("revoke SET off",
                   lambda: sum(1 for c in s19_statusd.recorded()
                               if c == "SET ai.relay off") == off_before + 1,
                   timeout=5))
    out = r_cli(["status"], r_env())
    check("status after revoke reads disabled/unpaired",
          out.returncode == 0 and
          "relay agent: disabled" in out.stdout and
          "paired: unpaired" in out.stdout,
          out.stdout + out.stderr)
    s19_statusd.close()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURES: {FAILURES}")
        print(f"work dir kept at {tmp}")
        print("aid log:")
        print((tmp / "aid.log").read_text(errors="replace"))
        return 1
    print("ALL AID TESTS PASS")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
