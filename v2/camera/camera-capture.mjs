// SevynOS v2 Camera v1 — shutter capture helper.
//
// Run by `sevyn camera capture` (the C CLI execs the image's Node:
// /usr/share/sevyn/comms/node, SEVYN_CAMERA_NODE to override). The
// preview Chromium is already running (started by `sevyn camera
// preview`); this script drives it over CDP — the same WebSocket
// pattern as v2/comms/bridge.mjs — and grabs the current video
// frame from the preview page:
//
//   Runtime.evaluate window.__sevynCamera.capture()
//     -> { jpeg, png, width, height } (data URLs, see camera-page.js)
//
// It writes the REAL photo as a JPEG to --out-dir (/data, where
// Photos already looks) and the PNG viewer preview to --preview-dir
// (/data/.camera — the RN host's image loader is PNG-only, so the
// Camera gallery shows the PNG sidecar; the JPEG is the photo).
//
// Usage:
//   node camera-capture.mjs [--port 9223] [--out-dir /data]
//       [--preview-dir /data/.camera] [--page-match camera.html]
//       [--timeout-ms 20000]
// Prints `saved: <jpeg path>` + `preview: <png path>` on success
// (the lines `sevyn camera capture` and the check wait for).
// Exit 0 on success, 1 with `error: ...` on stderr otherwise.
// No dependencies (Node >= 22: global fetch + WebSocket).

import fs from "node:fs/promises";
import path from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg("--port", "9223"));
const OUT_DIR = arg("--out-dir", "/data");
const PREVIEW_DIR = arg("--preview-dir", "/data/.camera");
const PAGE_MATCH = arg("--page-match", "camera.html");
const TIMEOUT_MS = Number(arg("--timeout-ms", "20000"));

function fail(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

function decodeDataUrl(url, kind, magic) {
  const prefix = "data:image/" + kind + ";base64,";
  if (typeof url !== "string" || !url.startsWith(prefix)) {
    fail("capture returned no " + kind + " data URL");
  }
  const buf = Buffer.from(url.slice(prefix.length), "base64");
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) fail("capture returned invalid " + kind + " bytes");
  }
  if (buf.length < 1024) fail("capture returned a suspiciously small " + kind);
  return buf;
}

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "_" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

async function uniquePath(dir, base, ext) {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base + ext : base + "-" + n + ext;
    const full = path.join(dir, name);
    try {
      await fs.stat(full);
    } catch {
      return full; // does not exist yet
    }
  }
  fail("could not find a free filename for " + base);
}

function cdpCall(ws, nextId, pending, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId.value++;
    // The timer MUST be cleared on settle: an uncleared 15 s timer
    // keeps the process alive after the capture prints, and the
    // host kills `sevyn camera capture` at 10 s (the shutter would
    // never report saved).
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("CDP timeout for " + method));
      }
    }, 15000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  const timeLeft = () => deadline - Date.now();

  // 1. Find the camera page target over CDP HTTP.
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!res.ok) fail("CDP /json/list returned HTTP " + res.status);
    targets = await res.json();
  } catch (e) {
    fail("cannot reach CDP on port " + PORT + ": " + e.message);
  }
  const target = (targets || []).find(
    (t) => t.type === "page" && typeof t.url === "string" && t.url.includes(PAGE_MATCH),
  );
  if (!target) {
    fail("no camera page target (url containing " + PAGE_MATCH + ") on port " + PORT);
  }

  // 2. Attach over the browser-level WebSocket.
  let version;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    version = await res.json();
  } catch (e) {
    fail("cannot reach CDP /json/version: " + e.message);
  }
  if (!version.webSocketDebuggerUrl)
    fail("CDP /json/version has no webSocketDebuggerUrl");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP WebSocket connect timed out")),
      5000,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket connect failed"));
    };
  });
  const pending = new Map();
  const nextId = { value: 1 };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
    }
  };
  const wsClose = () => {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  };

  try {
    const attached = await cdpCall(ws, nextId, pending, "Target.attachToTarget", {
      targetId: target.id,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    const r = await cdpCall(
      ws,
      nextId,
      pending,
      "Runtime.evaluate",
      {
        expression: "window.__sevynCamera.capture()",
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (r?.exceptionDetails) {
      const desc =
        r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        "page error";
      fail("preview page capture failed: " + String(desc).slice(0, 200));
    }
    const shot = r?.result?.value;
    if (!shot || typeof shot !== "object") fail("preview page returned no capture");
    if (timeLeft() <= 0) fail("capture timed out");

    // 3. Decode + validate both encodings of the same frame.
    const jpeg = decodeDataUrl(shot.jpeg, "jpeg", [0xff, 0xd8]);
    const png = decodeDataUrl(shot.png, "png", [0x89, 0x50, 0x4e, 0x47]);
    // JPEG must end with the EOI marker — a truncated frame is not
    // a photo (a canvas data URL is complete by construction, but
    // the check is cheap and the failure mode is silent otherwise).
    if (jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
      fail("capture returned a truncated JPEG (no EOI marker)");
    }

    // 4. Save: JPEG to /data (Photos), PNG preview beside it in
    // /data/.camera (gallery viewer — host image loader is PNG-only).
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.mkdir(PREVIEW_DIR, { recursive: true });
    const base = "IMG_" + stamp(new Date());
    const jpegPath = await uniquePath(OUT_DIR, base, ".jpg");
    const pngPath = path.join(PREVIEW_DIR, path.basename(jpegPath, ".jpg") + ".png");
    await fs.writeFile(jpegPath, jpeg, { mode: 0o644 });
    await fs.writeFile(pngPath, png, { mode: 0o644 });
    console.log("saved: " + jpegPath);
    console.log("preview: " + pngPath);
  } finally {
    wsClose();
  }
}

main().catch((e) => fail(e.message || String(e)));
