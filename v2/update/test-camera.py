#!/usr/bin/env python3
"""Host-side tests for the Camera v1 `sevyn` CLI verbs
(v2/update/sevyn.c): `camera` (preview Chromium over CDP on its own
port 9223, the capture helper exec, quit/status).

Builds the CLI with the host gcc, then drives it against a FAKE CDP
server (an HTTP server that replies like Chromium's DevTools
endpoint: /json/version, /json/list with a camera.html page target
whose title carries the preview state), a FAKE Chromium (a Python
script that records its argv and optionally serves CDP after a
delay), and a STUB Node capture helper (a shell script that prints
`saved:`). No QEMU, no Chromium, no camera — the CI harness
(m13-check) covers the guest end to end.

Run: python3 v2/update/test-camera.py
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


# The fake's live page list: the camera page target (title carries
# the preview state — see camera-page.js) plus a non-camera page.
# Tests mutate CAMERA_TITLE to drive the preview: states.
CAMERA_TITLE = ["Camera ready 1280x720"]


def camera_tabs():
    return [
        {
            "description": "",
            "devtoolsFrontendUrl": "",
            "id": "C" * 32,
            "title": CAMERA_TITLE[0],
            "type": "page",
            "url": "file:///usr/share/sevyn/camera/camera.html",
            "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/CAM",
        },
        {
            "description": "",
            "devtoolsFrontendUrl": "",
            "id": "D" * 32,
            "title": "Other",
            "type": "page",
            "url": "about:blank",
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
            self._send_json(200, camera_tabs())
        else:
            self.send_response(404)
            self.end_headers()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def run_cli(binary, args, env_extra):
    env = dict(os.environ)
    env.update(env_extra)
    r = subprocess.run([str(binary)] + args, capture_output=True,
                       text=True, timeout=60, env=env)
    return r


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-camera-test-"))
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

    # Fake CDP on a scratch port (the camera's own port, not the
    # browser's 9222); a scratch state file so the test never
    # touches /data.
    port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), CDPHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    photos_dir = tmp / "photos"
    photos_dir.mkdir()
    (photos_dir / "IMG_20261116_120000.jpg").write_bytes(b"\xff\xd8fake")
    (photos_dir / "IMG_20261116_120100.JPEG").write_bytes(b"\xff\xd8fake")
    (photos_dir / "notes.txt").write_text("not a photo")
    (photos_dir / "thumb.png").write_bytes(b"\x89PNGfake")
    (photos_dir / ".camera").mkdir()
    (photos_dir / ".camera" / "IMG_20261116_120000.png").write_bytes(b"\x89PNGfake")
    env = {"SEVYN_CAMERA_CDP_PORT": str(port),
           "SEVYN_CAMERA_STATE": str(tmp / "camera.state"),
           "SEVYN_CAMERA_PHOTOS_DIR": str(photos_dir)}

    # --- camera status (preview Chromium "running") ---
    r = run_cli(binary, ["camera", "status"], env)
    check("camera status: exit 0 when CDP answers", r.returncode == 0, r.stderr)
    check("camera status: running yes", "running: yes" in r.stdout, r.stdout)
    check("camera status: cdp yes", "cdp: yes" in r.stdout, r.stdout)
    check("camera status: preview ready from the page title",
          "preview: ready" in r.stdout, r.stdout)
    check("camera status: photos counts top-level JPEGs only (2)",
          "photos: 2" in r.stdout, r.stdout)
    check("camera status: gpu unknown without a state file",
          "gpu: unknown" in r.stdout, r.stdout)

    # Preview states come from the page title.
    CAMERA_TITLE[0] = "Camera error: Permission denied"
    r = run_cli(binary, ["camera", "status"], env)
    check("camera status: preview error from the page title",
          "preview: error" in r.stdout and
          "preview-error: Permission denied" in r.stdout, r.stdout)
    CAMERA_TITLE[0] = "Camera starting…"
    r = run_cli(binary, ["camera", "status"], env)
    check("camera status: preview starting from the page title",
          "preview: starting" in r.stdout, r.stdout)
    CAMERA_TITLE[0] = "Camera ready 1280x720"

    # --- camera status when CDP is down ---
    dead = dict(env)
    dead["SEVYN_CAMERA_CDP_PORT"] = str(free_port())  # nothing listening
    r = run_cli(binary, ["camera", "status"], dead)
    check("camera status: exit 1 + running no when CDP down",
          r.returncode == 1 and "running: no" in r.stdout,
          r.stdout + r.stderr)

    # --- camera capture needs a running preview ---
    r = run_cli(binary, ["camera", "capture"], dead)
    check("camera capture: exit 1 when preview not running",
          r.returncode == 1 and "preview is not running" in r.stderr,
          r.stdout + r.stderr)

    # --- camera capture (stub Node helper) ---
    # The helper path must exist (the CLI checks it); the stub Node
    # ignores it and prints `saved:` like the real helper. The stub
    # records its argv so the test can assert the CDP port rides on
    # the command line.
    stub_node = tmp / "stub-node.sh"
    stub_node.write_text(
        "#!/bin/sh\n"
        "echo \"$@\" > \"" + str(tmp / "node-argv") + "\"\n"
        "echo \"saved: /data/IMG_20261116_120000.jpg\"\n"
        "echo \"preview: /data/.camera/IMG_20261116_120000.png\"\n")
    os.chmod(stub_node, 0o755)
    capture_env = dict(env)
    capture_env["SEVYN_CAMERA_NODE"] = str(stub_node)
    capture_env["SEVYN_CAMERA_CAPTURE"] = str(HERE.parent / "camera" /
                                              "camera-capture.mjs")
    r = run_cli(binary, ["camera", "capture"], capture_env)
    check("camera capture: exit 0 with a running preview",
          r.returncode == 0, r.stdout + r.stderr)
    check("camera capture: prints the helper's saved: line",
          "saved: /data/IMG_20261116_120000.jpg" in r.stdout, r.stdout)
    argv = (tmp / "node-argv").read_text()
    check("camera capture: helper gets the camera CDP port",
          f"--port {port}" in argv, argv)
    check("camera capture: helper gets /data as the out dir",
          "--out-dir /data" in argv and "--preview-dir /data/.camera" in argv,
          argv)

    # Missing helper file -> exit 1 (before any fork).
    missing_env = dict(capture_env)
    missing_env["SEVYN_CAMERA_CAPTURE"] = str(tmp / "no-such-helper.mjs")
    r = run_cli(binary, ["camera", "capture"], missing_env)
    check("camera capture: exit 1 when the helper is missing",
          r.returncode == 1 and "helper missing" in r.stderr,
          r.stdout + r.stderr)

    # --- camera quit (idempotent; kills a live pid) ---
    r = run_cli(binary, ["camera", "quit"], env)
    check("camera quit: not-running with no state file (exit 0)",
          r.returncode == 0 and "quit: not-running" in r.stdout, r.stdout)
    sleeper = subprocess.Popen(["sleep", "60"])
    try:
        (tmp / "camera.state").write_text(f"pid={sleeper.pid}\ngpu=yes\n")
        r = run_cli(binary, ["camera", "quit"], env)
        check("camera quit: ok + kills the recorded pid",
              r.returncode == 0 and "quit: ok" in r.stdout, r.stdout)
        time.sleep(0.3)
        check("camera quit: the pid is actually dead",
              sleeper.poll() is not None, f"poll={sleeper.poll()}")
        check("camera quit: state file removed",
              not (tmp / "camera.state").exists())
    finally:
        if sleeper.poll() is None:
            sleeper.kill()
        sleeper.wait()

    # --- camera preview launches Chromium when it is not running ---
    # Fake Chromium: records argv, then serves CDP after a 1 s delay
    # with the --app= URL as its only tab (the slow-start path the
    # check relies on). It exits on its own after 15 s.
    fake_chromium = tmp / "fake-chromium.py"
    fake_chromium.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, threading, time\n"
        "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n"
        "port = int(os.environ.get('SEVYN_CAMERA_CDP_PORT', '9223'))\n"
        "open(os.environ['FAKE_ARGV_FILE'], 'w').write(' '.join(sys.argv[1:]))\n"
        "url = next((a[6:] for a in sys.argv[1:] if a.startswith('--app=')), 'about:blank')\n"
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
        "            self._j(200, [{'id': 'E' * 32, 'title': 'Camera ready 1280x720',\n"
        "                           'type': 'page', 'url': url}])\n"
        "        else:\n"
        "            self.send_response(404); self.end_headers()\n"
        "time.sleep(1)\n"
        "srv = ThreadingHTTPServer(('127.0.0.1', port), H)\n"
        "threading.Thread(target=srv.serve_forever, daemon=True).start()\n"
        "time.sleep(15)\n")
    os.chmod(fake_chromium, 0o755)

    # The /bin/true launch: exits at once, CDP never answers — the
    # preview must return promptly with "preview: launched" (exit 0),
    # like `browser open` on a slow start.
    launch_env = dict(dead)
    launch_env["SEVYN_CHROMIUM_BIN"] = "/bin/true"
    launch_env["SEVYN_CDP_WAIT_S"] = "2"
    t0 = time.time()
    r = run_cli(binary, ["camera", "preview"], launch_env)
    dt = time.time() - t0
    check("camera preview: slow start returns launched (exit 0)",
          r.returncode == 0 and "preview: launched" in r.stdout,
          r.stdout + r.stderr)
    check("camera preview: launch wait bounded (< 10 s)",
          dt < 10, f"took {dt:.1f}s")

    # Slow start where CDP comes up during the wait -> ready.
    slow_port = free_port()
    slow_state = tmp / "camera-slow.state"
    slow_env = {"SEVYN_CAMERA_CDP_PORT": str(slow_port),
                "SEVYN_CAMERA_STATE": str(slow_state),
                "SEVYN_CHROMIUM_BIN": str(fake_chromium),
                "SEVYN_CDP_WAIT_S": "10",
                "FAKE_ARGV_FILE": str(tmp / "chromium-argv")}
    t0 = time.time()
    r = run_cli(binary, ["camera", "preview", "--fake-media"], slow_env)
    dt = time.time() - t0
    check("camera preview: CDP up during wait returns ready",
          r.returncode == 0 and "preview: ready" in r.stdout,
          r.stdout + r.stderr)
    check("camera preview: slow-start wait bounded (< 10 s)",
          dt < 10, f"took {dt:.1f}s")
    argv = (tmp / "chromium-argv").read_text()
    check("camera preview: launches --app=file://camera.html",
          "--app=file:///usr/share/sevyn/camera/camera.html" in argv, argv)
    check("camera preview: launches on the camera CDP port (not 9222)",
          f"--remote-debugging-port={slow_port}" in argv, argv)
    check("camera preview: --fake-media passes the fake-device flags",
          "--use-fake-device-for-media-stream" in argv and
          "--use-fake-ui-for-media-stream" in argv, argv)
    check("camera preview: 800x348 content window",
          "--window-size=800,348" in argv, argv)
    check("camera preview: own profile (not the browser's)",
          "--user-data-dir=/tmp/camera-profile" in argv, argv)
    state_text = slow_state.read_text()
    check("camera preview: state file records the pid + gpu mode",
          "pid=" in state_text and "gpu=yes" in state_text, state_text)

    # Already running -> already-running (the fake is still serving).
    r = run_cli(binary, ["camera", "preview"], slow_env)
    check("camera preview: already-running when CDP answers",
          r.returncode == 0 and "preview: already-running" in r.stdout,
          r.stdout + r.stderr)

    # Real-media default: no fake-device flags without --fake-media.
    # (The slow fake is still up on slow_port, so use a fresh port
    # with /bin/true and read argv from... /bin/true records nothing.
    # Instead, launch the fake on a fresh port with no flag and read
    # its argv file — the fake serves CDP after 1 s, so preview
    # returns ready and the argv file is written.)
    real_port = free_port()
    real_env = dict(slow_env)
    real_env["SEVYN_CAMERA_CDP_PORT"] = str(real_port)
    real_env["SEVYN_CAMERA_STATE"] = str(tmp / "camera-real.state")
    real_env["FAKE_ARGV_FILE"] = str(tmp / "chromium-argv-real")
    r = run_cli(binary, ["camera", "preview"], real_env)
    check("camera preview: real-media default returns ready",
          r.returncode == 0 and "preview: ready" in r.stdout,
          r.stdout + r.stderr)
    argv = (tmp / "chromium-argv-real").read_text()
    check("camera preview: no fake-device flags by default",
          "--use-fake-device-for-media-stream" not in argv, argv)

    # Unknown verb / bad flag -> usage (exit 1).
    r = run_cli(binary, ["camera", "bogus"], env)
    check("camera: unknown verb exits 1", r.returncode == 1)
    r = run_cli(binary, ["camera", "preview", "--bogus"], env)
    check("camera preview: unknown flag exits 1", r.returncode == 1)

    server.shutdown()
    server.server_close()

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURES: {FAILURES}")
        return 1
    print("\ntest-camera: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
