#!/usr/bin/env python3
"""Host-side tests for sevyn-aid (v2/ai/sevyn-aid.c).

Builds the AI daemon with the host gcc, then drives it against FAKE
appd + statusd socket servers (threads that record commands and
reply like the real daemons) and the REAL stub backends (echo-ai,
plan-ai) copied from the repo, plus a slow backend (timeout) and a
chatty one (garbage lines, no END). No QEMU, no Hermes — the CI
harness (m4.5-check) covers the guest end to end.

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
         "-o", str(sevyn_bin), str(HERE.parent / "update" / "sevyn.c")],
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
              "grant=app.launch,app.close,app.list,status.set god_mode=off")

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
