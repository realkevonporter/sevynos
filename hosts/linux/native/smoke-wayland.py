import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time

frame_read, frame_write = os.pipe()
if frame_read != 3:
    os.dup2(frame_read, 3)
    os.close(frame_read)
    frame_read = 3
process = subprocess.Popen(
    ["sevyn-wayland-bridge"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=sys.stderr, text=True, env=os.environ.copy(), pass_fds=(frame_read,)
)
os.close(frame_read)
frame_output = os.fdopen(frame_write, "wb", buffering=0)
sequence = 0
messages = queue.Queue()

def read_messages():
    for line in process.stdout:
        messages.put(json.loads(line))

threading.Thread(target=read_messages, daemon=True).start()

def receive(expected):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            message = messages.get(timeout=max(0.01, deadline - time.monotonic()))
        except queue.Empty:
            break
        if message.get("type") == expected: return message
    raise RuntimeError("bridge did not emit " + expected)
def send(kind, **payload):
    global sequence
    sequence += 1
    message = {"protocolVersion": 1, "sequence": sequence, "type": kind, **payload}
    process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    process.stdin.flush()

ready = receive("ready")
display = ready["displays"][0]
width, height = display["width"], display["height"]
pixels = bytes((28, 31, 39, 255)) * width * height
# Distinct corners expose channel order, orientation, stride, and clipping errors.
pixels = bytearray(pixels)
for x, y, rgba in (
    (0, 0, (255, 0, 0, 255)),
    (width - 1, 0, (0, 255, 0, 255)),
    (0, height - 1, (0, 0, 255, 255)),
    (width - 1, height - 1, (255, 255, 255, 255)),
):
    offset = (y * width + x) * 4
    pixels[offset:offset + 4] = bytes(rgba)
display_id = display["id"].encode("utf-8")
header = struct.pack(
    "<8sIIQIIIIIIIIQ", b"SEVYNFRM", 1, 64, 1, width, height, width * 4,
    1, len(display_id), 0, len(pixels), 1, 0
)
damage = struct.pack("<iiii", 0, 0, width, height)
for chunk in (header, damage, display_id, pixels):
    view = memoryview(chunk)
    while view:
        written = frame_output.write(view)
        if not written: raise RuntimeError("binary frame pipe closed")
        view = view[written:]
presented = receive("frame-presented")
if presented["frameId"] != 1: raise RuntimeError("wrong frame acknowledgement")
send("shutdown-complete")
frame_output.close()
process.wait(timeout=5)
if process.returncode != 0: raise RuntimeError("bridge shutdown failed")
print("native Wayland smoke: xdg toplevel configured and RGBA wl_shm frame presented")
