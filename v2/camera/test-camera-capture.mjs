// SevynOS v2 Camera v1 — test for camera-capture.mjs.
//
// Spawns the real helper against a FAKE CDP server (HTTP /json/list
// + /json/version, and a minimal WebSocket server that answers
// Target.attachToTarget + Runtime.evaluate with a canned capture).
// Proves: JPEG + PNG preview written with the right names/magic,
// failure modes (no camera target, page capture throws) exit 1.
//
// The WebSocket server is hand-rolled (no deps): HTTP Upgrade +
// Sec-WebSocket-Accept, masked client frames parsed, unmasked
// server frames sent. Only text frames are needed — the helper
// sends small JSON messages and expects small JSON replies.
//
// Run: node test-camera-capture.mjs   (from v2/camera)
// Exit 0 = all checks pass.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "camera-capture.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log("  ok: " + name);
  else {
    console.log("FAIL: " + name + (detail ? " " + detail : ""));
    failures++;
  }
}

// Fake frame bytes: valid magic, >1 KB, JPEG ends with the EOI marker.
function fakeJpeg() {
  const b = Buffer.alloc(1500, 0);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[1498] = 0xff;
  b[1499] = 0xd9;
  return b;
}
function fakePng() {
  const b = Buffer.alloc(1400, 0);
  b[0] = 0x89;
  b[1] = 0x50;
  b[2] = 0x4e;
  b[3] = 0x47;
  return b;
}

// --- minimal WebSocket server -------------------------------------------
function wsAccept(key) {
  return crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

// Parse as many complete (masked) client frames as the buffer holds.
// Returns { messages: string[], rest: Buffer }.
function parseFrames(buf) {
  const messages = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const op = b0 & 0x0f;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    if (op === 1) messages.push(payload.toString("utf8"));
    else if (op === 8) messages.push("__CLOSE__");
    else if (op === 9) messages.push("__PING__");
    off = p + len;
  }
  return { messages, rest: buf.subarray(off) };
}

// mode: "ok" (capture returns frames) | "throw" (page capture throws)
// | "notarget" (no camera page in /json/list).
function startFakeCdp(mode) {
  const targets = [
    {
      description: "",
      devtoolsFrontendUrl: "",
      id: "CAMERATARGETID",
      title: "Camera ready 1280x720",
      type: "page",
      url: "file:///usr/share/sevyn/camera/camera.html",
      webSocketDebuggerUrl: "",
    },
  ];
  const server = http.createServer((req, res) => {
    if (req.url === "/json/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mode === "notarget" ? [] : targets));
    } else if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/X`,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"] || "";
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = parseFrames(buf);
      buf = rest;
      for (const m of messages) {
        if (m === "__CLOSE__") {
          socket.end();
          return;
        }
        if (m === "__PING__") {
          socket.write(Buffer.from([0x8a, 0x00])); // pong, empty
          continue;
        }
        let msg;
        try {
          msg = JSON.parse(m);
        } catch {
          continue;
        }
        let result = null;
        if (msg.method === "Target.attachToTarget") {
          result = { sessionId: "SESS1" };
        } else if (msg.method === "Runtime.evaluate") {
          if (mode === "throw") {
            result = {
              exceptionDetails: {
                text: "Uncaught",
                exception: { description: "Error: no video frames yet" },
              },
            };
          } else {
            result = {
              result: {
                type: "object",
                value: {
                  jpeg: "data:image/jpeg;base64," + fakeJpeg().toString("base64"),
                  png: "data:image/png;base64," + fakePng().toString("base64"),
                  width: 1280,
                  height: 720,
                  at: Date.now(),
                },
              },
            };
          }
        } else {
          result = {};
        }
        const reply = { id: msg.id, result };
        if (msg.sessionId) reply.sessionId = msg.sessionId;
        socket.write(encodeFrame(JSON.stringify(reply)));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runHelper(port, outDir, previewDir) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        HELPER,
        "--port",
        String(port),
        "--out-dir",
        outDir,
        "--preview-dir",
        previewDir,
        "--timeout-ms",
        "10000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sevyn-camera-test-"));
}

async function main() {
  // Happy path: writes IMG_*.jpg + .png sidecar, prints saved:/preview:.
  {
    const server = await startFakeCdp("ok");
    const port = server.address().port;
    const root = tmpDir();
    const outDir = path.join(root, "data");
    const previewDir = path.join(root, "previews");
    const r = await runHelper(port, outDir, previewDir);
    check("capture: exit 0", r.code === 0, `code=${r.code} stderr=${r.stderr}`);
    const saved = r.stdout.match(/^saved: (.+)$/m);
    const preview = r.stdout.match(/^preview: (.+)$/m);
    check("capture: prints saved: line", !!saved, r.stdout);
    check("capture: prints preview: line", !!preview, r.stdout);
    if (saved && preview) {
      const jpeg = fs.readFileSync(saved[1]);
      const png = fs.readFileSync(preview[1]);
      check("capture: JPEG starts SOI", jpeg[0] === 0xff && jpeg[1] === 0xd8);
      check(
        "capture: JPEG ends EOI",
        jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9,
      );
      check(
        "capture: PNG magic",
        png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      );
      check(
        "capture: JPEG name IMG_*.jpg",
        /IMG_\d{8}_\d{6}\.jpg$/.test(saved[1]),
        saved[1],
      );
      check(
        "capture: preview shares the photo basename",
        preview[1].endsWith(path.basename(saved[1], ".jpg") + ".png"),
        preview[1],
      );
      check("capture: JPEG is the frame bytes", jpeg.equals(fakeJpeg()));
      check("capture: PNG is the frame bytes", png.equals(fakePng()));
    }
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // No camera page target -> exit 1, no files.
  {
    const server = await startFakeCdp("notarget");
    const port = server.address().port;
    const root = tmpDir();
    const r = await runHelper(port, path.join(root, "data"), path.join(root, "previews"));
    check("capture: no-target exits 1", r.code === 1, `code=${r.code}`);
    check(
      "capture: no-target explains",
      /no camera page target/.test(r.stderr),
      r.stderr,
    );
    check("capture: no-target writes nothing", !fs.existsSync(path.join(root, "data")));
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Page capture throws (no frames) -> exit 1, no files.
  {
    const server = await startFakeCdp("throw");
    const port = server.address().port;
    const root = tmpDir();
    const r = await runHelper(port, path.join(root, "data"), path.join(root, "previews"));
    check("capture: page-throw exits 1", r.code === 1, `code=${r.code}`);
    check(
      "capture: page-throw surfaces the cause",
      /no video frames yet/.test(r.stderr),
      r.stderr,
    );
    check("capture: page-throw writes nothing", !fs.existsSync(path.join(root, "data")));
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // CDP down entirely -> exit 1.
  {
    const root = tmpDir();
    const r = await runHelper(1, path.join(root, "data"), path.join(root, "previews"));
    check("capture: CDP-down exits 1", r.code === 1, `code=${r.code}`);
    check("capture: CDP-down explains", /cannot reach CDP/.test(r.stderr), r.stderr);
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("camera-capture tests passed");
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
