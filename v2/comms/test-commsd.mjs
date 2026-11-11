// SevynOS v2 M10 — host-side commsd test (the m10-check step-0 gate).
//
// Spawns the mock Matrix homeserver + mock ACS, then two commsd
// instances (alice + bob) and drives them over their control sockets:
//   login -> rooms -> plain send/receive -> encrypted send/receive
//   -> video call signaling (invite/answer/hangup) -> RCS probe.
// With SEVYN_M10_CHROME=<chromium binary> (+ the bridge page next to
// it), the call phase also runs with the real Chromium bridge and
// asserts media actually flows (both sides framesReceived > 0);
// without it, the null bridge proves signaling only and media stays
// "none" — never faked.
//
// Usage: node test-commsd.mjs
// Exit 0 = full pass. Prints PASS/FAIL per assertion.

import { spawn, execSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.SEVYN_M10_CHROME || "";
const BRIDGE_PAGE = path.join(HERE, "bridge.html");
const TMP = process.env.SEVYN_M10_TMP || "/tmp/sevyn-m10-test";
const MATRIX_PORT = 7071;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// The sandbox blocks UDP sends entirely (even loopback — `send
// EPERM`), which kills WebRTC ICE (STUN checks never leave). The
// guest and the KVM box do not have this restriction, so the media
// loopback is proven in-guest by m10-check; the host test detects
// the block here and skips the frames assertion instead of failing
// on an environment limit.
async function udpBlocked() {
  const dgram = await import("node:dgram");
  return new Promise((resolve) => {
    const server = dgram.createSocket("udp4");
    server.on("error", () => resolve(true));
    server.bind(0, "127.0.0.1", () => {
      const port = server.address().port;
      const client = dgram.createSocket("udp4");
      client.send("ping", port, "127.0.0.1", (err) => {
        client.close();
        server.close();
        resolve(!!err);
      });
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(true);
    }, 3000).unref?.();
  });
}

function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => {
        s.end();
        resolve();
      });
      s.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function startProc(cmd, args, env = {}) {
  const proc = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  proc.stdout.on("data", (d) =>
    process.stdout.write(`[${args[0]?.split("/").pop() || cmd}] ${d}`),
  );
  proc.stderr.on("data", (d) =>
    process.stderr.write(`[${args[0]?.split("/").pop() || cmd} err] ${d}`),
  );
  return proc;
}

// One control-socket client: send a line, await one reply line.
class Commsd {
  constructor(sockPath) {
    this.sockPath = sockPath;
    this.buf = "";
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.sockPath);
      this.socket.on("connect", resolve);
      this.socket.on("error", reject);
      this.socket.on("data", (d) => {
        this.buf += d.toString("utf8");
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          const w = this.waiters.shift();
          if (w) w(line);
        }
      });
    });
  }
  cmd(line) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for reply to ${line}`)),
        20000,
      );
      this.waiters.push((l) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(l));
        } catch (e) {
          reject(new Error(`bad reply to ${line}: ${l}`));
        }
      });
      this.socket.write(`${line}\n`);
    });
  }
  close() {
    try {
      this.socket.end();
    } catch {
      /* already closed */
    }
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  const procs = [];
  const killAll = () => {
    for (const p of procs) {
      try {
        p.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Belt and braces: the bridge kills its Chromium group on close,
    // but a hard-killed daemon can still orphan one. Only the
    // bridge's headless instances match (remote-debugging-port=9xxx).
    try {
      execSync('pkill -f "remote-debugging-port=9" 2>/dev/null || true', {
        stdio: "ignore",
      });
    } catch {
      /* no chromes to kill */
    }
  };
  process.on("SIGINT", () => {
    killAll();
    process.exit(130);
  });

  // Mock homeserver + mock ACS. Everything below is inside the
  // outer try/finally so a startup failure still kills the mocks
  // (a previous run leaked a mock-acs UDP socket this way).
  try {
    procs.push(
      startProc("node", [path.join(HERE, "harness/mock-matrix.js")], { MOCK_LOG: "0" }),
    );
    procs.push(
      startProc("node", [path.join(HERE, "harness/mock-acs.js")], { MOCK_LOG: "0" }),
    );
    await waitForPort(MATRIX_PORT);
    await waitForPort(5060); // SIP (TCP) + MSRP 5061, both bound by mock-acs
    console.log("mocks up");

    const bridge = CHROME ? "chromium" : "null";
    console.log(`bridge mode: ${bridge}${CHROME ? ` (${CHROME})` : ""}`);

    async function spawnDaemon(name) {
      const data = path.join(TMP, name);
      const sock = path.join(TMP, `${name}.sock`);
      const args = [
        path.join(HERE, "commsd.mjs"),
        "--data",
        data,
        "--socket",
        sock,
        "--mock-matrix",
        `http://127.0.0.1:${MATRIX_PORT}`,
        "--bridge",
        bridge,
      ];
      if (CHROME)
        args.push("--chrome", CHROME, "--bridge-page", BRIDGE_PAGE, "--fake-media", "1");
      const proc = startProc("node", args);
      procs.push(proc);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          await fs.access(sock);
          break;
        } catch {
          await sleep(200);
        }
      }
      const c = new Commsd(sock);
      await c.connect();
      return { proc, c };
    }

    const alice = await spawnDaemon("alice");
    const bob = await spawnDaemon("bob");

    try {
      // -- login ------------------------------------------------------------
      let r = await alice.c.cmd("STATUS");
      check("alice starts logged out", r.ok && r.loggedIn === false);
      r = await alice.c.cmd("LOGIN @alice:test.local testpass");
      check("alice login", r.ok && r.userId === "@alice:test.local", JSON.stringify(r));
      r = await bob.c.cmd("LOGIN @bob:test.local testpass");
      check("bob login", r.ok && r.userId === "@bob:test.local", JSON.stringify(r));

      // -- rooms ------------------------------------------------------------
      await sleep(2000); // let the initial sync land
      r = await alice.c.cmd("ROOMS");
      check(
        "alice sees 3 rooms",
        r.ok && r.rooms.length === 3,
        r.ok ? r.rooms.map((x) => x.roomId).join(",") : JSON.stringify(r),
      );
      const enc = r.rooms.find((x) => x.roomId === "!dm-enc:test.local");
      check("encrypted room flagged", !!enc && enc.encrypted === true);

      // -- plain message ------------------------------------------------------
      r = await alice.c.cmd("SEND !dm-plain:test.local hello from alice");
      check("alice sends plain", r.ok && !!r.eventId, JSON.stringify(r));
      const plain = await waitFor(
        async () => {
          const m = await bob.c.cmd("MESSAGES !dm-plain:test.local 10");
          return m.ok ? m.messages.find((x) => x.body === "hello from alice") : null;
        },
        10000,
        "bob to receive plain message",
      );
      check("bob receives plain message", !!plain, JSON.stringify(plain));

      // -- encrypted message --------------------------------------------------
      r = await alice.c.cmd("SEND !dm-enc:test.local secret hello");
      check("alice sends encrypted", r.ok && !!r.eventId, JSON.stringify(r));
      const secret = await waitFor(
        async () => {
          const m = await bob.c.cmd("MESSAGES !dm-enc:test.local 10");
          return m.ok
            ? m.messages.find(
                (x) => x.body === "secret hello" && x.encrypted && x.decrypted,
              )
            : null;
        },
        20000,
        "bob to receive + decrypt the secret",
      );
      check(
        "bob receives + decrypts encrypted message",
        !!secret,
        JSON.stringify(secret),
      );

      // -- video call signaling ----------------------------------------------
      // The daemon pre-warms its bridge at start, but a first call
      // that lands mid-warmup fails fast with "media engine still
      // starting" (the host's 10 s exec timeout forbids hanging for
      // a cold Chromium) — retry once after the warmup lands.
      r = await alice.c.cmd("CALL !call:test.local --video");
      if (!r.ok && String(r.error || "").includes("still starting")) {
        await sleep(8000);
        r = await alice.c.cmd("CALL !call:test.local --video");
      }
      check("alice calls (video)", r.ok && r.state === "ringing", JSON.stringify(r));
      const callId = r.callId;
      const incoming = await waitFor(
        async () => {
          const c = await bob.c.cmd("CALLS");
          return c.ok
            ? c.calls.find((x) => x.callId === callId && x.state === "incoming")
            : null;
        },
        10000,
        "bob to see the incoming call",
      );
      check("bob sees incoming video call", !!incoming, JSON.stringify(incoming));
      r = await bob.c.cmd(`ANSWER ${callId}`);
      check("bob answers", r.ok && r.state === "connected", JSON.stringify(r));
      const aliceConnected = await waitFor(
        async () => {
          const c = await alice.c.cmd("CALLS");
          return c.ok
            ? c.calls.find((x) => x.callId === callId && x.state === "connected")
            : null;
        },
        10000,
        "alice to see connected",
      );
      check("alice sees connected", !!aliceConnected, JSON.stringify(aliceConnected));

      if (bridge === "chromium") {
        // Real media: both bridges must report frames flowing — unless
        // this environment blocks UDP (the sandbox does), in which
        // case ICE can never connect here and the media gate is the
        // in-guest m10-check. The bridge still proves SDP + candidate
        // exchange; only the frames assertion is skipped.
        const noUdp = await udpBlocked();
        if (noUdp) {
          console.log(
            "SKIP media frames assertion — this environment blocks UDP sends (sandbox); media is proven in-guest by m10-check",
          );
          const a = await alice.c.cmd("CALLS");
          const ac = a.ok ? a.calls.find((x) => x.callId === callId) : null;
          check(
            "chromium bridge drives SDP + candidates (signaling connected)",
            ac?.state === "connected",
            `state=${ac?.state} media=${ac?.media}`,
          );
          // The candidate exchange itself IS provable without UDP:
          // both bridges must see the peer's candidates and form
          // pairs (ICE "checking"), or the answerer's PC never got
          // them — the exact bug that left ICE at "new" in-guest.
          // Frames still need UDP, so they stay in-guest-only.
          const ice = await waitFor(
            async () => {
              const aa = await alice.c.cmd("CALLS");
              const bb = await bob.c.cmd("CALLS");
              const a2 = aa.ok ? aa.calls.find((x) => x.callId === callId) : null;
              const b2 = bb.ok ? bb.calls.find((x) => x.callId === callId) : null;
              const ok2 =
                a2?.ice?.remoteCandidates > 0 &&
                a2?.ice?.pairs > 0 &&
                b2?.ice?.remoteCandidates > 0 &&
                b2?.ice?.pairs > 0;
              return ok2 ? { a2, b2 } : null;
            },
            // 30 s, not 15: under a 2-core constraint the answerer's
            // drain + Chrome's candidate processing lag past 15 s
            // (reproduced with taskset -c 0,1). This branch only
            // runs where UDP is blocked (the sandbox); CI takes the
            // frames branch below.
            30000,
            "both bridges to see remote candidates + pairs",
          );
          check(
            "ICE pairs form both ways (candidates exchanged, incl. answerer's queued batch)",
            !!ice,
            ice
              ? `alice remote=${ice.a2.ice.remoteCandidates} pairs=${ice.a2.ice.pairs}; bob remote=${ice.b2.ice.remoteCandidates} pairs=${ice.b2.ice.pairs}`
              : "a side still shows 0 remote candidates / 0 pairs",
          );
        } else {
          const media = await waitFor(
            async () => {
              const a = await alice.c.cmd("CALLS");
              const b = await bob.c.cmd("CALLS");
              const ac = a.ok ? a.calls.find((x) => x.callId === callId) : null;
              const bc = b.ok ? b.calls.find((x) => x.callId === callId) : null;
              return ac?.media === "connected" && bc?.media === "connected"
                ? { ac, bc }
                : null;
            },
            // 180 s, not 60: a cold Chromium (first launch on the box,
            // right after an image build) needs the headroom — the
            // 2026-11-10 KVM run tripped the 30 s limit under load
            // while both bridges were still gathering — and CI's
            // 2-vCPU runner tripped the 60 s limit the same way
            // (PR #101 round 1: the frames wait timed out at 60 s
            // while media was still setting up). The box proves the
            // same code flows frames in ~20 s; this is a harness
            // timeout for slow hosts, not a product change. A call
            // that is genuinely stuck still times out — just later.
            180000,
            "both bridges to report media connected (frames flowing)",
          );
          check(
            "media flows both ways (framesReceived > 0)",
            !!media,
            media ? `alice=${media.ac.media} bob=${media.bc.media}` : "never connected",
          );
        }
      } else {
        const a = await alice.c.cmd("CALLS");
        const ac = a.ok ? a.calls.find((x) => x.callId === callId) : null;
        check(
          "null bridge reports media none (not faked)",
          ac?.media === "none",
          `media=${ac?.media}`,
        );
      }

      r = await alice.c.cmd(`HANGUP ${callId}`);
      check("alice hangs up", r.ok && r.state === "ended", JSON.stringify(r));
      const bobEnded = await waitFor(
        async () => {
          const c = await bob.c.cmd("CALLS");
          return c.ok
            ? c.calls.find((x) => x.callId === callId && x.state === "ended")
            : null;
        },
        10000,
        "bob to see ended",
      );
      check("bob sees ended", !!bobEnded, JSON.stringify(bobEnded));

      // -- call by user id (the app's call screen sends a user id) -----
      // The DM lookup must find the 2-member DM room — and the invite
      // must ring even when that room is the ENCRYPTED one (the
      // Decrypted listener routes the decrypted invite to the call
      // state machine; without it, encrypted-room invites are dropped
      // as ciphertext at Timeline time).
      r = await alice.c.cmd("CALL @bob:test.local --audio");
      check(
        "alice calls by user id (audio)",
        r.ok &&
          r.state === "ringing" &&
          (r.roomId === "!dm-plain:test.local" || r.roomId === "!dm-enc:test.local"),
        JSON.stringify(r),
      );
      const callId2 = r.callId;
      const incoming2 = await waitFor(
        async () => {
          const c = await bob.c.cmd("CALLS");
          return c.ok
            ? c.calls.find((x) => x.callId === callId2 && x.state === "incoming")
            : null;
        },
        15000,
        "bob to see the user-targeted incoming call",
      );
      check(
        "bob sees incoming audio call (user-targeted)",
        !!incoming2,
        JSON.stringify(incoming2),
      );
      r = await bob.c.cmd(`ANSWER ${callId2}`);
      check(
        "bob answers the audio call",
        r.ok && r.state === "connected",
        JSON.stringify(r),
      );
      r = await alice.c.cmd(`HANGUP ${callId2}`);
      check(
        "alice hangs up the audio call",
        r.ok && r.state === "ended",
        JSON.stringify(r),
      );

      // -- call in the ENCRYPTED room ---------------------------------------
      // The invite is Megolm-encrypted; bob's Timeline sees ciphertext
      // (ignored) and the Decrypted listener must route the decrypted
      // invite to the call state machine — without it this never rings.
      r = await alice.c.cmd("CALL !dm-enc:test.local --video");
      check(
        "alice calls in the encrypted room",
        r.ok && r.state === "ringing",
        JSON.stringify(r),
      );
      const callId3 = r.callId;
      const incoming3 = await waitFor(
        async () => {
          const c = await bob.c.cmd("CALLS");
          return c.ok
            ? c.calls.find((x) => x.callId === callId3 && x.state === "incoming")
            : null;
        },
        15000,
        "bob to see the encrypted-room incoming call",
      );
      check(
        "bob sees incoming call from the encrypted room",
        !!incoming3,
        JSON.stringify(incoming3),
      );
      r = await bob.c.cmd(`ANSWER ${callId3}`);
      check(
        "bob answers the encrypted-room call",
        r.ok && r.state === "connected",
        JSON.stringify(r),
      );
      r = await alice.c.cmd(`HANGUP ${callId3}`);
      check(
        "alice hangs up the encrypted-room call",
        r.ok && r.state === "ended",
        JSON.stringify(r),
      );

      // -- RCS skeleton ---------------------------------------------------------
      r = await alice.c.cmd("RCS STATUS");
      check(
        "RCS reports staged",
        r.ok && r.staged === true && r.state === "no carrier backend",
        JSON.stringify(r),
      );
      r = await alice.c.cmd("RCS PROBE");
      check(
        "RCS probe: REGISTER + OPTIONS + INVITE + MSRP + BYE vs mock ACS",
        r.ok &&
          r.probe &&
          r.probe.register &&
          r.probe.options &&
          r.probe.invite &&
          r.probe.msrp &&
          r.probe.bye,
        JSON.stringify(r.probe || r),
      );

      // -- logout ---------------------------------------------------------------
      r = await alice.c.cmd("LOGOUT");
      check("alice logout", r.ok === true);
      r = await alice.c.cmd("STATUS");
      check("alice logged out after logout", r.ok && r.loggedIn === false);
    } finally {
      try {
        await alice.c.cmd("SHUTDOWN");
      } catch {
        /* already gone */
      }
      try {
        await bob.c.cmd("SHUTDOWN");
      } catch {
        /* already gone */
      }
      alice.c.close();
      bob.c.close();
      await sleep(500);
      killAll();
    }

    console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    killAll();
  }
}

main().catch((e) => {
  console.error(`TEST HARNESS ERROR: ${e?.stack || e}`);
  process.exit(2);
});
