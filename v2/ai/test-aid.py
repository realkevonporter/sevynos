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
                       lambda: "backends=chatty-ai,echo-ai,plan-ai,slow-ai "
                       "selected=echo-ai" in log_text()))

        c = SockClient(str(sock_path))

        # 2. socket: PING / LIST / STATUS.
        c.send("PING")
        check("PING -> OK pong", c.readline() == "OK pong")
        c.send("LIST")
        check("LIST -> selected + backends",
              c.readline() ==
              "OK selected=echo-ai backends=chatty-ai,echo-ai,plan-ai,slow-ai")
        c.send("STATUS")
        check("STATUS -> grant csv",
              c.readline() ==
              "OK selected=echo-ai backends=chatty-ai,echo-ai,plan-ai,slow-ai "
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
