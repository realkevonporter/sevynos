// Mock relay (Phase 2): the cloud-agent peer for the m4.5 check — a test
// double, never a system service. It speaks the relay protocol (INTERFACES.md)
// to the REAL sevyn-relay agent on loopback, so the guest proves a real task
// over the real agent with no network and no real cloud. Node built-in
// `crypto` only (Ed25519, X25519 via generateKeyPairSync + diffieHellman —
// NOT createECDH, Node 24 rejects 'x25519' there — ChaCha20-Poly1305, HKDF).
//
// Frames are NDJSON; hello/hello-ok/hello-ack are plaintext, the rest is
// AEAD-sealed {"type":"sealed","data":"<base64 ct||tag>"} with the session key
// from HKDF-SHA256(salt = nonce_cloud || nonce_device, info = "sevyn-relay-v1").
//
// Modes (--mode): auto (default) waits for the agent, expects
// pairing-required first, waits for approval, then runs one task.
// unpaired: one attempt, expect pairing-required, exit 0. paired: full
// handshake + task + session-end, exit 0. frame: full handshake +
// one frame-request, reassemble the PNG (verifying sha256 + byte
// count) and write it to --out, exit 0. frame-refused: full
// handshake + one frame-request, expect an error reply (the
// fail-closed path — no compositor, or a sensitive surface), exit 0.
// Runs ONCE; every frame is logged.
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");

const INFO = "sevyn-relay-v1";
// Auto mode waits up to 30 min: the mock starts at boot but the check enables the agent minutes later (after §6/§7/§8, under TCG).
const AUTO_BUDGET_MS = 30 * 60 * 1000;
const SINGLE_BUDGET_MS = 60 * 1000;
// Frame modes wait up to 5 min: the check enables the agent, sees
// pairing-required, approves it, and the mock's next attempt pairs.
const FRAME_BUDGET_MS = 5 * 60 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 2000;

function parseArgs(argv) {
  const opts = { mode: "auto", host: "127.0.0.1", port: 17893 };
  opts.task = "session fix the settings";
  opts.out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode" && argv[i + 1]) opts.mode = argv[++i];
    else if (a === "--agent-host" && argv[i + 1]) opts.host = argv[++i];
    else if (a === "--agent-port" && argv[i + 1]) opts.port = parseInt(argv[++i], 10);
    else if (a === "--task" && argv[i + 1]) opts.task = argv[++i];
    else if (a === "--out" && argv[i + 1]) opts.out = argv[++i];
    else fail(`unknown argument: ${a}`);
  }
  if (!["auto", "unpaired", "paired", "frame", "frame-refused"].includes(opts.mode))
    fail(`unknown --mode: ${opts.mode}`);
  if (opts.mode === "frame" && !opts.out) fail("--mode frame needs --out <png path>");
  return opts;
}
function log(msg) {
  console.log(`RELAY-MOCK ${msg}`);
}
function fail(msg) {
  console.log(`RELAY-MOCK FATAL ${msg}`);
  process.exit(1);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Key encoding: the wire carries raw 32-byte keys as base64 (no raw OKP export in Node; JWK `x` IS the raw 32 bytes).
function b64(buf) {
  return Buffer.from(buf).toString("base64");
}
function unb64(s) {
  return Buffer.from(s, "base64");
}
function rawPub(key) {
  return Buffer.from(key.export({ format: "jwk" }).x, "base64url");
}
function importPub(raw, crv) {
  return crypto.createPublicKey({
    key: { kty: "OKP", crv, x: raw.toString("base64url") },
    format: "jwk",
  });
}
// AEAD: ChaCha20-Poly1305, nonce = 4 zero bytes + 8-byte counter.
function aeadNonce(counter) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}
function seal(key, counter, obj) {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, aeadNonce(counter));
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return { type: "sealed", data: b64(Buffer.concat([ct, cipher.getAuthTag()])) };
}
function open(key, counter, dataB64) {
  const buf = unb64(dataB64);
  const decipher = crypto.createDecipheriv("chacha20-poly1305", key, aeadNonce(counter));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const ct = buf.subarray(0, buf.length - 16);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}
// NDJSON line reader over a socket, with timeouts and close/error propagation (a dead socket must not hang the read).
function lineReader(sock) {
  let buf = "";
  const lines = [];
  const waiters = [];
  let dead = null;
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (waiters.length) waiters.shift()(line);
      else lines.push(line);
    }
  });
  const die = (err) => {
    dead = dead || err;
    while (waiters.length) waiters.shift()(null);
  };
  sock.on("error", (err) => die(err));
  sock.on("close", () => die(new Error("socket closed")));
  return {
    next(timeoutMs) {
      if (lines.length) return Promise.resolve(lines.shift());
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
        waiters.push((line) => {
          clearTimeout(timer);
          if (line === null) reject(dead || new Error("socket closed"));
          else resolve(line);
        });
      });
    },
  };
}
function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
  });
}
// One handshake attempt. Returns { pairingRequired, code } when the
// agent demands pairing, or { session } on a full run — the session
// object sends sealed plaintexts and yields the next decrypted one
// (answering pings on the way), with per-direction AEAD counters.
async function attemptHandshake(opts, keys) {
  const sock = await connect(opts.host, opts.port);
  const reader = lineReader(sock);
  const send = (obj) => sock.write(`${JSON.stringify(obj)}\n`);
  try {
    send({
      type: "hello",
      agent_key: b64(rawPub(keys.ed.publicKey)),
      eph_key: b64(rawPub(keys.eph.publicKey)),
      nonce: b64(keys.nonceC),
    });
    log("hello sent");
    const msg = JSON.parse(await reader.next(SESSION_TIMEOUT_MS));
    if (msg.type === "error") {
      sock.destroy();
      return { pairingRequired: true, code: msg.pairing_code || "?" };
    }
    if (msg.type !== "hello-ok")
      throw new Error(`unexpected reply to hello: ${JSON.stringify(msg).slice(0, 120)}`);
    const deviceKey = importPub(unb64(msg.device_key), "Ed25519");
    if (!crypto.verify(null, keys.nonceC, deviceKey, unb64(msg.sig)))
      throw new Error("hello-ok signature invalid");
    log(`hello-ok device=${msg.device_id || "?"}`);
    const nonceD = unb64(msg.nonce);
    send({ type: "hello-ack", sig: b64(crypto.sign(null, nonceD, keys.ed.privateKey)) });
    log("hello-ack sent");
    const shared = crypto.diffieHellman({
      privateKey: keys.eph.privateKey,
      publicKey: importPub(unb64(msg.eph_key), "X25519"),
    });
    const key = Buffer.from(
      crypto.hkdfSync("sha256", shared, Buffer.concat([keys.nonceC, nonceD]), INFO, 32),
    );
    let sendCounter = 0;
    let recvCounter = 0;
    const session = {
      sendSealed(obj) {
        send(seal(key, sendCounter++, obj));
      },
      async next(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const frame = JSON.parse(await reader.next(deadline - Date.now()));
          if (frame.type !== "sealed") throw new Error("expected sealed frame");
          const plain = open(key, recvCounter++, frame.data);
          log(`frame ${plain.type}`);
          if (plain.type === "ping") {
            session.sendSealed({ type: "pong" });
            continue;
          }
          return plain;
        }
      },
      close() {
        sock.destroy();
      },
    };
    return { session };
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

// One handshake + task attempt. Returns { pairingRequired, code }
// when the agent demands pairing, or { sessionEnd } on a full run.
async function attempt(opts, keys) {
  const res = await attemptHandshake(opts, keys);
  if (res.pairingRequired) return res;
  const { session } = res;
  try {
    const taskFrame = { type: "task", id: crypto.randomUUID(), task: opts.task };
    session.sendSealed(taskFrame);
    log(`task sent id=${taskFrame.id} task="${opts.task}"`);
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    for (;;) {
      const plain = await session.next(deadline - Date.now());
      if (plain.type === "error") throw new Error(`agent error: ${plain.message}`);
      else if (plain.type === "session-end") {
        session.close();
        return { sessionEnd: plain };
      }
    }
  } catch (e) {
    session.close();
    throw e;
  }
}

// One handshake + frame-request attempt. Returns { pairingRequired,
// code } when the agent demands pairing, or { frame } with the
// reassembled PNG on success, or { refused, message } when the
// agent answers the request with an error (fail-closed: no frame).
async function attemptFrame(opts, keys) {
  const res = await attemptHandshake(opts, keys);
  if (res.pairingRequired) return res;
  const { session } = res;
  try {
    const id = crypto.randomUUID();
    session.sendSealed({ type: "frame-request", id });
    log(`frame-request sent id=${id}`);
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    const start = await session.next(deadline - Date.now());
    if (start.type === "error") {
      session.close();
      return { refused: true, message: start.message || "?" };
    }
    if (start.type !== "frame-start")
      throw new Error(
        `unexpected reply to frame-request: ${JSON.stringify(start).slice(0, 200)}`,
      );
    if (start.id !== id) throw new Error("frame-start id mismatch");
    const chunks = [];
    let expectSeq = 0;
    for (;;) {
      const plain = await session.next(deadline - Date.now());
      if (plain.type === "error") throw new Error(`agent error: ${plain.message}`);
      if (plain.type === "frame-end") {
        if (plain.id !== id) throw new Error("frame-end id mismatch");
        break;
      }
      if (plain.type !== "frame-chunk")
        throw new Error(`unexpected frame: ${plain.type}`);
      if (plain.id !== id) throw new Error("frame-chunk id mismatch");
      if (plain.seq !== expectSeq)
        throw new Error(`chunk seq ${plain.seq}, expected ${expectSeq}`);
      expectSeq++;
      const data = Buffer.from(plain.data, "base64");
      if (data.length > 16 * 1024)
        throw new Error(`chunk over the 16 KiB raw cap: ${data.length}`);
      chunks.push(data);
    }
    const png = Buffer.concat(chunks);
    if (png.length !== start.bytes)
      throw new Error(`frame byte count ${png.length}, expected ${start.bytes}`);
    const sha = crypto.createHash("sha256").update(png).digest("hex");
    if (sha !== start.sha256)
      throw new Error(`frame sha256 mismatch: got ${sha}, expected ${start.sha256}`);
    session.close();
    return {
      frame: { width: start.width, height: start.height, bytes: png, sha256: sha },
    };
  } catch (e) {
    session.close();
    throw e;
  }
}
function printSessionEnd(end) {
  const counts = ["allowed", "denied", "failed"].map((k) => end[k]);
  if (counts.some((c) => typeof c !== "number"))
    fail(`session-end missing counts: ${JSON.stringify(end).slice(0, 200)}`);
  log(`session-end allowed=${counts[0]} denied=${counts[1]} failed=${counts[2]}`);
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ed = crypto.generateKeyPairSync("ed25519");
  const eph = crypto.generateKeyPairSync("x25519");
  const keys = { ed, eph, nonceC: crypto.randomBytes(32) };
  log(`ready agent=${opts.host}:${opts.port} task="${opts.task}"`);
  const budget = opts.mode === "auto" ? AUTO_BUDGET_MS : SINGLE_BUDGET_MS;
  const deadline = Date.now() + budget;
  // Retry the TCP connect until the deadline — the agent appears only after the check enables it. Protocol violations fail fast.
  async function attemptWithConnectRetry() {
    for (;;) {
      try {
        return await attempt(opts, keys);
      } catch (e) {
        if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") {
          if (Date.now() >= deadline) throw e;
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw e;
      }
    }
  }
  if (opts.mode === "unpaired") {
    const res = await attemptWithConnectRetry();
    if (!res.pairingRequired) fail("expected pairing-required, got a full handshake");
    log(`pairing-required code=${res.code}`);
    return;
  }
  if (opts.mode === "paired") {
    const res = await attemptWithConnectRetry();
    if (res.pairingRequired) fail("expected a paired handshake, got pairing-required");
    printSessionEnd(res.sessionEnd);
    return;
  }
  if (opts.mode === "frame" || opts.mode === "frame-refused") {
    // Same pairing-retry loop as auto: the first attempt demands
    // pairing, the check approves it on the device, the next
    // attempt pairs and drives the frame request.
    const deadline = Date.now() + FRAME_BUDGET_MS;
    for (;;) {
      if (Date.now() >= deadline) fail("timed out waiting for pairing/frame");
      let res;
      try {
        res = await attemptFrame(opts, keys);
      } catch (e) {
        if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") {
          if (Date.now() >= deadline) throw e;
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw e;
      }
      if (res.pairingRequired) {
        log(`pairing-required code=${res.code}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (opts.mode === "frame-refused") {
        if (!res.refused) fail("expected a frame refusal, got a frame");
        log(`frame-refused ${res.message}`);
        return;
      }
      if (res.refused) fail(`expected a frame, got refusal: ${res.message}`);
      fs.writeFileSync(opts.out, res.frame.bytes);
      log(
        `frame bytes=${res.frame.bytes.length} sha256=${res.frame.sha256} ` +
          `width=${res.frame.width} height=${res.frame.height} out=${opts.out}`,
      );
      return;
    }
  }
  for (;;) {
    if (Date.now() >= deadline) fail("timed out waiting for pairing/task");
    const res = await attemptWithConnectRetry();
    if (res.pairingRequired) {
      log(`pairing-required code=${res.code}`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    printSessionEnd(res.sessionEnd);
    return;
  }
}
main().catch((e) => fail(e.message || String(e)));
