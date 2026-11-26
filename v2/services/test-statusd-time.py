#!/usr/bin/env python3
"""Host-side test for the SevynOS system-clock fix (statusd time verbs
+ `sevyn time` CLI).

Runs the REAL statusd and the REAL sevyn CLI — no QEMU, no root, no
clock moves, no /etc writes (except the timezone happy path, which
backs up and restores /etc/timezone when the daemon can write it):

  1. The real statusd on a scratch socket (SEVYN_STATUS_SOCK — the
     M10 second-daemon precedent) proves the protocol: validation
     errors, GET_TIME shape, and the honest EPERM report when the
     (unprivileged) daemon's clock_settime is refused. When run as
     root with CAP_SYS_TIME the set succeeds instead, and the test
     restores the clock afterwards.
  2. A fake NTP server + a fake statusd prove the `sevyn time sync`
     NTP client end to end: packet, four-timestamp offset math, and
     the SET_TIME line the CLI sends. The fake NTP server binds an
     ephemeral UDP port and the CLI is pointed at it with --port, so
     no privileged port is needed.
  3. `sevyn time` CLI error paths (bad epoch, bad timezone).

The live-NTP checks are skipped (not failed) where UDP loopback is
unavailable — some sandboxes block UDP outright — so the harness
stays green there; CI runners have normal loopback UDP.

Usage: python3 v2/services/test-statusd-time.py
Exit 0 when every applicable check passes.
"""

import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # v2/
STATUSD_SRC = ROOT / "services" / "statusd.c"
SEVYN_SRC = ROOT / "update" / "sevyn.c"
NTP_EPOCH_OFFSET = 2208988800

passed = 0
failed = 0
skipped = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS: {name}")
    else:
        failed += 1
        print(f"FAIL: {name} {detail}")


def skip(name, reason):
    global skipped
    skipped += 1
    print(f"SKIP: {name} ({reason})")


def run(cmd, env=None, timeout=30):
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, env=full_env
    )
    return proc


def udp_loopback_works():
    """Probe: can this environment send UDP to itself? Sandboxes with
    a UDP-blocking seccomp/egress profile cannot; CI runners can."""
    try:
        recv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        recv.bind(("127.0.0.1", 0))
        recv.settimeout(2)
        send = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        send.sendto(b"ping", ("127.0.0.1", recv.getsockname()[1]))
        data, _ = recv.recvfrom(16)
        recv.close()
        send.close()
        return data == b"ping"
    except OSError:
        return False


class FakeNtpServer(threading.Thread):
    """One-shot NTP server: answers a single request with t2/t3 set
    `ahead_ms` ahead of the client's clock, then stops."""

    def __init__(self, ahead_ms=5000):
        super().__init__(daemon=True)
        self.ahead_ms = ahead_ms
        self.port = None
        self.served = threading.Event()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.sock.settimeout(15)

    def run(self):
        try:
            data, addr = self.sock.recvfrom(1024)
            if len(data) < 48 or data[0] != 0x1B:
                return
            now = time.time() + self.ahead_ms / 1000.0
            secs = int(now) + NTP_EPOCH_OFFSET
            frac = int((now - int(now)) * 2**32)
            pkt = bytearray(48)
            pkt[0] = 0x1C  # LI 0, VN 3, Mode 4 (server)
            pkt[1] = 2  # stratum 2
            struct.pack_into("!II", pkt, 32, secs, frac)
            struct.pack_into("!II", pkt, 40, secs, frac)
            self.sock.sendto(bytes(pkt), addr)
            self.served.set()
        except OSError:
            pass
        finally:
            self.sock.close()


class FakeStatusd(threading.Thread):
    """Minimal statusd stand-in: records every line, answers the time
    verbs with fixed OK/TIME replies. The CLI under test talks to it
    through SEVYN_STATUS_SOCK."""

    def __init__(self, path):
        super().__init__(daemon=True)
        self.path = path
        self.lines = []
        self.stop = threading.Event()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        self.sock.bind(path)
        self.sock.listen(8)
        self.sock.settimeout(0.5)

    def run(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(5)
                buf = b""
                try:
                    while b"\n" not in buf:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        buf += chunk
                except OSError:
                    continue
                line = buf.decode().strip()
                if not line:
                    continue
                self.lines.append(line)
                if line.startswith("SET_TIME "):
                    epoch_ms = line.split()[1]
                    conn.sendall(f"OK {epoch_ms}\n".encode())
                elif line == "GET_TIME":
                    now_ms = int(time.time() * 1000)
                    conn.sendall(
                        (
                            f"TIME now_ms={now_ms} last_sync_ms={now_ms} "
                            f"offset_ms=5000 source=ntp:fake rtc=ok "
                            f"restored_ms=0\n"
                        ).encode()
                    )
                elif line.startswith("SET_TIMEZONE "):
                    conn.sendall(f"OK {line.split()[1]}\n".encode())
                else:
                    conn.sendall(b"ERR unknown verb\n")
        self.sock.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-time-test-"))
    statusd_bin = tmp / "sevyn-statusd"
    sevyn_bin = tmp / "sevyn"
    status_sock = tmp / "status.sock"
    fake_sock = tmp / "fake.sock"

    # 0. Both C files build warning-free (the image build uses
    # -Wall -Wextra; a warning here is a failure). sevyn.c links
    # libcrypto since Phase 2 (relay Ed25519 via OpenSSL EVP);
    # -lcrypto is harmless on statusd.c, which does not use it.
    for src, out in [(STATUSD_SRC, statusd_bin), (SEVYN_SRC, sevyn_bin)]:
        proc = run(["gcc", "-O2", "-Wall", "-Wextra", "-o", str(out), str(src), "-lcrypto"])
        check(f"build {src.name} warning-free", proc.returncode == 0,
              proc.stderr.strip()[:300])

    statusd = None
    fake = None
    try:
        env = {"SEVYN_STATUS_SOCK": str(status_sock)}
        # 1. The real statusd on a scratch socket.
        statusd = subprocess.Popen(
            [str(statusd_bin)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "SEVYN_STATUS_SOCK": str(status_sock)},
        )
        deadline = time.time() + 10
        up = False
        while time.time() < deadline:
            if status_sock.exists():
                proc = run([str(sevyn_bin), "time", "status"], env=env)
                if proc.returncode == 0:
                    up = True
                    break
            time.sleep(0.2)
        check("real statusd starts on scratch socket", up)
        if not up:
            return 1

        # 1a. GET_TIME shape before any sync.
        proc = run([str(sevyn_bin), "time", "status"], env=env)
        check("time status: never synced at first", "last_sync: never" in proc.stdout)
        check("time status: rtc unknown at first", "rtc: unknown" in proc.stdout)
        check("time status: no restore at first", "restored: none" in proc.stdout)

        # 1b. SET_TIME: either it succeeds (root with CAP_SYS_TIME —
        # then restore the clock right away) or the daemon reports
        # the refused clock_settime honestly (unprivileged run).
        before_ms = int(time.time() * 1000)
        target_ms = before_ms + 2000
        proc = run([str(sevyn_bin), "time", "set", str(target_ms)], env=env)
        if proc.returncode == 0:
            after = run([str(sevyn_bin), "time", "status"], env=env)
            check(
                "time set: daemon records the sync",
                "last_sync_ms:" in after.stdout
                and "source: manual" in after.stdout,
            )
            # Restore the clock to ~now (it was moved +2s).
            restore_ms = int(time.time() * 1000)
            back = run(
                [str(sevyn_bin), "time", "set", str(restore_ms)], env=env
            )
            check("time set: clock restored afterwards", back.returncode == 0)
        else:
            check(
                "time set: refused clock_settime reported honestly",
                "clock_settime failed" in proc.stderr,
                proc.stderr.strip()[:200],
            )

        # 1c. CLI-side rejections (no daemon round-trip needed).
        for args, label in [
            (["time", "set", "123"], "epoch seconds rejected"),
            (["time", "set", "not-a-date"], "garbage date rejected"),
            (["time", "set", "1999-01-01T00:00:00Z"], "pre-2020 date rejected"),
            (["time", "timezone", "Not/A Zone"], "timezone with space rejected"),
        ]:
            proc = run([str(sevyn_bin), *args], env=env)
            check(f"time {args[1]}: {label}", proc.returncode != 0)

        # 1d. Daemon-side timezone validation.
        proc = run([str(sevyn_bin), "time", "timezone", "Mars/Olympus"], env=env)
        check(
            "time timezone: unknown zone rejected by daemon",
            proc.returncode != 0 and "unknown timezone" in proc.stderr,
            proc.stderr.strip()[:200],
        )
        proc = run([str(sevyn_bin), "time", "timezone", "UTC"], env=env)
        check(
            "time timezone: single-component name rejected",
            proc.returncode != 0 and "invalid timezone" in proc.stderr,
            proc.stderr.strip()[:200],
        )

        # 1e. Timezone happy path: succeeds only where the daemon can
        # write /etc; otherwise the daemon must say so (never crash
        # or lie). A successful write is restored afterwards.
        tz_path = Path("/etc/timezone")
        original_tz = tz_path.read_text() if tz_path.exists() else None
        proc = run(
            [str(sevyn_bin), "time", "timezone", "America/New_York"], env=env
        )
        if proc.returncode == 0:
            check(
                "time timezone: valid zone applied",
                tz_path.exists()
                and tz_path.read_text().strip() == "America/New_York",
            )
            if original_tz is not None:
                tz_path.write_text(original_tz)
                link = Path("/etc/localtime")
                try:
                    if link.is_symlink():
                        link.unlink()
                        link.symlink_to(
                            f"/usr/share/zoneinfo/{original_tz.strip()}"
                        )
                except OSError:
                    pass
        else:
            check(
                "time timezone: unwritable /etc reported honestly",
                "cannot write" in proc.stderr,
                proc.stderr.strip()[:200],
            )

        # 2. The NTP client, end to end, against a fake server +
        # fake statusd (no clock, no network, no root).
        if not udp_loopback_works():
            skip(
                "time sync: NTP client vs fake server",
                "UDP loopback blocked in this environment",
            )
            skip(
                "time sync: no-listener failure path",
                "UDP loopback blocked in this environment",
            )
        else:
            fake = FakeStatusd(str(fake_sock))
            fake.start()
            ntp = FakeNtpServer(ahead_ms=5000)
            ntp.start()
            fake_env = {"SEVYN_STATUS_SOCK": str(fake_sock)}
            proc = run(
                [
                    str(sevyn_bin),
                    "time",
                    "sync",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(ntp.port),
                ],
                env=fake_env,
            )
            ntp.join(timeout=20)
            m = re.search(r"offset_ms=(-?\d+)", proc.stdout)
            offset = int(m.group(1)) if m else None
            check(
                "time sync: fake NTP server answers, offset ~+5000ms",
                proc.returncode == 0 and offset is not None and 4000 <= offset <= 6000,
                f"rc={proc.returncode} out={proc.stdout.strip()!r} err={proc.stderr.strip()!r}",
            )
            set_lines = [ln for ln in fake.lines if ln.startswith("SET_TIME ")]
            ok_line = False
            if set_lines:
                parts = set_lines[0].split()
                ok_line = (
                    len(parts) == 4
                    and parts[3] == "ntp:127.0.0.1"
                    and 4000 <= int(parts[2]) <= 6000
                )
            check(
                "time sync: SET_TIME line carries offset + source",
                ok_line,
                f"lines={fake.lines!r}",
            )
            proc = run(
                [
                    str(sevyn_bin),
                    "time",
                    "status",
                ],
                env=fake_env,
            )
            check(
                "time status: reads daemon state through the CLI",
                proc.returncode == 0 and "source: ntp:fake" in proc.stdout,
                proc.stdout.strip()[:200],
            )
            proc = run(
                [
                    str(sevyn_bin),
                    "time",
                    "sync",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "21124",
                ],
                env=fake_env,
            )
            check(
                "time sync: no-listener failure is clean",
                proc.returncode != 0 and "all NTP servers failed" in proc.stderr,
                proc.stderr.strip()[:200],
            )

        # 5. The ai.screen key (relay frames, R8/S2): the real
        #    statusd must own the key — default "off" in the
        #    snapshot — and broadcast a SET on/off to subscribers.
        #    The relay agent SETs it directly over this socket; the
        #    tray reads it for the SCREEN pill. No `sevyn` verb is
        #    involved, so the check speaks the socket protocol
        #    directly: SUBSCRIBE, then SET.
        try:
            sub = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sub.settimeout(5)
            sub.connect(str(status_sock))
            sub.sendall(b"SUBSCRIBE\n")
            got = b""
            deadline = time.time() + 5
            while time.time() < deadline and b"ai.screen" not in got:
                try:
                    chunk = sub.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
                got += chunk
            check(
                "ai.screen defaults to off in the snapshot",
                b"STATUS ai.screen off" in got,
                got.decode(errors="replace")[:300],
            )
            writer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            writer.settimeout(5)
            writer.connect(str(status_sock))
            writer.sendall(b"SET ai.screen on\n")
            writer.close()
            got = b""
            deadline = time.time() + 5
            while time.time() < deadline and b"STATUS ai.screen on" not in got:
                try:
                    chunk = sub.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
                got += chunk
            check(
                "SET ai.screen on broadcasts to subscribers",
                b"STATUS ai.screen on" in got,
                got.decode(errors="replace")[:300],
            )
            sub.close()
        except OSError as e:
            check("ai.screen key (socket error)", False, str(e))
    finally:
        if fake is not None:
            fake.stop.set()
            fake.join(timeout=5)
        if statusd is not None:
            statusd.terminate()
            try:
                statusd.wait(timeout=5)
            except subprocess.TimeoutExpired:
                statusd.kill()

    print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
