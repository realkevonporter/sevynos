// SevynOS v2 M10 — mock ACS/IMS (test double, never a system service).
//
// A minimal SIP server (TCP) + MSRP endpoint (TCP) for the RCS
// skeleton probe (rcs.mjs). It accepts the shapes a real IMS core
// would see — REGISTER with Digest auth, OPTIONS, INVITE with an
// MSRP SDP offer (answered with an MSRP path), MSRP SEND (200 OK),
// BYE — and nothing more. It is not an IMS core and interoperates
// with nothing real.
//
// Transport note: SIP over TCP, not UDP — this sandbox blocks UDP
// sends entirely (even loopback), so the mock and the probe both use
// TCP. The SIP messages are byte-identical either way.
//
// Started ONLY with sevyn.mockcomms=1 (same pattern as mock-matrix).
// Listens on loopback only. Logs `MOCK {...}` lines for the harness.
//
// Usage: node mock-acs.js [--sip-port 5060] [--msrp-port 5061]
//   Env: MOCK_ACS_SIP_PORT (default 5060), MOCK_ACS_MSRP_PORT (5061),
//        MOCK_LOG=1.

import net from "node:net";
import { createHash } from "node:crypto";

const SIP_PORT = Number(process.env.MOCK_ACS_SIP_PORT || 5060);
const MSRP_PORT = Number(process.env.MOCK_ACS_MSRP_PORT || 5061);
const LOG = process.env.MOCK_LOG === "1";
const REALM = "test.local";
const NONCE = "mocknonce123";
const PASSWORD = "testpass";

function log(kind, method, path, extra) {
  if (!LOG) return;
  const line = { kind, method, path };
  if (extra !== undefined) line.extra = extra;
  console.log(`MOCK ${JSON.stringify(line)}`);
}

function md5(s) {
  return createHash("md5").update(s).digest("hex");
}

const registered = new Set(); // user@host

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split("\r\n").slice(1)) {
    if (!line) break;
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function sipResponse(code, reason, req, extraHeaders = "", body = "") {
  const h = parseHeaders(req);
  const lines = [
    `SIP/2.0 ${code} ${reason}`,
    `Via: ${h.via || ""}`,
    `From: ${h.from || ""}`,
    `To: ${h.to || ""}`,
    `Call-ID: ${h["call-id"] || ""}`,
    `CSeq: ${h.cseq || ""}`,
    `Contact: <sip:acs@test.local>`,
    ...extraHeaders.split("\n").filter(Boolean),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ];
  return lines.join("\r\n");
}

function handleSipRequest(socket, text) {
  const firstLine = text.split("\r\n")[0] || "";
  const [method, uri] = firstLine.split(" ");
  log("sip", method, uri);
  const h = parseHeaders(text);
  const user = (h.from || "").match(/sip:([^@>]+)/)?.[1] || "alice";
  let res;
  if (method === "REGISTER") {
    const auth = h.authorization || "";
    const m = auth.match(/response="([^"]+)"/);
    const expected = md5(
      `${md5(`${user}:${REALM}:${PASSWORD}`)}:${NONCE}:${md5(`REGISTER:${uri}`)}`,
    );
    if (!m || m[1] !== expected) {
      res = sipResponse(
        401,
        "Unauthorized",
        text,
        `WWW-Authenticate: Digest realm="${REALM}", nonce="${NONCE}", algorithm=MD5`,
      );
    } else {
      registered.add(user);
      res = sipResponse(200, "OK", text);
    }
  } else if (method === "OPTIONS") {
    res = sipResponse(
      200,
      "OK",
      text,
      "Allow: INVITE, ACK, BYE, OPTIONS, REGISTER\r\nAccept: application/sdp",
    );
  } else if (method === "INVITE") {
    if (!registered.has(user)) {
      res = sipResponse(403, "Forbidden", text);
    } else {
      const sdp = [
        "v=0",
        "o=acs 0 0 IN IP4 127.0.0.1",
        "s=SevynOS mock ACS",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        "m=message 0 TCP/MSRP *",
        `a=path:msrp://127.0.0.1:${MSRP_PORT}/mocksession;tcp`,
        "a=accept-types:text/plain",
        "",
      ].join("\r\n");
      res = sipResponse(200, "OK", text, "Content-Type: application/sdp", sdp);
    }
  } else if (method === "BYE" || method === "ACK") {
    res = sipResponse(200, "OK", text);
  } else {
    res = sipResponse(405, "Method Not Allowed", text);
  }
  socket.write(res);
}

const sip = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString("utf8");
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
      handleSipRequest(socket, msg);
    }
  });
  socket.on("error", () => {});
});
sip.listen(SIP_PORT, "127.0.0.1", () => {
  console.log(`mock-acs SIP listening on 127.0.0.1:${SIP_PORT}`);
});

// MSRP: one TCP listener; each connection reads a SEND and replies 200 OK.
const msrp = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    const m = buf.match(/^MSRP (\S+) SEND\r\n([\s\S]*?)\r\n-------\1\$/m);
    if (!m) return;
    const [, txn, headers] = m;
    const toPath = (headers.match(/To-Path:\s*(\S+)/) || [])[1] || "";
    const fromPath = (headers.match(/From-Path:\s*(\S+)/) || [])[1] || "";
    const bodyMatch = headers.match(/Message-ID:\s*(\S+)/);
    log("msrp", "SEND", toPath, bodyMatch ? bodyMatch[1] : "");
    const resp = [
      `MSRP ${txn} 200 OK`,
      `To-Path: ${fromPath}`,
      `From-Path: ${toPath}`,
      "Byte-Range: 1-0/0",
      "",
      `-------${txn}$`,
      "",
    ].join("\r\n");
    socket.write(resp);
  });
  socket.on("error", () => {});
});
msrp.listen(MSRP_PORT, "127.0.0.1", () => {
  console.log(`mock-acs MSRP listening on 127.0.0.1:${MSRP_PORT}`);
});
