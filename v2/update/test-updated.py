#!/usr/bin/env python3
"""Host-side tests for sevyn-updated (M8) + the sevyn CLI + the
canonical feed serializer.

Builds the daemon, the CLI and a canonical-printing test main with
the host gcc, then drives the daemon against a local HTTP server
serving signed update feeds (real wget, real Ed25519 via the repo's
sign-feed.mjs — the same tooling the nightly uses).

Coverage:
  - canonical byte parity with tools/update-signing/canonical.mjs
  - daemon start, boot-attempt counting, health good-mark
  - STATUS / CHECK / APPLY / CHANNEL / URL over the socket and the
    control serial (pty); the URL verb persists a feed-URL override
    (http/https only) and STATUS shows it
  - download retry: a wget that fails once, then works — the apply
    lands instead of dying on the transient failure
  - big preserved grub.cfg: ~1.6 KiB of other-OS entries no longer
    refuse the update (the menu is built on the heap, not a fixed
    2048-byte buffer); every other entry survives verbatim
  - feed verification: unsigned / unknown-key / tampered / bad-hash /
    channel-mismatch / no-trusted-keys — all refused (fail-closed)
  - apply: verified artifacts land in the idle slot, state flips,
    reboot requested; a bad-hash apply changes nothing
  - ESP sync geometry (M12 Genesis): an update whose three-copy peak
    would overflow a small ESP lands with the reworked sync (two-copy
    peak), a too-small ESP refuses loudly BEFORE copying (ESP
    byte-identical, state unflipped), and a missing good slot
    degrades .prev explicitly (update lands, no "previous" entry)
  - the sevyn CLI (status / check / channel / apply, ai list /
    select / status / ask)
  - no-data-disk degradation

Run: python3 v2/update/test-updated.py
"""
import hashlib
import json
import os
import pty
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # repo root
LOADER = HERE.parent / "loader"
UPDATE = HERE
SIGN_FEED = ROOT / "tools" / "update-signing" / "sign-feed.mjs"
CANONICAL = ROOT / "tools" / "update-signing" / "canonical.mjs"
GEN_KEY = ROOT / "tools" / "update-signing" / "generate-key.mjs"

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'ok' if ok else 'FAIL'}: {name}" +
          (f" ({detail})" if detail and not ok else ""))


class LogWatcher(threading.Thread):
    """Reads a process's stderr into a list; wait_for polls it."""

    def __init__(self, stream):
        super().__init__(daemon=True)
        self.stream = stream
        self.lines = []
        self.lock = threading.Lock()

    def run(self):
        for raw in self.stream:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            with self.lock:
                self.lines.append(line)

    def wait_for(self, needle, timeout=10.0):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                for line in self.lines:
                    if needle in line:
                        return True
            time.sleep(0.05)
        return False

    def text(self):
        with self.lock:
            return "\n".join(self.lines)


class Daemon:
    def __init__(self, tmp, env_extra):
        self.tmp = tmp
        self.env = dict(os.environ)
        self.env["PATH"] = str(tmp / "bin") + ":" + self.env["PATH"]
        self.env.update(env_extra)
        self.proc = None
        self.watcher = None
        self.master_fd = None

    def start(self):
        self.proc = subprocess.Popen(
            [str(self.tmp / "sevyn-updated")],
            stderr=subprocess.PIPE, stdout=subprocess.DEVNULL,
            env=self.env)
        self.watcher = LogWatcher(self.proc.stderr)
        self.watcher.start()
        return self.watcher.wait_for("UPDATE ready", timeout=15)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc = None

    def sock(self, verb, timeout=10.0):
        """Send one verb on the socket, return the first reply line."""
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(self.env["SEVYN_UPDATE_SOCK"])
        s.sendall((verb + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
        s.close()
        return buf.decode().strip()

    def sock_lines(self, verbs, timeout=30.0, want=10):
        """Send verbs, return up to `want` reply lines."""
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(self.env["SEVYN_UPDATE_SOCK"])
        for v in verbs:
            s.sendall((v + "\n").encode())
        lines = []
        buf = b""
        try:
            while len(lines) < want:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    lines.append(line.decode().strip())
        except socket.timeout:
            pass
        s.close()
        return lines


def sha256_file(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def write_feed(server_dir, key_file, version, channel, artifacts,
               sign=True, tamper_after_sign=False):
    """Write updates.json in server_dir (signed with sign-feed.mjs
    unless sign=False). artifacts: list of dicts. Returns the feed."""
    feed = {
        "version": version,
        "channel": channel,
        "publishedAt": "2026-11-07T05:00:00.000Z",
        "releaseNotes": f"SevynOS nightly {version}.",
        "artifacts": artifacts,
    }
    path = server_dir / "updates.json"
    path.write_text(json.dumps(feed, indent=2) + "\n")
    if sign:
        r = subprocess.run(
            ["node", str(SIGN_FEED), "--feed", str(path),
             "--key-file", str(key_file)],
            capture_output=True, text=True)
        assert r.returncode == 0, f"sign-feed failed: {r.stderr}"
        feed = json.loads(path.read_text())
    if tamper_after_sign:
        # Change a hash without re-signing: the signature must fail.
        feed["artifacts"][0]["sha256"] = "0" * 64
        path.write_text(json.dumps(feed, indent=2) + "\n")
    return feed


def make_keypair(tmp, key_id, name):
    key_path = tmp / f"{name}.json"
    r = subprocess.run(
        ["node", str(GEN_KEY), "--key-id", key_id, "--out",
         str(key_path)],
        capture_output=True, text=True)
    assert r.returncode == 0, f"generate-key failed: {r.stderr}"
    # stdout is the public trusted-update-keys.json fragment.
    anchor = tmp / f"{name}-anchor.json"
    anchor.write_text(r.stdout)
    return key_path, anchor


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-update-test-"))
    print(f"work dir: {tmp}")
    data = tmp / "data"
    (data / "slots" / "A").mkdir(parents=True)
    (data / "slots" / "B").mkdir(parents=True)
    server_dir = tmp / "server"
    server_dir.mkdir()
    (tmp / "bin").mkdir()
    (tmp / "dl").mkdir()

    # --- build ------------------------------------------------------
    daemon_bin = tmp / "sevyn-updated"
    cli_bin = tmp / "sevyn"
    canon_bin = tmp / "canon"
    canon_main = tmp / "canon-main.c"
    canon_main.write_text(
        '#include <stdio.h>\n#include <stdlib.h>\n#include "canonical.h"\n'
        "int main(int argc, char **argv) {\n"
        "  if (argc != 2) return 2;\n"
        "  FILE *f = fopen(argv[1], \"rb\"); if (!f) return 2;\n"
        "  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);\n"
        "  char *t = malloc(n + 1);\n"
        "  if (fread(t, 1, n, f) != (size_t)n) return 2;\n"
        "  t[n] = 0; fclose(f);\n"
        "  char err[256]; jval_t *v = json_parse(t, err, sizeof(err));\n"
        "  if (!v) { fprintf(stderr, \"parse: %s\\n\", err); return 1; }\n"
        "  char *c = canonical_feed_body(v);\n"
        "  if (!c) return 1;\n"
        "  printf(\"%s\", c); free(c); json_free(v); free(t); return 0;\n"
        "}\n")
    builds = [
        (["gcc", "-O2", "-Wall", "-Wextra", "-o", str(daemon_bin),
          str(HERE / "sevyn-updated.c"), str(HERE / "canonical.c"),
          str(LOADER / "json.c"), str(LOADER / "verify.c"), "-lcrypto"],
         "daemon"),
        (["gcc", "-O2", "-Wall", "-Wextra", "-o", str(cli_bin),
          str(HERE / "sevyn.c"), "-lcrypto"], "cli"),
        (["gcc", "-O2", "-Wall", "-Wextra", "-I", str(HERE), "-o",
          str(canon_bin), str(canon_main), str(HERE / "canonical.c"),
          str(LOADER / "json.c")], "canonical test main"),
    ]
    for cmd, name in builds:
        r = subprocess.run(cmd, capture_output=True, text=True)
        check(f"{name} builds clean (-Wall -Wextra)", r.returncode == 0,
              r.stderr[:400])
        if r.returncode != 0:
            print("FAIL: build failed, aborting")
            return 1

    # --- canonical byte parity vs node ------------------------------
    feed_js = {
        "version": "abc1234", "channel": "nightly",
        "publishedAt": "2026-11-07T05:00:00.000Z",
        "releaseNotes": "Line one.\nLine \"two\" with a tab\there.",
        "artifacts": [
            {"kind": "vmlinuz", "url": "https://example.com/vmlinuz",
             "sha256": "a" * 64, "sizeBytes": 15859712},
            {"kind": "initramfs",
             "url": "https://example.com/initramfs.cpio.gz",
             "sha256": "b" * 64, "sizeBytes": 47823456}],
        "signatures": {"nightly": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},
    }
    feed_path = tmp / "parity.json"
    feed_path.write_text(json.dumps(feed_js, indent=2) + "\n")
    node = subprocess.run(
        ["node", "-e",
         "import('" + str(CANONICAL).replace("'", "\\'") + "').then(async m=>{"
         "const fs=await import('node:fs');"
         "const j=JSON.parse(fs.readFileSync('" +
         str(feed_path).replace("'", "\\'") + "','utf8'));"
         "process.stdout.write(m.canonicalFeedBody(j));})"],
        capture_output=True, text=True)
    c = subprocess.run([str(canon_bin), str(feed_path)],
                       capture_output=True, text=True)
    check("canonical body byte-identical to canonical.mjs",
          node.returncode == 0 and c.returncode == 0 and
          node.stdout == c.stdout,
          f"node={node.stdout[:80]!r} c={c.stdout[:80]!r}")

    # --- keys, anchor, fake images ----------------------------------
    key_file, anchor = make_keypair(tmp, "nightly-test", "nightly-test")
    bad_key_file, _bad_anchor = make_keypair(tmp, "attacker", "attacker")
    (tmp / "trusted-update-keys.json").write_text(anchor.read_text())
    (tmp / "os-version").write_text("m8-test-1\n")

    def fake_image(name, marker):
        p = server_dir / name
        p.write_bytes(marker.encode() + os.urandom(8192))
        return p

    kern_v2 = fake_image("vmlinuz-v2", "VMLINUZ-V2\n")
    init_v2 = fake_image("initramfs-v2.cpio.gz", "INITRAMFS-V2\n")
    kern_bad = fake_image("vmlinuz-bad", "VMLINUZ-BAD\n")
    init_bad = fake_image("initramfs-bad.cpio.gz", "INITRAMFS-BAD\n")

    # --- HTTP server -------------------------------------------------
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(server_dir), **kw)

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    feed_url = f"http://127.0.0.1:{port}/updates.json"

    # --- reboot stub -------------------------------------------------
    reboot_marker = tmp / "rebooted"
    (tmp / "bin" / "reboot").write_text(
        "#!/bin/sh\necho \"REBOOT $@\" >> " + str(reboot_marker) + "\n")
    (tmp / "bin" / "reboot").chmod(0o755)

    # --- initial data-disk state ------------------------------------
    (data / "slot-state.json").write_text(json.dumps(
        {"active": "A", "good": "A", "attempts": 0,
         "version": "m8-test-1"}, indent=2) + "\n")
    (data / "update-config.json").write_text(json.dumps(
        {"channel": "nightly", "url": feed_url}, indent=2) + "\n")
    (tmp / "health.log").write_text("")

    def artifacts_for(kern, init):
        return [
            {"kind": "vmlinuz",
             "url": f"http://127.0.0.1:{port}/{kern.name}",
             "sha256": sha256_file(kern),
             "sizeBytes": kern.stat().st_size},
            {"kind": "initramfs",
             "url": f"http://127.0.0.1:{port}/{init.name}",
             "sha256": sha256_file(init),
             "sizeBytes": init.stat().st_size},
        ]

    def state():
        return json.loads((data / "slot-state.json").read_text())

    def base_env(slot="A"):
        return {
            "SEVYN_UPDATE_SOCK": str(tmp / "update.sock"),
            "SEVYN_UPDATE_DATA": str(data),
            "SEVYN_UPDATE_TRUSTED_KEYS":
                str(tmp / "trusted-update-keys.json"),
            "SEVYN_UPDATE_VERSION_FILE": str(tmp / "os-version"),
            "SEVYN_UPDATE_TMP": str(tmp / "dl"),
            "SEVYN_UPDATE_HEALTH_FILE": str(tmp / "health.log"),
            "SEVYN_UPDATE_SLOT": slot,
        }

    # --- daemon 1: version m8-test-1, slot A -------------------------
    master_fd, slave_fd = pty.openpty()
    slave_name = os.ttyname(slave_fd)
    env = base_env("A")
    env["SEVYN_UPDATE_CTL"] = slave_name
    d = Daemon(tmp, env)
    check("daemon starts", d.start())
    check("boot attempt recorded (attempts 0 -> 1)",
          state()["attempts"] == 1 and state()["active"] == "A",
          str(state()))
    check("STATUS reports slot A, version m8-test-1",
          d.sock("STATUS") ==
          "OK version=m8-test-1 channel=nightly active=A good=A "
          "attempts=1 applying=no available=unknown url=" + feed_url,
          d.sock("STATUS"))
    check("PING", d.sock("PING") == "OK pong")
    check("unknown verb rejected",
          d.sock("BOGUS") == "ERR unknown verb")
    check("url verb: non-http scheme rejected",
          d.sock("URL ftp://example.com/updates.json") ==
          "ERR usage: URL <http://...|https://...>")
    check("url verb: bare host rejected",
          d.sock("URL updates.example.com") ==
          "ERR usage: URL <http://...|https://...>")
    alt_url = feed_url + "?v=2"
    check("url verb: http(s) URL accepted",
          d.sock("URL " + alt_url) == "OK url " + alt_url)
    check("url verb: STATUS shows the new URL",
          d.sock("STATUS").endswith(" url=" + alt_url))
    check("url verb: persists in update-config.json",
          json.loads((data / "update-config.json").read_text())
          ["url"] == alt_url)
    check("url verb: invalid URL leaves config untouched",
          d.sock("URL ftp://example.com/x").startswith("ERR") and
          json.loads((data / "update-config.json").read_text())
          ["url"] == alt_url)
    check("url verb: CLI sets the URL",
          subprocess.run(
              [str(tmp / "sevyn"), "update", "url", feed_url],
              capture_output=True, text=True,
              env={**os.environ,
                   "SEVYN_UPDATE_SOCK": str(tmp / "update.sock")})
          .stdout.strip() == "url " + feed_url)
    check("url verb: CLI round-trips back to the feed URL",
          json.loads((data / "update-config.json").read_text())
          ["url"] == feed_url)

    # Control serial: send STATUS through the pty, reply lands in the log.
    os.write(master_fd, b"STATUS\n")
    check("control serial STATUS answered",
          d.watcher.wait_for("UPDATE STATUS version=m8-test-1", timeout=5))

    # CHECK, no feed yet (404: updates.json does not exist).
    check("CHECK with no feed -> download failed",
          d.sock("CHECK").startswith("ERR download failed"))

    # CHECK, signed v2 feed -> available.
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2))
    check("CHECK signed v2 feed -> available m8-test-2",
          d.sock("CHECK") == "OK available m8-test-2")

    # CHECK, same-version feed -> none.
    write_feed(server_dir, key_file, "m8-test-1", "nightly",
               artifacts_for(kern_v2, init_v2))
    check("CHECK same version -> none",
          d.sock("CHECK") == "OK none m8-test-1")

    # CHECK, unsigned feed -> refused.
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2), sign=False)
    check("CHECK unsigned feed refused",
          "not signed" in d.sock("CHECK"))

    # CHECK, unknown-key signature -> refused.
    write_feed(server_dir, bad_key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2))
    check("CHECK unknown-key signature refused",
          "no signature from a trusted key" in d.sock("CHECK"))

    # CHECK, tampered after signing -> refused.
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2), tamper_after_sign=True)
    check("CHECK tampered feed refused",
          "does not verify" in d.sock("CHECK"))

    # CHECK, no trusted keys (bad anchor) -> refused.
    (tmp / "trusted-update-keys.json").write_text(
        json.dumps({"keys": [{"keyId": "nightly-test",
                              "publicKeyJwk": {"kty": "OKP",
                                               "crv": "Ed25519",
                                               "x": "!!!"}}]}))
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2))
    check("CHECK with malformed trust anchor refused",
          "no trusted update keys" in d.sock("CHECK"))
    (tmp / "trusted-update-keys.json").write_text(anchor.read_text())

    # CHANNEL: stable -> nightly feed is a mismatch; back to nightly.
    check("CHANNEL stable",
          d.sock("CHANNEL stable") == "OK channel stable")
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2))
    check("CHECK nightly feed on stable channel refused",
          "channel mismatch" in d.sock("CHECK"))
    check("CHANNEL nightly",
          d.sock("CHANNEL nightly") == "OK channel nightly")
    check("CHANNEL bogus rejected",
          d.sock("CHANNEL beta").startswith("ERR usage"))

    # --- CLI apply: v2 feed -> idle slot B, reboot ------------------
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2))
    cli_env = dict(os.environ)
    cli_env["SEVYN_UPDATE_SOCK"] = str(tmp / "update.sock")
    r = subprocess.run([str(cli_bin), "update", "apply"],
                       capture_output=True, text=True, env=cli_env,
                       timeout=120)
    check("CLI apply exits 0", r.returncode == 0, r.stderr[:300])
    check("CLI apply prints applied",
          "applied m8-test-2 B" in r.stdout, r.stdout[:200])
    check("reboot requested", reboot_marker.exists(),
          "no reboot marker")
    check("slot B holds the verified v2 images",
          sha256_file(data / "slots" / "B" / "vmlinuz") ==
          sha256_file(kern_v2) and
          sha256_file(data / "slots" / "B" / "initramfs.cpio.gz") ==
          sha256_file(init_v2))
    st = state()
    check("state flipped to B (good stays A, attempts 0)",
          st["active"] == "B" and st["good"] == "A" and
          st["attempts"] == 0 and st["version"] == "m8-test-2",
          str(st))
    d.stop()

    # --- daemon 2: rebooted into slot B, version m8-test-2 ----------
    (tmp / "os-version").write_text("m8-test-2\n")
    d2 = Daemon(tmp, base_env("B"))
    check("daemon restarts on slot B", d2.start())
    check("boot attempt on B recorded",
          state()["attempts"] == 1 and state()["active"] == "B",
          str(state()))
    # Shell reaches READY -> slot B marked good.
    (tmp / "health.log").write_text("SEVYNOS_M2_READY\n")
    check("health READY marks slot B good",
          d2.watcher.wait_for("UPDATE SLOT GOOD B", timeout=5) and
          state()["good"] == "B" and state()["attempts"] == 0,
          str(state()))
    write_feed(server_dir, key_file, "m8-test-2", "nightly",
               artifacts_for(kern_v2, init_v2))
    check("CHECK on m8-test-2 -> none",
          d2.sock("CHECK") == "OK none m8-test-2")
    check("APPLY when already on version refused",
          d2.sock("APPLY") == "ERR already on m8-test-2")

    # APPLY with a correctly-signed feed whose initramfs hash is wrong
    # -> the download check refuses it, nothing changes.
    arts = artifacts_for(kern_v2, init_v2)
    arts[1]["sha256"] = "0" * 64
    write_feed(server_dir, key_file, "m8-test-3", "nightly", arts)
    check("CHECK bad-hash feed -> available (signature is valid)",
          d2.sock("CHECK") == "OK available m8-test-3")
    lines = d2.sock_lines(["SUBSCRIBE", "APPLY"], want=5)
    check("APPLY bad-hash refused at download",
          lines[0] == "OK subscribed" and
          lines[1] == "EVENT APPLY STARTED m8-test-3" and
          lines[2] == "OK applying m8-test-3" and
          any("APPLY FAILED" in ln for ln in lines),
          str(lines))
    check("bad-hash apply leaves state untouched",
          state()["active"] == "B" and state()["version"] == "m8-test-2",
          str(state()))
    check("APPLY FAIL logged with the hash reason",
          d2.watcher.wait_for("sha256 mismatch", timeout=5))

    # APPLY the bad (boot-failing) image: it verifies fine, lands in
    # the idle slot A, flips state, reboots. (QEMU proves the fallback.)
    n_reboots = len(reboot_marker.read_text().splitlines()) \
        if reboot_marker.exists() else 0
    write_feed(server_dir, key_file, "m8-test-bad", "nightly",
               artifacts_for(kern_bad, init_bad))
    check("APPLY bad image accepted (it verifies; boot proves it)",
          d2.sock("APPLY") == "OK applying m8-test-bad")
    ok_reboot = False
    # The reboot is requested by a forked `reboot -f` stub; under
    # box saturation the fork/exec can land >10 s after APPLY
    # returns (9 occurrences across the queue, e.g. #143 M10 att2,
    # #148 M9/M12/M13 att1). Poll 30 s — the loop exits on the
    # first sighting, so a healthy run pays nothing extra.
    for _ in range(300):
        if reboot_marker.exists() and \
                len(reboot_marker.read_text().splitlines()) > n_reboots:
            ok_reboot = True
            break
        time.sleep(0.1)
    check("bad apply requested a reboot", ok_reboot)
    st = state()
    check("bad apply flipped state to A",
          st["active"] == "A" and st["version"] == "m8-test-bad",
          str(st))
    check("slot A holds the bad images",
          sha256_file(data / "slots" / "A" / "vmlinuz") ==
          sha256_file(kern_bad))
    d2.stop()

    # --- CLI: status / check / channel / usage -----------------------
    # Simulate the reboot into the bad slot: the booted image's
    # os-version is now m8-test-bad.
    (tmp / "os-version").write_text("m8-test-bad\n")
    d3 = Daemon(tmp, base_env("A"))
    check("daemon restarts for CLI checks", d3.start())
    env3 = dict(os.environ)
    env3["SEVYN_UPDATE_SOCK"] = str(tmp / "update.sock")
    r = subprocess.run([str(cli_bin), "update", "status"],
                       capture_output=True, text=True, env=env3)
    check("CLI status prints the slot line",
          r.returncode == 0 and "active=A" in r.stdout, r.stdout[:200])
    r = subprocess.run([str(cli_bin), "update", "check"],
                       capture_output=True, text=True, env=env3)
    check("CLI check reports none (bad feed is current)",
          r.returncode == 0 and r.stdout.strip() == "none m8-test-bad",
          r.stdout[:200] + r.stderr[:200])
    r = subprocess.run([str(cli_bin), "update", "channel", "stable"],
                       capture_output=True, text=True, env=env3)
    check("CLI channel stable",
          r.returncode == 0 and r.stdout.strip() == "channel stable")
    r = subprocess.run([str(cli_bin), "update", "channel", "stable"],
                       capture_output=True, text=True, env=env3)
    check("CLI channel persists (config round-trips)",
          r.returncode == 0 and
          json.loads((data / "update-config.json").read_text())
          ["channel"] == "stable")
    r = subprocess.run([str(cli_bin), "update"],
                       capture_output=True, text=True, env=env3)
    check("CLI with no verb prints usage, exit 1",
          r.returncode == 1 and "usage:" in r.stderr)
    r = subprocess.run([str(cli_bin), "bogus"],
                       capture_output=True, text=True, env=env3)
    check("CLI with a bogus verb prints usage, exit 1",
          r.returncode == 1 and "usage:" in r.stderr)
    d3.stop()

    # --- no data disk -------------------------------------------------
    nodata = Daemon(tmp, {
        "SEVYN_UPDATE_SOCK": str(tmp / "update-nodata.sock"),
        "SEVYN_UPDATE_DATA": str(tmp / "no-such-data-dir"),
        "SEVYN_UPDATE_TRUSTED_KEYS":
            str(tmp / "trusted-update-keys.json"),
        "SEVYN_UPDATE_VERSION_FILE": str(tmp / "os-version"),
        "SEVYN_UPDATE_TMP": str(tmp / "dl"),
        "SEVYN_UPDATE_HEALTH_FILE": str(tmp / "health.log"),
        "SEVYN_UPDATE_SLOT": "A",
    })
    check("daemon starts with no data disk", nodata.start())
    check("STATUS with no data disk reports it",
          "no-data-disk" in nodata.sock("STATUS"))
    check("CHECK with no data disk refused",
          nodata.sock("CHECK") == "ERR no-data-disk")
    check("APPLY with no data disk refused",
          nodata.sock("APPLY") == "ERR no-data-disk")
    nodata.stop()

    # --- CLI: ai (M4.5) ----------------------------------------------
    # Fake sevyn-aid: canned replies, records the verb lines it got.
    ai_sock_path = tmp / "ai.sock"
    ai_seen = []
    ai_stop = [False]

    def fake_aid():
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(ai_sock_path))
        srv.listen(8)
        srv.settimeout(0.5)
        while not ai_stop[0]:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
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
                    ai_seen.append(line)
                    if line == "LIST":
                        conn.sendall(
                            b"OK selected=echo-ai "
                            b"backends=echo-ai,plan-ai\n")
                    elif line == "STATUS":
                        conn.sendall(
                            b"OK selected=echo-ai "
                            b"backends=echo-ai,plan-ai "
                            b"grant=app.launch,app.close,app.list,"
                            b"status.set\n")
                    elif line == "SELECT plan-ai":
                        conn.sendall(b"OK selected plan-ai\n")
                    elif line == "SELECT bogus":
                        conn.sendall(b"ERR unknown backend bogus\n")
                    elif line.startswith("ASK "):
                        conn.sendall(
                            b"OK backend=echo-ai allowed=1 denied=0 "
                            b"failed=0\n")
                    else:
                        conn.sendall(b"ERR unknown command\n")
            except OSError:
                pass
            finally:
                conn.close()
        srv.close()

    ai_thread = threading.Thread(target=fake_aid, daemon=True)
    ai_thread.start()
    for _ in range(50):
        if ai_sock_path.exists():
            break
        time.sleep(0.1)
    ai_env = dict(os.environ)
    ai_env["SEVYN_AI_SOCK"] = str(ai_sock_path)
    r = subprocess.run([str(cli_bin), "ai", "list"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai list prints selection",
          r.returncode == 0 and
          r.stdout.strip() == "selected=echo-ai backends=echo-ai,plan-ai",
          r.stdout[:200] + r.stderr[:200])
    r = subprocess.run([str(cli_bin), "ai", "status"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai status prints grant",
          r.returncode == 0 and
          "grant=app.launch,app.close,app.list,status.set" in r.stdout,
          r.stdout[:200])
    r = subprocess.run([str(cli_bin), "ai", "select", "plan-ai"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai select plan-ai",
          r.returncode == 0 and r.stdout.strip() == "selected plan-ai",
          r.stdout[:200] + r.stderr[:200])
    r = subprocess.run([str(cli_bin), "ai", "ask", "launch", "files"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai ask joins the task words",
          r.returncode == 0 and "allowed=1" in r.stdout and
          "ASK launch files" in ai_seen,
          r.stdout[:200] + str(ai_seen))
    r = subprocess.run([str(cli_bin), "ai", "select", "bogus"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai select unknown -> exit 1 + error",
          r.returncode == 1 and "unknown backend bogus" in r.stderr,
          r.stdout[:200] + r.stderr[:200])
    r = subprocess.run([str(cli_bin), "ai"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai with no verb prints usage, exit 1",
          r.returncode == 1 and "usage:" in r.stderr)
    r = subprocess.run([str(cli_bin), "ai", "ask"],
                       capture_output=True, text=True, env=ai_env)
    check("CLI ai ask with no task prints usage, exit 1",
          r.returncode == 1 and "usage:" in r.stderr)
    ai_stop[0] = True
    ai_thread.join(timeout=5)
    if ai_sock_path.exists():
        os.unlink(ai_sock_path)

    # --- M9 ESP sync + fallback restore ------------------------------
    # The host tests drive esp_sync_files through the
    # SEVYN_UPDATE_ESP_DIR hook (a plain directory): the copy +
    # verify + grub.cfg logic is identical to the guest path, only
    # device discovery + the vfat mount are not exercised here —
    # those are proven by m9-check on a real GPT disk under QEMU.
    data2 = tmp / "data2"
    (data2 / "slots" / "A").mkdir(parents=True)
    (data2 / "slots" / "B").mkdir(parents=True)
    kern_a = fake_image("vmlinuz-a", "VMLINUZ-A\n")
    init_a = fake_image("initramfs-a.cpio.gz", "INITRAMFS-A\n")
    kern_b = fake_image("vmlinuz-b", "VMLINUZ-B\n")
    init_b = fake_image("initramfs-b.cpio.gz", "INITRAMFS-B\n")
    (data2 / "slots" / "A" / "vmlinuz").write_bytes(kern_a.read_bytes())
    (data2 / "slots" / "A" / "initramfs.cpio.gz").write_bytes(
        init_a.read_bytes())
    (data2 / "slot-state.json").write_text(json.dumps(
        {"active": "A", "good": "A", "attempts": 0,
         "version": "m9-esp-1"}, indent=2) + "\n")
    (data2 / "update-config.json").write_text(json.dumps(
        {"channel": "nightly", "url": feed_url}, indent=2) + "\n")
    esp = tmp / "esp"
    (esp / "EFI" / "ubuntu").mkdir(parents=True)
    (esp / "vmlinuz").write_bytes(kern_a.read_bytes())
    (esp / "initramfs.cpio.gz").write_bytes(init_a.read_bytes())
    (esp / "EFI" / "ubuntu" / "grub.cfg").write_text(
        "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
        "set timeout=3\n"
        "set default=0\n"
        "menuentry \"SevynOS\" {\n"
        "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=A\n"
        "    initrd /initramfs.cpio.gz\n"
        "}\n"
        # M11: a dual-boot ESP carries a Windows entry the updater
        # must preserve verbatim across its grub.cfg rewrite.
        # Installer v2: a Linux entry too — the updater preserves
        # every non-SevynOS entry, not just Windows.
        "menuentry \"Windows 11\" {\n"
        "    insmod part_gpt\n"
        "    insmod fat\n"
        "    search --no-floppy --fs-uuid --set=root ABCD-1234\n"
        "    chainloader /EFI/Microsoft/Boot/bootmgfw.efi\n"
        "}\n"
        "menuentry \"Ubuntu\" {\n"
        "    search --fs-uuid DEAD-BEEF --set=root\n"
        "    chainloader /EFI/ubuntu/grubx64.efi\n"
        "}\n")
    # M11: mounts + by-partuuid fixtures so the daemon can resolve
    # the booted data partition's PARTUUID.
    (tmp / "data-dev").write_bytes(b"fake-data-device\n")
    (tmp / "mounts").write_text(
        f"{tmp / 'data-dev'} {data2} ext4 rw 0 0\n")
    (tmp / "by-partuuid").mkdir()
    os.symlink(tmp / "data-dev",
               tmp / "by-partuuid" /
               "11111111-2222-3333-4444-555555555555")
    (tmp / "os-version").write_text("m9-esp-1\n")
    (tmp / "health.log").write_text("")

    def state2():
        return json.loads((data2 / "slot-state.json").read_text())

    def esp_env(sock_name, slot):
        return {
            "SEVYN_UPDATE_SOCK": str(tmp / sock_name),
            "SEVYN_UPDATE_DATA": str(data2),
            "SEVYN_UPDATE_TRUSTED_KEYS":
                str(tmp / "trusted-update-keys.json"),
            "SEVYN_UPDATE_VERSION_FILE": str(tmp / "os-version"),
            "SEVYN_UPDATE_TMP": str(tmp / "dl"),
            "SEVYN_UPDATE_HEALTH_FILE": str(tmp / "health.log"),
            "SEVYN_UPDATE_SLOT": slot,
            "SEVYN_UPDATE_ESP_DIR": str(esp),
            "SEVYN_UPDATE_PROC_MOUNTS": str(tmp / "mounts"),
            "SEVYN_UPDATE_BY_PARTUUID_DIR": str(tmp / "by-partuuid"),
        }

    master2, slave2 = pty.openpty()
    env_esp = esp_env("update-esp.sock", "A")
    env_esp["SEVYN_UPDATE_CTL"] = os.ttyname(slave2)
    d_esp = Daemon(tmp, env_esp)
    check("ESP daemon starts", d_esp.start())
    write_feed(server_dir, key_file, "m9-esp-2", "nightly",
               artifacts_for(kern_b, init_b))
    n_reboots = len(reboot_marker.read_text().splitlines()) \
        if reboot_marker.exists() else 0
    check("ESP APPLY accepted",
          d_esp.sock("APPLY") == "OK applying m9-esp-2")
    ok_reboot = False
    # Same forked-stub race as the bad-apply poll, but the ESP path
    # does the heaviest synchronous work before the reboot (full
    # ESP sync + grub.cfg rewrite), and its reboot was seen >30 s
    # late under load (#148 M7 att1 — every other reboot check in
    # that run passed). Poll 60 s; the loop exits early on success.
    for _ in range(600):
        if reboot_marker.exists() and \
                len(reboot_marker.read_text().splitlines()) > n_reboots:
            ok_reboot = True
            break
        time.sleep(0.1)
    check("ESP apply requested a reboot", ok_reboot)
    st2 = state2()
    check("ESP apply flipped state to B (good stays A)",
          st2["active"] == "B" and st2["good"] == "A" and
          st2["attempts"] == 0 and st2["version"] == "m9-esp-2",
          str(st2))
    check("ESP /vmlinuz is the new kernel",
          sha256_file(esp / "vmlinuz") == sha256_file(kern_b))
    check("ESP /initramfs.cpio.gz is the new initramfs",
          sha256_file(esp / "initramfs.cpio.gz") == sha256_file(init_b))
    check("ESP /vmlinuz.prev preserves the old kernel",
          sha256_file(esp / "vmlinuz.prev") == sha256_file(kern_a))
    check("ESP /initramfs.prev.cpio.gz preserves the old initramfs",
          sha256_file(esp / "initramfs.prev.cpio.gz") ==
          sha256_file(init_a))
    grub = (esp / "EFI" / "ubuntu" / "grub.cfg").read_text()
    check("grub.cfg default entry boots the new slot",
          "linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=B"
          in grub, grub)
    check("grub.cfg previous entry boots the good slot from .prev",
          "linux /vmlinuz.prev console=tty0 console=ttyS0 sevyn.slot=A"
          in grub and
          "initrd /initramfs.prev.cpio.gz" in grub, grub)
    check("grub.cfg keeps the Windows 11 entry verbatim",
          "menuentry \"Windows 11\" {" in grub and
          "chainloader /EFI/Microsoft/Boot/bootmgfw.efi" in grub and
          "search --no-floppy --fs-uuid --set=root ABCD-1234" in grub,
          grub)
    check("grub.cfg keeps the Linux entry verbatim",
          "menuentry \"Ubuntu\" {" in grub and
          "chainloader /EFI/ubuntu/grubx64.efi" in grub and
          "search --fs-uuid DEAD-BEEF --set=root" in grub,
          grub)
    check("grub.cfg pins the data partition by PARTUUID",
          "sevyn.data=PARTUUID=11111111-2222-3333-4444-555555555555"
          in grub, grub)
    check("ESP sync leaves no temp files",
          not list(esp.glob("*.tmp.*")) and
          not list((esp / "EFI" / "ubuntu").glob("*.tmp.*")))
    d_esp.stop()

    # Fallback: the B slot "fails to boot twice" — attempts goes 1 ->
    # 2 at startup, the daemon restores the ESP from good slot A,
    # flips active back, and reboots. It exits via the reboot stub,
    # so drive it with Popen, not Daemon.start (no UPDATE ready).
    (data2 / "slot-state.json").write_text(json.dumps(
        {"active": "B", "good": "A", "attempts": 1,
         "version": "m9-esp-2"}, indent=2) + "\n")
    n_reboots = len(reboot_marker.read_text().splitlines()) \
        if reboot_marker.exists() else 0
    env_fb = esp_env("update-esp-fb.sock", "B")
    env_fb["SEVYN_UPDATE_CTL"] = os.ttyname(slave2)
    env_fb["PATH"] = str(tmp / "bin") + ":" + os.environ.get("PATH", "")
    proc_fb = subprocess.Popen(
        [str(tmp / "sevyn-updated")],
        stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, env={
            **dict(os.environ), **env_fb})
    # Same forked-stub race as the ESP apply poll above: the
    # fallback does the heaviest synchronous work before the
    # reboot (full ESP restore sync + grub.cfg rewrite, then a
    # system-wide sync()), and its reboot was seen >15 s late
    # under load on the KVM runners (M9 rounds 7-8: the restore
    # landed but the daemon had not reached the reboot stub when
    # the 15 s wait expired — rc=None, empty log). Poll 60 s;
    # the loop exits early on success. The stderr watcher (not a
    # post-wait read) keeps the daemon's log available on a
    # timeout too, so the next failure is diagnosable from the
    # log alone instead of an empty string.
    watcher_fb = LogWatcher(proc_fb.stderr)
    watcher_fb.start()
    rc_fb = None
    for _ in range(600):
        rc_fb = proc_fb.poll()
        if rc_fb is not None:
            break
        time.sleep(0.1)
    if rc_fb is None:
        proc_fb.kill()
        proc_fb.wait(timeout=5)
    watcher_fb.join(timeout=5)
    fb_log = watcher_fb.text()
    check("fallback daemon exits via the reboot stub", rc_fb == 0,
          f"rc={rc_fb} log={fb_log[:300]}")
    check("fallback restore logged",
          "ESP restored from slot A" in fb_log, fb_log[:300])
    check("fallback requested a reboot",
          reboot_marker.exists() and
          len(reboot_marker.read_text().splitlines()) > n_reboots)
    st2 = state2()
    check("fallback flipped state back to A (attempts 0)",
          st2["active"] == "A" and st2["good"] == "A" and
          st2["attempts"] == 0, str(st2))
    check("ESP /vmlinuz restored to the good kernel",
          sha256_file(esp / "vmlinuz") == sha256_file(kern_a))
    grub = (esp / "EFI" / "ubuntu" / "grub.cfg").read_text()
    check("grub.cfg default entry back to the good slot",
          "linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=A"
          in grub, grub)
    check("fallback restore keeps the Windows 11 entry",
          "menuentry \"Windows 11\" {" in grub and
          "chainloader /EFI/Microsoft/Boot/bootmgfw.efi" in grub,
          grub)
    check("fallback restore keeps the Linux entry",
          "menuentry \"Ubuntu\" {" in grub and
          "chainloader /EFI/ubuntu/grubx64.efi" in grub,
          grub)
    os.close(master2)
    os.close(slave2)

    # --- ESP sync geometry: the M12 Genesis nightly ---------------
    # The old sync preserved .prev FIRST, so at the peak the ESP held
    # old + .prev + temp-new — three copies of the boot set. Once the
    # initramfs grew past ~366 MiB that peak passed the 1152 MiB ESP
    # and the update died mid-copy with ENOSPC (the M12 nightly's
    # sevynos.img went missing for the same growth, and the fd584a34
    # in-place update never landed on the GF65 for this reason).
    # The rework deletes .prev first and re-creates it from the good
    # slot afterwards (peak: two copies), and refuses loudly BEFORE
    # copying when even that would not fit.
    # SEVYN_UPDATE_ESP_SIZE_BYTES caps the fixture ESP so the host
    # tests prove the space logic on a small ESP.
    # Geometry (MiB): old kernel/initramfs 1/48, new 1/52, ESP 144.
    #   Old order peak: 49 (start) + 1 (.prev kern) + 48 (.prev init)
    #     + 1 (new kern tmp) + 52 (new init tmp) = 151 > 144 — fails.
    #   New order peak: 49 + 52 (new init tmp) = 101, then 53 + 1 + 48
    #     (.prev re-creation) = 102; 102 + 32 margin = 134 <= 144 —
    #     lands, .prev preserved. The old/new gap (49 MiB) must exceed
    #     the 32 MiB margin, or no ESP size discriminates the two.
    def big_image(name, size_bytes, marker):
        p = server_dir / name
        data = marker.encode()
        with open(p, "wb") as f:
            f.write(data)
            remaining = size_bytes - len(data)
            block = b"\0" * (1024 * 1024)
            while remaining > 0:
                n = min(len(block), remaining)
                f.write(block[:n])
                remaining -= n
        return p

    # The three cases share one set of feed files: /tmp on some hosts
    # is a small tmpfs, so each case's fixture dirs are removed once
    # their assertions are done.
    kern_a_geo = big_image("vmlinuz-geo-a", 1024 * 1024, "VMLINUZ-GEO-A\n")
    init_a_geo = big_image("initramfs-geo-a.cpio.gz", 48 * 1024 * 1024,
                           "INITRAMFS-GEO-A\n")
    kern_b_geo = big_image("vmlinuz-geo-b", 1024 * 1024, "VMLINUZ-GEO-B\n")
    init_b_geo = big_image("initramfs-geo-b.cpio.gz", 52 * 1024 * 1024,
                           "INITRAMFS-GEO-B\n")

    def geo_fixture(tag, esp_bytes, with_good_slot=True):
        """A fresh data dir + ESP dir with 1 MiB / 48 MiB old files.
        Returns (data_dir, esp_dir, kern_b, init_b)."""
        gd = tmp / f"data-{tag}"
        (gd / "slots" / "A").mkdir(parents=True)
        (gd / "slots" / "B").mkdir(parents=True)
        (gd / "slots" / "A" / "vmlinuz").write_bytes(kern_a_geo.read_bytes())
        (gd / "slots" / "A" / "initramfs.cpio.gz").write_bytes(
            init_a_geo.read_bytes())
        (gd / "slot-state.json").write_text(json.dumps(
            {"active": "A", "good": "A", "attempts": 0,
             "version": f"geo-{tag}-1"}, indent=2) + "\n")
        (gd / "update-config.json").write_text(json.dumps(
            {"channel": "nightly", "url": feed_url}, indent=2) + "\n")
        gesp = tmp / f"esp-{tag}"
        (gesp / "EFI" / "ubuntu").mkdir(parents=True)
        (gesp / "vmlinuz").write_bytes(kern_a_geo.read_bytes())
        (gesp / "initramfs.cpio.gz").write_bytes(init_a_geo.read_bytes())
        (gesp / "EFI" / "ubuntu" / "grub.cfg").write_text(
            "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
            "set timeout=3\n"
            "set default=0\n"
            "menuentry \"SevynOS\" {\n"
            "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=A\n"
            "    initrd /initramfs.cpio.gz\n"
            "}\n")
        (tmp / f"os-version-{tag}").write_text(f"geo-{tag}-1\n")
        (tmp / f"health-{tag}.log").write_text("")
        (tmp / f"mounts-{tag}").write_text(
            f"{tmp / 'data-dev'} {gd} ext4 rw 0 0\n")
        if not with_good_slot:
            (gd / "slots" / "A" / "vmlinuz").unlink()
            (gd / "slots" / "A" / "initramfs.cpio.gz").unlink()
        return gd, gesp, kern_b_geo, init_b_geo

    def geo_env(tag, gd, gesp, esp_bytes):
        return {
            "SEVYN_UPDATE_SOCK": str(tmp / f"update-geo-{tag}.sock"),
            "SEVYN_UPDATE_DATA": str(gd),
            "SEVYN_UPDATE_TRUSTED_KEYS":
                str(tmp / "trusted-update-keys.json"),
            "SEVYN_UPDATE_VERSION_FILE": str(tmp / f"os-version-{tag}"),
            "SEVYN_UPDATE_TMP": str(tmp / "dl"),
            "SEVYN_UPDATE_HEALTH_FILE": str(tmp / f"health-{tag}.log"),
            "SEVYN_UPDATE_SLOT": "A",
            "SEVYN_UPDATE_ESP_DIR": str(gesp),
            "SEVYN_UPDATE_ESP_SIZE_BYTES": str(esp_bytes),
            "SEVYN_UPDATE_PROC_MOUNTS": str(tmp / f"mounts-{tag}"),
            "SEVYN_UPDATE_BY_PARTUUID_DIR": str(tmp / "by-partuuid"),
        }

    def geo_reboots():
        return len(reboot_marker.read_text().splitlines()) \
            if reboot_marker.exists() else 0

    def geo_wait_reboot(n_before, timeout=30.0):
        # 30 s, not 10 s: the same forked-stub race as the bad-apply
        # poll — under load the reboot marker lands late, and a late
        # geometry reboot also trips the following no-fit check (the
        # late line increments the count after no-fit read it).
        end = time.time() + timeout
        while time.time() < end:
            if geo_reboots() > n_before:
                return True
            time.sleep(0.1)
        return False

    # Case 1 — fits with the reworked order, would overflow the old
    # three-copy order: the update lands and .prev is preserved.
    gd1, gesp1, kern_b1, init_b1 = geo_fixture("fits", 144 * 1024 * 1024)
    master3, slave3 = pty.openpty()
    env_geo1 = geo_env("fits", gd1, gesp1, 144 * 1024 * 1024)
    env_geo1["SEVYN_UPDATE_CTL"] = os.ttyname(slave3)
    d_geo1 = Daemon(tmp, env_geo1)
    check("geometry: daemon starts (144 MiB ESP)", d_geo1.start())
    write_feed(server_dir, key_file, "geo-fits-2", "nightly",
               artifacts_for(kern_b1, init_b1))
    n_rb = geo_reboots()
    check("geometry: APPLY accepted",
          d_geo1.sock("APPLY") == "OK applying geo-fits-2")
    check("geometry: apply requested a reboot",
          geo_wait_reboot(n_rb))
    st_geo1 = json.loads((gd1 / "slot-state.json").read_text())
    check("geometry: apply flipped state to B (good stays A)",
          st_geo1["active"] == "B" and st_geo1["good"] == "A" and
          st_geo1["version"] == "geo-fits-2", str(st_geo1))
    check("geometry: ESP /vmlinuz is the new kernel",
          sha256_file(gesp1 / "vmlinuz") == sha256_file(kern_b1))
    check("geometry: ESP /initramfs.cpio.gz is the new initramfs",
          sha256_file(gesp1 / "initramfs.cpio.gz") ==
          sha256_file(init_b1))
    check("geometry: ESP /vmlinuz.prev preserves the old kernel",
          sha256_file(gesp1 / "vmlinuz.prev") ==
          sha256_file(kern_a_geo))
    check("geometry: ESP /initramfs.prev.cpio.gz preserves the old "
          "initramfs",
          sha256_file(gesp1 / "initramfs.prev.cpio.gz") ==
          sha256_file(init_a_geo))
    grub_geo1 = (gesp1 / "EFI" / "ubuntu" / "grub.cfg").read_text()
    check("geometry: grub.cfg keeps the previous entry",
          "linux /vmlinuz.prev console=tty0 console=ttyS0 sevyn.slot=A"
          in grub_geo1 and
          "initrd /initramfs.prev.cpio.gz" in grub_geo1, grub_geo1)
    check("geometry: ESP sync leaves no temp files",
          not list(gesp1.glob("*.tmp.*")))
    d_geo1.stop()
    os.close(master3)
    os.close(slave3)
    shutil.rmtree(gd1)
    shutil.rmtree(gesp1)

    # Case 2 — too small even for the reworked order: the update is
    # refused LOUDLY before copying anything. The ESP stays
    # byte-identical and the slot state is not flipped.
    gd2, gesp2, kern_b2, init_b2 = geo_fixture("nofit", 96 * 1024 * 1024)
    grub_before = (gesp2 / "EFI" / "ubuntu" / "grub.cfg").read_text()
    master4, slave4 = pty.openpty()
    env_geo2 = geo_env("nofit", gd2, gesp2, 96 * 1024 * 1024)
    env_geo2["SEVYN_UPDATE_CTL"] = os.ttyname(slave4)
    d_geo2 = Daemon(tmp, env_geo2)
    check("geometry no-fit: daemon starts (96 MiB ESP)", d_geo2.start())
    write_feed(server_dir, key_file, "geo-nofit-2", "nightly",
               artifacts_for(kern_b2, init_b2))
    n_rb = geo_reboots()
    check("geometry no-fit: APPLY accepted",
          d_geo2.sock("APPLY") == "OK applying geo-nofit-2")
    check("geometry no-fit: refusal is loud (pre-check message)",
          d_geo2.watcher.wait_for("ESP sync needs", timeout=15) and
          d_geo2.watcher.wait_for("refusing before copying",
                                  timeout=15))
    time.sleep(1.0)
    check("geometry no-fit: no reboot requested",
          geo_reboots() == n_rb)
    st_geo2 = json.loads((gd2 / "slot-state.json").read_text())
    check("geometry no-fit: slot state not flipped",
          st_geo2["active"] == "A" and st_geo2["good"] == "A" and
          st_geo2["version"] == "geo-nofit-1", str(st_geo2))
    check("geometry no-fit: ESP /vmlinuz unchanged",
          sha256_file(gesp2 / "vmlinuz") ==
          sha256_file(kern_a_geo))
    check("geometry no-fit: ESP /initramfs.cpio.gz unchanged",
          sha256_file(gesp2 / "initramfs.cpio.gz") ==
          sha256_file(init_a_geo))
    check("geometry no-fit: no .prev files created",
          not (gesp2 / "vmlinuz.prev").exists() and
          not (gesp2 / "initramfs.prev.cpio.gz").exists())
    check("geometry no-fit: grub.cfg unchanged",
          (gesp2 / "EFI" / "ubuntu" / "grub.cfg").read_text() ==
          grub_before)
    check("geometry no-fit: ESP sync leaves no temp files",
          not list(gesp2.glob("*.tmp.*")))
    d_geo2.stop()
    os.close(master4)
    os.close(slave4)
    shutil.rmtree(gd2)
    shutil.rmtree(gesp2)

    # Case 3 — the good slot's files are gone: .prev degrades
    # explicitly. The update still lands, the GRUB "previous" entry
    # is omitted, and the degradation is logged loudly.
    gd3, gesp3, kern_b3, init_b3 = geo_fixture(
        "degraded", 144 * 1024 * 1024, with_good_slot=False)
    master5, slave5 = pty.openpty()
    env_geo3 = geo_env("degraded", gd3, gesp3, 144 * 1024 * 1024)
    env_geo3["SEVYN_UPDATE_CTL"] = os.ttyname(slave5)
    d_geo3 = Daemon(tmp, env_geo3)
    check("geometry degraded: daemon starts", d_geo3.start())
    write_feed(server_dir, key_file, "geo-degraded-2", "nightly",
               artifacts_for(kern_b3, init_b3))
    n_rb = geo_reboots()
    check("geometry degraded: APPLY accepted",
          d_geo3.sock("APPLY") == "OK applying geo-degraded-2")
    check("geometry degraded: apply requested a reboot",
          geo_wait_reboot(n_rb))
    check("geometry degraded: degradation is logged loudly",
          d_geo3.watcher.wait_for("previous' entry will be omitted",
                                  timeout=15))
    st_geo3 = json.loads((gd3 / "slot-state.json").read_text())
    check("geometry degraded: apply flipped state to B",
          st_geo3["active"] == "B" and st_geo3["good"] == "A" and
          st_geo3["version"] == "geo-degraded-2", str(st_geo3))
    check("geometry degraded: ESP /vmlinuz is the new kernel",
          sha256_file(gesp3 / "vmlinuz") == sha256_file(kern_b3))
    check("geometry degraded: ESP /initramfs.cpio.gz is the new "
          "initramfs",
          sha256_file(gesp3 / "initramfs.cpio.gz") ==
          sha256_file(init_b3))
    check("geometry degraded: no .prev files on the ESP",
          not (gesp3 / "vmlinuz.prev").exists() and
          not (gesp3 / "initramfs.prev.cpio.gz").exists())
    grub_geo3 = (gesp3 / "EFI" / "ubuntu" / "grub.cfg").read_text()
    check("geometry degraded: grub.cfg has the default entry",
          "linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=B"
          in grub_geo3, grub_geo3)
    check("geometry degraded: grub.cfg omits the previous entry",
          "vmlinuz.prev" not in grub_geo3 and
          "SevynOS (previous)" not in grub_geo3, grub_geo3)
    d_geo3.stop()
    os.close(master5)
    os.close(slave5)
    shutil.rmtree(gd3)
    shutil.rmtree(gesp3)

    # Case 4 — a big preserved menu: the old fixed 2048-byte grub.cfg
    # buffer refused the whole update ("grub.cfg too long") once the
    # preserved other-OS entries passed ~1.4 KiB. The menu is now
    # built on the heap, so the update lands and every other entry
    # survives verbatim.
    gd4, gesp4, kern_b4, init_b4 = geo_fixture("bigmenu", 144 * 1024 * 1024)
    other_entries = (
        "menuentry \"Windows 11\" {\n"
        "    chainloader /EFI/Microsoft/Boot/bootmgfw.efi\n"
        "}\n" +
        "".join(
            f"menuentry \"Other OS {i}\" {{\n"
            f"    linux /vmlinuz-{i} root=UUID=11111111-1111-1111-1111-"
            f"11111111111{i} ro quiet splash\n"
            "    initrd /initrd.img\n"
            "}\n" for i in range(14)))
    assert len(other_entries) > 1600, len(other_entries)
    grub4_path = gesp4 / "EFI" / "ubuntu" / "grub.cfg"
    grub4_path.write_text(grub4_path.read_text() + other_entries)
    master6, slave6 = pty.openpty()
    env_geo4 = geo_env("bigmenu", gd4, gesp4, 144 * 1024 * 1024)
    env_geo4["SEVYN_UPDATE_CTL"] = os.ttyname(slave6)
    d_geo4 = Daemon(tmp, env_geo4)
    check("big menu: daemon starts", d_geo4.start())
    write_feed(server_dir, key_file, "geo-bigmenu-2", "nightly",
               artifacts_for(kern_b4, init_b4))
    n_rb = geo_reboots()
    check("big menu: APPLY accepted",
          d_geo4.sock("APPLY") == "OK applying geo-bigmenu-2")
    check("big menu: apply requested a reboot",
          geo_wait_reboot(n_rb))
    st_geo4 = json.loads((gd4 / "slot-state.json").read_text())
    check("big menu: apply flipped state to B",
          st_geo4["active"] == "B" and st_geo4["good"] == "A" and
          st_geo4["version"] == "geo-bigmenu-2", str(st_geo4))
    grub_geo4 = grub4_path.read_text()
    check("big menu: grub.cfg exceeds the old 2048-byte cap",
          len(grub_geo4) > 2048, str(len(grub_geo4)))
    check("big menu: every other entry preserved verbatim",
          all(entry in grub_geo4 for entry in
              other_entries.split("menuentry ")[1:]) and
          "menuentry \"Windows 11\" {" in grub_geo4, grub_geo4)
    check("big menu: default entry boots the new slot",
          "linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=B"
          in grub_geo4, grub_geo4)
    d_geo4.stop()
    os.close(master6)
    os.close(slave6)
    shutil.rmtree(gd4)
    shutil.rmtree(gesp4)

    # Case 5 — transient download failure: a wget that fails its
    # first call, then works. The old single attempt killed the
    # whole apply; the retry wrapper (3 attempts, 1 s apart) lands
    # the update and logs the failed attempt.
    real_wget = shutil.which("wget")
    assert real_wget, "wget missing"
    wget_marker = tmp / "wget-failed-once"
    (tmp / "bin" / "wget").write_text(
        "#!/bin/sh\n"
        "# Fail the first wget call, then behave normally.\n"
        f"if [ ! -f \"{wget_marker}\" ]; then\n"
        f"    touch \"{wget_marker}\"\n"
        "    exit 1\n"
        "fi\n"
        f"exec {real_wget} \"$@\"\n")
    (tmp / "bin" / "wget").chmod(0o755)
    gd5, gesp5, kern_b5, init_b5 = geo_fixture("retry", 144 * 1024 * 1024)
    master7, slave7 = pty.openpty()
    env_geo5 = geo_env("retry", gd5, gesp5, 144 * 1024 * 1024)
    env_geo5["SEVYN_UPDATE_CTL"] = os.ttyname(slave7)
    d_geo5 = Daemon(tmp, env_geo5)
    check("retry: daemon starts", d_geo5.start())
    write_feed(server_dir, key_file, "geo-retry-2", "nightly",
               artifacts_for(kern_b5, init_b5))
    n_rb = geo_reboots()
    check("retry: APPLY accepted",
          d_geo5.sock("APPLY") == "OK applying geo-retry-2")
    check("retry: failed attempt is logged",
          d_geo5.watcher.wait_for("download attempt 1/3 failed",
                                  timeout=15))
    check("retry: apply requested a reboot",
          geo_wait_reboot(n_rb))
    st_geo5 = json.loads((gd5 / "slot-state.json").read_text())
    check("retry: apply flipped state to B",
          st_geo5["active"] == "B" and st_geo5["good"] == "A" and
          st_geo5["version"] == "geo-retry-2", str(st_geo5))
    d_geo5.stop()
    os.close(master7)
    os.close(slave7)
    (tmp / "bin" / "wget").unlink()
    shutil.rmtree(gd5)
    shutil.rmtree(gesp5)

    server.shutdown()
    os.close(master_fd)
    os.close(slave_fd)
    shutil.rmtree(tmp, ignore_errors=True)

    failed = [c for c in CHECKS if not c[1]]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    if failed:
        print("FAILURES:")
        for name, _, detail in failed:
            print(f"  - {name} {detail}")
        return 1
    print("\nALL UPDATE TESTS PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
