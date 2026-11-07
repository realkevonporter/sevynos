#!/usr/bin/env python3
"""Host-side tests for sevyn-appd (v2/loader/sevyn-appd.c).

Builds the loader + appd with the host gcc, then drives appd against
a scratch tree with a FAKE host binary (a shell script that logs its
args, prints the APP READY line, then sleeps or exits per
FAKE_HOST_MODE). No QEMU, no Hermes — the CI harness (m3-check)
covers the guest end to end.

Run: python3 v2/loader/test-appd.py
Exit 0 = all checks pass.
"""
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOADER_C = HERE / "sevyn-loader.c"
JSON_C = HERE / "json.c"
APPD_C = HERE / "sevyn-appd.c"
SIGN_C = HERE / "ed25519-sign.c"

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


def sha256_hex(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


def b64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode()


class SockClient:
    """Line-based Unix socket client with a small receive buffer."""

    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(path)
        self.s.settimeout(10)
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

    def read_until(self, prefix, timeout=10.0):
        self.s.settimeout(timeout)
        while True:
            line = self.readline()
            if line.startswith(prefix):
                return line

    def close(self):
        self.s.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-appd-test-"))
    print(f"work dir: {tmp}")
    loader_bin = tmp / "sevyn-loader"
    appd_bin = tmp / "sevyn-appd"
    sign_bin = tmp / "ed25519-sign"
    for src, out in (([LOADER_C, JSON_C], loader_bin),
                     ([APPD_C], appd_bin),
                     ([SIGN_C], sign_bin)):
        build = subprocess.run(
            ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(out),
             *[str(p) for p in src], "-lcrypto"]
            if out != appd_bin else
            ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(out),
             *[str(p) for p in src]],
            capture_output=True, text=True)
        if build.returncode != 0:
            print(f"FAIL: build of {out.name} failed")
            print(build.stdout)
            print(build.stderr)
            return 1
    print("  ok: loader + appd + sign helper build clean (-Wall -Wextra)")

    apps = tmp / "apps"
    pristine = tmp / "pristine"
    trusted = tmp / "trusted"
    run = tmp / "run"
    for d in (apps, pristine, trusted, run):
        d.mkdir()
    sock_path = tmp / "appd.sock"
    ctl_path = tmp / "ctl"
    os.mkfifo(ctl_path)
    fake_host_log = tmp / "fake-host.log"

    # Trusted keypair for the terminal system app.
    priv = tmp / "trusted.pem"
    pub_der = tmp / "trusted.der"
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519",
                    "-out", str(priv)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(priv), "-pubout",
                    "-outform", "DER", "-out", str(pub_der)],
                   check=True, capture_output=True)
    pub = pub_der.read_bytes()[-32:]
    key_id = sha256_hex(pub)[:16]
    (trusted / (key_id + ".pub")).write_bytes(pub)

    def make_bundle(out_path, *, app_id, name, version="1.0.0",
                    system=False, protected=False, permissions=None,
                    sign=False):
        import hashlib
        entry = b"FAKE-HBC-" + app_id.encode()
        manifest = {
            "id": app_id, "name": name, "version": version,
            "entry": "app.hbc", "color": "#3b82f6", "glyph": "F",
            "system": system, "protected": protected,
            "permissions": permissions or [],
            "bundleHash": hashlib.sha256(entry).hexdigest(),
        }
        if sign:
            signed = (f"sevyn-bundle-v1\n{app_id}\n{version}\n"
                      f"{manifest['bundleHash']}\n").encode()
            sig = subprocess.run([str(sign_bin), str(priv)], input=signed,
                                 capture_output=True, check=True).stdout
            manifest["signature"] = {
                "algorithm": "ed25519", "keyId": key_id,
                "publicKey": b64(pub), "value": b64(sig)}
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("manifest.json", json.dumps(manifest))
            z.writestr("app.hbc", entry)
        return manifest

    make_bundle(pristine / "files.sevyn", app_id="files", name="Files",
                permissions=["status.read"])
    make_bundle(pristine / "terminal.sevyn", app_id="terminal",
                name="Terminal", system=True, protected=True, sign=True)

    # Fake host: logs args, prints the ready line, then sleeps (ok) or
    # exits 1 (crash mode). exec sleep so the pid IS the sleeper.
    fake_host = tmp / "fake-host.sh"
    fake_host.write_text(
        "#!/bin/sh\n"
        f"echo \"FAKE-HOST args: $@\" >> \"{fake_host_log}\"\n"
        "echo \"HOST app running (SEVYNOS_M3_APP_READY) $@\"\n"
        "if [ \"$FAKE_HOST_MODE\" = \"crash\" ]; then exit 1; fi\n"
        "exec sleep \"${FAKE_HOST_SLEEP:-30}\"\n")
    fake_host.chmod(0o755)

    env = {
        **os.environ,
        "SEVYN_APPS_DIR": str(apps),
        "SEVYN_PRISTINE_DIR": str(pristine),
        "SEVYN_TRUSTED_KEYS_DIR": str(trusted),
        "SEVYN_RUN_DIR": str(run),
        "SEVYN_LOADER": str(loader_bin),
        "SEVYN_HOST": str(fake_host),
        "SEVYN_APPS_SOCK": str(sock_path),
        "SEVYN_APP_CTL": str(ctl_path),
        "FAKE_HOST_MODE": "ok",
    }
    appd_log = open(tmp / "appd.log", "w")
    appd = subprocess.Popen([str(appd_bin)], env=env, stdout=appd_log,
                            stderr=subprocess.STDOUT)

    def log_text():
        appd_log.flush()
        return (tmp / "appd.log").read_text(errors="replace")

    try:
        # 1. appd starts and seeds the registry from pristine.
        check("appd starts", wait_for(
            "APPD ready", lambda: "APPD ready" in log_text()))
        check("seed installed files", wait_for(
            "seed files", lambda: "APPD seeded files.sevyn" in log_text()))
        check("seed installed terminal", wait_for(
            "seed terminal",
            lambda: "APPD seeded terminal.sevyn" in log_text()))
        reg = json.loads((apps / "registry.json").read_text())
        check("registry seeded with 2 apps",
              {a["id"] for a in reg["apps"]} == {"files", "terminal"})

        # 2. socket: PING + LIST.
        c = SockClient(str(sock_path))
        c.send("PING")
        check("PING -> OK pong", c.readline() == "OK pong")
        c.send("LIST")
        lines = [c.readline(), c.readline(), c.readline()]
        check("LIST returns both apps + OK",
              lines[0].startswith("APP files|") and
              lines[1].startswith("APP terminal|") and lines[2] == "OK list",
              str(lines))

        # 3. subscribe on a second connection; LAUNCH files.
        sub = SockClient(str(sock_path))
        sub.send("SUBSCRIBE")
        check("SUBSCRIBE ok", sub.readline() == "OK subscribed")
        c.send("LAUNCH files")
        check("LAUNCH files ok",
              c.readline() == "OK launched files")
        check("EVENT LAUNCHED files",
              sub.read_until("EVENT LAUNCHED") == "EVENT LAUNCHED files")
        check("app ready line in log", wait_for(
            "APP READY", lambda: "SEVYNOS_M3_APP_READY" in log_text()))
        check("pid file written", (run / "files.pid").exists())
        check("fake host got app args + permissions", wait_for(
            "fake host args",
            lambda: fake_host_log.exists() and
            "--app files" in fake_host_log.read_text() and
            "--name Files" in fake_host_log.read_text() and
            "--color #3b82f6" in fake_host_log.read_text() and
            "--glyph F" in fake_host_log.read_text() and
            "--permissions status.read" in fake_host_log.read_text()))

        # 4. double-launch refused; unknown id refused.
        c.send("LAUNCH files")
        check("double launch refused",
              c.readline() == "ERR already-running")
        c.send("LAUNCH nope")
        check("unknown launch refused",
              c.readline() == "ERR not-installed")

        # 5. CLOSE files; reap + STOPPED event + pid file gone.
        # A CLOSE kills with SIGTERM, so the stop reports "signal 15"
        # (a clean stop, not a crash).
        c.send("CLOSE files")
        check("CLOSE files ok", c.readline() == "OK closed files")
        check("EVENT STOPPED files signal 15",
              sub.read_until("EVENT STOPPED") ==
              "EVENT STOPPED files signal 15")
        check("pid file removed", wait_for(
            "pid gone", lambda: not (run / "files.pid").exists()))
        check("APP STOPPED logged",
              "APP STOPPED files signal 15" in log_text())

        # 6. crash: host exits 1 immediately -> APP CRASHED + event.
        env["FAKE_HOST_MODE"] = "crash"
        # The fake host reads the env at exec time; appd's env is fixed
        # from its own start, so instead flip via a wrapper: rewrite
        # the fake host script to exit 1.
        fake_host.write_text(
            "#!/bin/sh\n"
            f"echo \"FAKE-HOST args: $@\" >> \"{fake_host_log}\"\n"
            "echo \"HOST app running (SEVYNOS_M3_APP_READY) $@\"\n"
            "exit 1\n")
        fake_host.chmod(0o755)
        c.send("LAUNCH files")
        check("LAUNCH crash-app ok", c.readline() == "OK launched files")
        check("EVENT CRASHED files 1",
              sub.read_until("EVENT CRASHED") == "EVENT CRASHED files 1")
        check("APP CRASHED logged", "APP CRASHED files 1" in log_text())

        # 7. socket INSTALL / UNINSTALL / REINSTALL.
        crash_bundle = tmp / "crash.sevyn"
        make_bundle(crash_bundle, app_id="crash", name="Crash")
        c.send(f"INSTALL {crash_bundle}")
        check("socket INSTALL ok",
              c.readline() == f"OK installed {crash_bundle}")
        check("EVENT INSTALLED crash",
              sub.read_until("EVENT INSTALLED") == "EVENT INSTALLED crash")
        c.send("LIST")
        got = [c.readline(), c.readline(), c.readline(), c.readline()]
        check("crash in LIST after install",
              any(l.startswith("APP crash|") for l in got), str(got))
        c.send("UNINSTALL crash")
        check("socket UNINSTALL ok",
              c.readline() == "OK uninstalled crash")
        check("EVENT UNINSTALLED crash",
              sub.read_until("EVENT UNINSTALLED") ==
              "EVENT UNINSTALLED crash")
        c.send("REINSTALL files")
        check("socket REINSTALL ok",
              c.readline() == "OK reinstalled files")

        # 8. control serial: restore the fake host to ok mode first.
        fake_host.write_text(
            "#!/bin/sh\n"
            f"echo \"FAKE-HOST args: $@\" >> \"{fake_host_log}\"\n"
            "echo \"HOST app running (SEVYNOS_M3_APP_READY) $@\"\n"
            "exec sleep \"${FAKE_HOST_SLEEP:-30}\"\n")
        fake_host.chmod(0o755)
        ctl_w = open(ctl_path, "w")
        ctl_w.write("PING\n")
        ctl_w.flush()
        check("ctl PING -> APPD PONG", wait_for(
            "PONG", lambda: "APPD PONG" in log_text()))
        ctl_w.write("LIST\n")
        ctl_w.flush()
        check("ctl LIST logs apps", wait_for(
            "ctl LIST",
            lambda: "APPD LIST files|Files|1.0.0" in log_text()))
        ctl_w.write("LAUNCH files\n")
        ctl_w.flush()
        check("ctl LAUNCH ok", wait_for(
            "ctl LAUNCH OK",
            lambda: "APPD LAUNCH OK files" in log_text()))
        check("ctl launch produced ready line", wait_for(
            "ctl APP READY",
            lambda: log_text().count("SEVYNOS_M3_APP_READY") >= 3))
        ctl_w.write("CLOSE files\n")
        ctl_w.flush()
        check("ctl CLOSE ok", wait_for(
            "ctl CLOSE OK",
            lambda: "APPD CLOSE OK files" in log_text()))
        check("ctl close stopped the app", wait_for(
            "ctl STOPPED",
            lambda: log_text().count("APP STOPPED files signal 15") >= 2))
        ctl_w.write("BOGUS\n")
        ctl_w.flush()
        check("ctl unknown command logged", wait_for(
            "unknown cmd",
            lambda: "APPD unknown command: BOGUS" in log_text()))
        ctl_w.close()
        c.close()
        sub.close()
    finally:
        appd.send_signal(signal.SIGTERM)
        try:
            appd.wait(timeout=5)
        except subprocess.TimeoutExpired:
            appd.kill()
            appd.wait()
        appd_log.close()

    check("appd exits 0 on SIGTERM", appd.returncode == 0,
          f"rc={appd.returncode}")
    check("socket file removed on exit", not sock_path.exists())

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURES: {FAILURES}")
        print(f"work dir kept at {tmp}")
        print("appd log:")
        print((tmp / "appd.log").read_text(errors="replace"))
        return 1
    print("ALL APPD TESTS PASS")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
