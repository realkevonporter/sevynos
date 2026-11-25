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
        f"#!/bin/sh\necho \"$@\" >> {cli_calls}\nexit 0\n")
    fake_cli.chmod(0o755)
    god_grant = tmp / "grant-god.json"
    god_grant.write_text(json.dumps({"permissions": [
        "app.launch", "app.close", "app.list", "status.set",
        "cli.exec", "app.uninstall", "app.install", "system.reboot"]}))
    key_file = tmp / "muse-key"
    key_file.write_text("test-key-abc123\n")
    key_file.chmod(0o600)
    fake_api = FakeMuseAPI()
    fake_api.start()

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
        "SEVYN_AI_CLI": str(fake_cli),
        "SEVYN_AI_SETTINGS": str(read_root / "settings.json"),
        "SEVYN_AI_REGISTRY": str(read_root / "registry.json"),
        "SEVYN_AI_LOG": str(tmp / "aid.log"),
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
                       lambda: "backends=chatty-ai,echo-ai,muse-ai,plan-ai,slow-ai "
                       "selected=echo-ai" in log_text()))

        c = SockClient(str(sock_path))

        # 2. socket: PING / LIST / STATUS.
        c.send("PING")
        check("PING -> OK pong", c.readline() == "OK pong")
        c.send("LIST")
        check("LIST -> selected + backends",
              c.readline() ==
              "OK selected=echo-ai backends=chatty-ai,echo-ai,muse-ai,plan-ai,slow-ai")
        c.send("STATUS")
        check("STATUS -> grant csv",
              c.readline() ==
              "OK selected=echo-ai backends=chatty-ai,echo-ai,muse-ai,plan-ai,slow-ai "
              "grant=app.launch,app.close,app.list,status.set")

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

        # 14g. God-mode-off boundary: a grant-god.json sits next to
        #     the grant (it would allow cli.exec), but god mode is
        #     off, so the standard grant still governs — EXEC denied.
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

        # Leave the selection where §11/§12 expect it (echo-ai): §14
        # selected muse-ai, and the restart test confirms the
        # persisted choice is echo-ai.
        c.send("SELECT echo-ai")
        check("SELECT echo-ai back (leave for restart)",
              c.readline() == "OK selected echo-ai")

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
