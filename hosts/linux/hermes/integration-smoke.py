#!/usr/bin/env python3
import json
import subprocess
import sys
import time

process = subprocess.Popen(
    [sys.argv[1], sys.argv[2], sys.argv[3]],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)
identity = dict(
    protocolVersion=1,
    applicationId="org.sevynos.hermes-smoke",
    sessionId="worker-session-1",
)

def send(**message):
    process.stdin.write(json.dumps(dict(identity, **message)) + "\n")
    process.stdin.flush()

send(sequence=1, type="initialize", manifest={}, applicationKey="main",
     bundleSource="", grantedPermissions=[], persistedState=None)
send(sequence=2, type="mount", viewport={"width": 760, "height": 494})
time.sleep(0.1)
send(sequence=3, type="shutdown", reason="smoke-test")
stdout, stderr = process.communicate(timeout=5)
messages = [json.loads(line) for line in stdout.splitlines()
            if line.startswith("{") and "protocolVersion" in line]
types = [message.get("type") for message in messages]
if process.returncode != 0 or "ready" not in types or "surface" not in types or "shutdown-complete" not in types:
    print(stdout, file=sys.stderr)
    print(stderr, file=sys.stderr)
    raise SystemExit(1)
surface = next(message for message in messages if message.get("type") == "surface")
if not surface.get("commands"):
    raise SystemExit("Hermes surface contained no render commands")
print("Hermes runtime, renderer, timer loop, protocol, and shutdown passed")
