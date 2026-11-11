// SevynOS v2 M10 — RCS skeleton (STAGED, not a real RCS client).
//
// What this is: a minimal SIP + MSRP client that proves the client
// shapes exist — REGISTER (Digest auth), OPTIONS capability query,
// INVITE with an MSRP SDP offer, one MSRP SEND, BYE — against the
// local mock ACS/IMS (harness/mock-acs.js). It interoperates with
// NOTHING real, and every status string says so.
//
// Transport note: SIP here runs over TCP. Real IMS cores speak UDP,
// but this sandbox blocks UDP sends entirely (even loopback —
// `send EPERM`), so the mock and the probe both use TCP. The SIP
// messages are byte-identical either way; the transport is a one-line
// change, not a protocol difference.
//
// What it is NOT: a Universal Profile client. There is no usable
// open-source UP library, provisioning needs a carrier ACS/IMS per
// market (or a Google/Jibe relationship — carrier-only, no public
// onboarding), and a desktop-first OS has no SIM identity. Real RCS
// needs a carrier deal + a SIM-bearing mobile device — both outside
// M10, both Kevon's call (see M10_PLAN.md §8). Do NOT present this
// as "RCS works" and do NOT present business RCS APIs (RBM) as a
// consumer path — they are application-to-person only.

import net from "node:net";
import { createHash } from "node:crypto";

export function rcsStatus() {
  return {
    staged: true,
    state: "no carrier backend",
    detail:
      "RCS is staged in M10: SIP/MSRP skeleton only, proven against a local mock ACS. " +
      "Real RCS needs a carrier relationship and a SIM-bearing mobile device (Kevon's call).",
  };
}

function md5(s) {
  return createHash("md5").update(s).digest("hex");
}

// Minimal SIP client over TCP. `user` is the SIP user (e.g. alice);
// the mock ACS accepts password "testpass", realm "test.local".
export async function rcsProbe({ host = "127.0.0.1", port = 5060, user = "alice" } = {}) {
  const result = {
    register: false,
    options: false,
    invite: false,
    msrp: false,
    bye: false,
  };
  const callId = `sevyn-${Math.random().toString(36).slice(2, 10)}`;
  let cseq = 1;

  const sock = net.connect(port, host);
  await new Promise((resolve, reject) => {
    sock.on("connect", resolve);
    sock.on("error", reject);
  });
  let buf = "";
  const waiters = new Map(); // cseq -> { resolve, reject, timer }
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    // Drain complete SIP messages (headers + Content-Length body).
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = buf.slice(0, headEnd);
      const lenMatch = head.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = lenMatch ? Number(lenMatch[1]) : 0;
      const total = headEnd + 4 + bodyLen;
      if (buf.length < total) return;
      const msg = buf.slice(0, total);
      buf = buf.slice(total);
      const cseqMatch = msg.match(/CSeq:\s*(\d+)/i);
      if (!cseqMatch) continue;
      const key = Number(cseqMatch[1]);
      const w = waiters.get(key);
      if (!w) continue;
      waiters.delete(key);
      clearTimeout(w.timer);
      const code = Number((msg.match(/^SIP\/2\.0 (\d+)/) || [])[1] || 0);
      w.resolve({ code, text: msg });
    }
  });

  function sendSip(method, uri, extraHeaders = "", body = "") {
    const n = cseq++;
    const req = [
      `${method} ${uri} SIP/2.0`,
      `Via: SIP/2.0/TCP 127.0.0.1;branch=z9hG4bK${n}`,
      `From: <sip:${user}@test.local>;tag=sevyn${n}`,
      `To: <sip:${user}@test.local>`,
      `Call-ID: ${callId}@sevyn`,
      `CSeq: ${n} ${method}`,
      `Contact: <sip:${user}@127.0.0.1>`,
      `Max-Forwards: 70`,
      ...extraHeaders.split("\n").filter(Boolean),
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(n);
        reject(new Error(`${method} timed out (no reply from ${host}:${port})`));
      }, 5000);
      waiters.set(n, { resolve, timer });
      sock.write(req, (err) => {
        if (err) {
          clearTimeout(timer);
          waiters.delete(n);
          reject(err);
        }
      });
    });
  }

  try {
    // 1. REGISTER — the mock challenges with 401 Digest; retry with it.
    let res = await sendSip("REGISTER", "sip:test.local");
    if (res.code === 401) {
      const realm = (res.text.match(/realm="([^"]+)"/) || [])[1] || "test.local";
      const nonce = (res.text.match(/nonce="([^"]+)"/) || [])[1] || "";
      const ha1 = md5(`${user}:${realm}:testpass`);
      const ha2 = md5(`REGISTER:sip:test.local`);
      const response = md5(`${ha1}:${nonce}:${ha2}`);
      res = await sendSip(
        "REGISTER",
        "sip:test.local",
        `Authorization: Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="sip:test.local", response="${response}", algorithm=MD5`,
      );
    }
    result.register = res.code === 200;
    if (!result.register) throw new Error(`REGISTER failed: ${res.code}`);

    // 2. OPTIONS — capability query.
    res = await sendSip("OPTIONS", "sip:test.local");
    result.options = res.code === 200;
    if (!result.options) throw new Error(`OPTIONS failed: ${res.code}`);

    // 3. INVITE with an MSRP SDP offer; the mock's 200 OK carries the
    //    MSRP path (host:port/session) to connect to.
    const sdp = [
      "v=0",
      `o=sevyn 0 0 IN IP4 127.0.0.1`,
      "s=SevynOS RCS",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      "m=message 0 TCP/MSRP *",
      "a=path:msrp://127.0.0.1:0/sevyn;tcp",
      "a=accept-types:text/plain",
      "",
    ].join("\r\n");
    res = await sendSip("INVITE", "sip:test.local", "Content-Type: application/sdp", sdp);
    result.invite = res.code === 200;
    if (!result.invite) throw new Error(`INVITE failed: ${res.code}`);
    const pathMatch = res.text.match(/a=path:msrp:\/\/([^:/]+):(\d+)\/([^;\s]+);tcp/);
    if (!pathMatch) throw new Error("INVITE 200 OK carried no MSRP path");
    const [, msrpHost, msrpPort, session] = pathMatch;

    // 4. MSRP SEND over TCP to the negotiated path.
    const txn = Math.random().toString(36).slice(2, 10);
    const body = "hello from SevynOS (RCS skeleton probe)";
    const msrpMsg = [
      `MSRP ${txn} SEND`,
      `To-Path: msrp://${msrpHost}:${msrpPort}/${session};tcp`,
      `From-Path: msrp://127.0.0.1/sevyn;tcp`,
      `Message-ID: ${txn}`,
      `Byte-Range: 1-${Buffer.byteLength(body)}/${Buffer.byteLength(body)}`,
      "Content-Type: text/plain",
      "",
      body,
      `-------${txn}$`,
      "",
    ].join("\r\n");
    const msrpRes = await new Promise((resolve, reject) => {
      const client = net.connect(Number(msrpPort), msrpHost, () => client.write(msrpMsg));
      let mbuf = "";
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error("MSRP SEND timed out"));
      }, 5000);
      client.on("data", (d) => {
        mbuf += d.toString("utf8");
        if (/^MSRP \S+ 200 OK/m.test(mbuf)) {
          clearTimeout(timer);
          client.end();
          resolve(mbuf);
        }
      });
      client.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    result.msrp = /^MSRP \S+ 200 OK/m.test(msrpRes);

    // 5. BYE — end the session cleanly.
    res = await sendSip("BYE", "sip:test.local");
    result.bye = res.code === 200;
    return { ...result, ok: Object.values(result).every(Boolean) };
  } finally {
    for (const { timer } of waiters.values()) clearTimeout(timer);
    waiters.clear();
    sock.destroy();
  }
}
