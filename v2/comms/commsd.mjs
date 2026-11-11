// SevynOS v2 M10 — commsd: the Matrix comms daemon.
//
// The Matrix client lives here, not in the RN apps, because the host
// embeds Hermes 0.13 (no WebAssembly, no WebCrypto) and the current
// matrix-js-sdk crypto is Rust-only (WASM). Node has both, so the
// daemon runs the SDK with real E2EE (Olm/Megolm) and the apps stay
// thin UI over the `sevyn comms` CLI.
//
//   Matrix: login / sync / rooms / send / receive (plain + encrypted),
//           1:1 call signaling (legacy m.call.* P2P VoIP — see the M10
//           plan; Element X speaks MatrixRTC only, so calls are
//           SevynOS<->SevynOS and SevynOS<->Element Web/Desktop).
//   Media:  the daemon does NOT own a PeerConnection (Node has none).
//           The SDP comes from the media bridge (bridge.mjs): Chromium
//           over CDP in production, a null bridge (valid SDP, no media)
//           when no Chromium is present. The daemon's call state is the
//           SIGNALING state; media state is reported separately and
//           never faked.
//   RCS:    staged skeleton only (rcs.mjs) — no carrier backend.
//
// Protocol: aid-style line protocol over a unix socket (default
// /run/sevyn-comms.sock). One line in, one line out:
//   STATUS | LOGIN <user> <password> [homeserver] | LOGOUT | ROOMS |
//   MESSAGES <roomId> [limit] | SEND <roomId> <text...> |
//   CALL <roomId|userId> [--video|--audio] | ANSWER <callId> |
//   HANGUP <callId> | CALLS | RCS STATUS | SHUTDOWN
// Replies: one bare JSON line, `{ok:true, ...}` or `{ok:false, error}`
// (the CLI prints it verbatim and exits 1 on ok:false).
// The account (token + device) lives in <data>/account.json (0600).
//
// Known limit (documented in M10_PLAN.md): the crypto store is
// in-memory (the SDK's IndexedDB store does not exist in Node), so
// the daemon's Olm identity regenerates on every restart — the daemon
// re-uploads keys on start and peers see a new device until it is
// re-verified. A durable SQLite crypto store is follow-up work.

import * as sdk from "matrix-js-sdk";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ChromiumBridge, NullBridge } from "./bridge.mjs";
import { rcsStatus, rcsProbe } from "./rcs.mjs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const DATA_DIR = arg("--data", "/data/comms");
const SOCK_PATH = arg("--socket", "/run/sevyn-comms.sock");
const HOMESERVER = arg("--homeserver", "https://matrix.org");
const MOCK_MATRIX = arg("--mock-matrix", "");
const BRIDGE_MODE = arg("--bridge", "null"); // "chromium" | "null"
const CHROME_BIN = arg("--chrome", "");
// Fake media (synthetic camera/mic) is the safe default — the check
// runs headless with no devices. Real hardware passes --fake-media 0
// (init does this whenever sevyn.mockcomms is NOT set), so the
// bridge uses the real camera/mic; a device without one still
// signals, receive-only (bridge.html degrades on getUserMedia fail).
const FAKE_MEDIA = arg("--fake-media", "1") !== "0";
const BRIDGE_PAGE = arg("--bridge-page", "");
const ACS_HOST = arg("--acs-host", "127.0.0.1");
const ACS_PORT = Number(arg("--acs-port", "5060"));
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");

function log(obj) {
  console.log(`COMMS ${JSON.stringify(obj)}`);
}

function b64(n) {
  return Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)))
    .toString("base64")
    .replace(/[+/=]/g, "");
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Matrix client lifecycle
// ---------------------------------------------------------------------------
let client = null;
let account = null; // { homeserver, userId, deviceId, accessToken }
let starting = false;

async function loadAccount() {
  try {
    const raw = await fs.readFile(ACCOUNT_FILE, "utf8");
    account = JSON.parse(raw);
    return account;
  } catch {
    return null;
  }
}

async function saveAccount(acc) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(ACCOUNT_FILE, JSON.stringify(acc), { mode: 0o600 });
}

async function startMatrix(acc) {
  if (client) return client;
  starting = true;
  const c = sdk.createClient({
    baseUrl: acc.homeserver,
    userId: acc.userId,
    deviceId: acc.deviceId,
    accessToken: acc.accessToken,
    store: new sdk.MemoryStore(),
  });
  await c.initRustCrypto({ useIndexedDB: false });
  c.on(sdk.RoomEvent.Timeline, (ev, room) => onTimeline(ev, room));
  // Calls in encrypted rooms: an m.call.* sent into an encrypted
  // room arrives as ciphertext at Timeline time (getType() is
  // m.room.encrypted, so onTimeline ignores it); when the SDK
  // finishes decrypting it, Event.decrypted fires with the real
  // type and content. Route those through the same handler —
  // without this, calls in encrypted DMs (the matrix.org default)
  // would never ring. (Messages don't need this: they are resolved
  // lazily at MESSAGES time, after decryption has completed.)
  c.on(sdk.ClientEvent.Sync, (state, _prev, data) => {
    if (state === sdk.SyncState.Error) {
      log({
        kind: "sync-error",
        error: String(data?.error?.message || data?.error || "sync error"),
      });
    }
  });
  c.on(sdk.MatrixEventEvent.Decrypted, (ev) => {
    const room = ev.getRoomId() ? c.getRoom(ev.getRoomId()) : null;
    if (room) onTimeline(ev, room);
  });
  await c.startClient({ initialSyncLimit: 20 });
  client = c;
  account = acc;
  starting = false;
  log({
    kind: "started",
    user: acc.userId,
    homeserver: acc.homeserver,
    device: acc.deviceId,
  });
  return c;
}

async function stopMatrix() {
  if (client) {
    try {
      await client.stopClient();
    } catch {
      /* already stopped */
    }
    client = null;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function resolveMessage(ev) {
  const type = ev.getWireType();
  const encrypted = type === "m.room.encrypted";
  const failed = ev.isDecryptionFailure();
  let body = null;
  if (!encrypted) {
    const content = ev.getContent();
    if (type === "m.room.message") body = content.body ?? null;
    else if (type === "m.room.member") body = null;
    else body = null;
  } else if (!failed) {
    const content = ev.getContent();
    if (content && content.msgtype === "m.text") body = content.body ?? null;
    else if (content && content.body) body = content.body;
  }
  return {
    eventId: ev.getId(),
    sender: ev.getSender(),
    type: encrypted ? "m.room.message" : type,
    encrypted,
    decrypted: encrypted ? !failed && body !== null : true,
    body,
    ts: ev.getTs(),
  };
}

function roomInfo(room) {
  const members = room.getJoinedMembers().map((m) => m.userId);
  const timeline = room.getLiveTimeline().getEvents();
  const last = timeline.length ? resolveMessage(timeline[timeline.length - 1]) : null;
  return {
    roomId: room.roomId,
    name: room.name || room.roomId,
    encrypted: room.hasEncryptionStateEvent(),
    members,
    lastMessage:
      last && last.body ? { sender: last.sender, body: last.body, ts: last.ts } : null,
  };
}

// ---------------------------------------------------------------------------
// Calls — legacy m.call.* signaling; SDP comes from the bridge.
// ---------------------------------------------------------------------------
const calls = new Map(); // callId -> call
let bridge = null;

function getBridge() {
  if (bridge) return bridge;
  if (BRIDGE_MODE === "chromium") {
    bridge = new ChromiumBridge({
      chromeBin: CHROME_BIN,
      page: BRIDGE_PAGE,
      fakeMedia: FAKE_MEDIA,
    });
  } else {
    bridge = new NullBridge();
  }
  return bridge;
}

function newCallId() {
  return `sevyn-${b64(9)}`;
}

function callView(c) {
  return {
    callId: c.callId,
    roomId: c.roomId,
    peer: c.peer,
    video: c.video,
    direction: c.direction,
    state: c.state,
    media: c.media,
    // Raw bridge stats (connectionState, framesReceived, candidate
    // counts) so a caller can tell ICE "checking with pairs" apart
    // from "new with zero remote candidates" — the app ignores this
    // field; the host test asserts on it where UDP is blocked and
    // frames can never flow.
    ice: c.rawMedia || null,
  };
}

// Media state is polled in the BACKGROUND and served from a cache,
// never awaited on a verb. The old shape awaited getStats (via
// refreshMediaState + rawMediaState) inside refreshCallsMedia, which
// the STATUS and CALLS verbs await — under TCG a single pc.getStats()
// takes tens of seconds, so the verb exceeded the host's 10 s exec
// timeout, the calling app got nothing, and the in-guest probes read
// "no ops" (check15: the call itself connected, signaling + ICE both
// fine). The poll below is the only place getStats runs; a verb just
// reads the last cached value, so it always answers inside the exec
// budget and the media flips to "connected" on the next poll once
// frames flow.
// ON-DEMAND + a slow 30 s interval: the first version polled on a
// 2 s interval, which under TCG meant back-to-back getStats (each
// one slow) hammering the Chromiums continuously — the extra load
// made the host/Terminal even less responsive during a call
// (check19: every media probe "no ops"). Now a poll is triggered
// on demand by a STATUS/CALLS read (at most once per 5 s) and by a
// slow 30 s interval, so getStats runs only when something is
// actually watching or for the console log below, and the guest
// stays quiet the rest of the time.
let mediaCache = { media: "none", raw: null };
let mediaCacheAt = 0;
let mediaPollRunning = false;
let mediaInterval = null;
function liveCall() {
  return [...calls.values()].some(
    (c) => c.state === "connected" || c.state === "ringing" || c.state === "incoming",
  );
}
async function pollMediaOnce() {
  if (mediaPollRunning || !bridge || calls.size === 0) return;
  mediaPollRunning = true;
  try {
    // One getStats, not two: refreshMediaState() is the same call
    // plus the frames gate, so derive "connected" here directly —
    // but keep the bridge's own mediaState() as the base: a null
    // bridge reports "none" (never faked), never "connecting".
    const raw = await bridge
      .rawMediaState()
      .catch((e) => ({ error: String(e?.message || e) }));
    const base = bridge.mediaState();
    const media =
      base === "none"
        ? "none"
        : raw && raw.framesReceived > 0 && raw.connectionState === "connected"
          ? "connected"
          : "connecting";
    mediaCache = { media, raw };
    mediaCacheAt = Date.now();
    if (liveCall()) {
      const line = { kind: "media-state", user: account?.userId, media, ...raw };
      log(line);
      // Mirror the connected state to the serial console so the
      // harness can see frames flowing without the Terminal or
      // the app rendering — under TCG the Terminal/app wedge
      // during an active call, so the console is the only live
      // channel that survives. Best-effort: /dev/console does not
      // exist on the sandbox host (log file only there).
      if (media === "connected") {
        // Fire-and-forget: a slow/blocked console must never stall
        // the poll.
        void fs
          .appendFile("/dev/console", `COMMS ${JSON.stringify(line)}\n`)
          .catch(() => {});
      }
    }
    for (const c of calls.values()) {
      if (c.state === "connected" || c.state === "ringing" || c.state === "incoming") {
        c.media = c.state === "connected" ? media : bridge.mediaState();
        c.rawMedia = raw;
      }
    }
  } finally {
    mediaPollRunning = false;
  }
}
function ensureMediaPoll() {
  // On-demand: trigger one background poll only when the cache is
  // stale — never a timer, never awaited by the verb.
  if (!mediaPollRunning && Date.now() - mediaCacheAt > 5000) {
    void pollMediaOnce();
  }
  // Slow interval: keeps the cache fresh and the console log
  // flowing even when nothing reads CALLS (the harness's serial
  // media wait depends on it). 30 s, not 2: a getStats under TCG
  // takes ~10 s, so a 2 s interval ran back-to-back getStats and
  // starved the host.
  if (!mediaInterval) {
    mediaInterval = setInterval(() => {
      if (liveCall()) void pollMediaOnce();
    }, 30000);
    mediaInterval.unref?.();
  }
}

// Refresh the media state of every live call from the bridge before
// reporting (the bridge's frames-flowing check is the honest gate).
// While a call is live the raw stats go to the log too — the one line
// that tells a stuck "connecting" apart: ICE connected with zero
// frames (no local track / no frames arriving) vs ICE never connected
// (candidates not pairing) vs a dead bridge (getStats throwing).
// This only applies the background cache — it never awaits getStats,
// so a STATUS/CALLS verb always answers inside the host exec budget.
function refreshCallsMedia() {
  if (!bridge || calls.size === 0) return;
  ensureMediaPoll();
  for (const c of calls.values()) {
    if (c.state === "connected" || c.state === "ringing" || c.state === "incoming") {
      c.media = c.state === "connected" ? mediaCache.media : bridge.mediaState();
      if (mediaCache.raw) c.rawMedia = mediaCache.raw;
    }
  }
}

async function sendCallEvent(roomId, type, content) {
  return client.sendEvent(roomId, type, content);
}

// TURN credentials for the bridge. The SDK's checkTurnServers() only
// runs when supportsVoip() is true (it needs a platform
// RTCPeerConnection, which Node lacks), so getTurnServers() is always
// empty here — fetch the endpoint directly and map uris -> urls the
// same way the SDK does. Without TURN, real calls fall back to STUN
// + direct P2P; the bridge's loopback proof needs neither.
async function fetchIceServers() {
  try {
    const res = await client.turnServer();
    if (res?.uris?.length) {
      return [{ urls: res.uris, username: res.username, credential: res.password }];
    }
  } catch {
    /* no TURN available; the bridge falls back to STUN */
  }
  return [];
}

async function startCall(roomId, video) {
  if (!client) throw new Error("not logged in");
  const b = getBridge();
  const callId = newCallId();
  const room = client.getRoom(roomId);
  const peer = room
    ? room
        .getJoinedMembers()
        .map((m) => m.userId)
        .find((u) => u !== account.userId) || null
    : null;
  const call = {
    callId,
    roomId,
    peer,
    video,
    direction: "outgoing",
    state: "ringing",
    media: "none",
    partyId: account.deviceId,
  };
  calls.set(callId, call);
  ensureMediaPoll();
  // The bridge produces the SDP offer; candidates stream out as
  // m.call.candidates while the call is live. TURN comes from the
  // homeserver (turn.matrix.org for matrix.org users) so media can
  // relay when direct P2P is blocked.
  let iceServers = [];
  try {
    iceServers = await fetchIceServers();
  } catch {
    iceServers = [];
  }
  const offer = await b.startCall({ callId, video, iceServers });
  call.media = b.mediaState();
  await sendCallEvent(roomId, "m.call.invite", {
    call_id: callId,
    offer: { type: "offer", sdp: offer.sdp },
    version: 1,
    // 180 s, not 60: the invite lifetime, the ring timer, and the
    // CDP budget must all agree — under TCG the answer prep
    // (getUserMedia + SDP) takes over a minute, so a 60 s ring
    // timeout hangs up (alice side) before a slow peer can answer
    // (check10: alice hung up at 60 s, bob's attempts then found
    // no incoming call). On real hardware the callee answers in
    // seconds, so the longer timeout rarely matters.
    lifetime: 180000,
    party_id: call.partyId,
  });
  log({ kind: "call-invite", callId, roomId, peer, video });
  startPump(call);
  // Ringing timeout: 180 s, then hang up so a dead call never lingers.
  call.timer = setTimeout(() => {
    if (call.state === "ringing") void endCall(callId, "timeout");
  }, 180000);
  call.timer.unref?.();
  return call;
}

function startPump(call) {
  if (call.pumping) return;
  call.pumping = true;
  void pumpCandidates(call);
}

async function pumpCandidates(call) {
  // Stream local ICE candidates to the peer until the call ends.
  while (
    call.state === "ringing" ||
    call.state === "connected" ||
    call.state === "incoming"
  ) {
    // A bridge failure (or a SHUTDOWN closing the bridge under a
    // live pump) must end the pump quietly, never crash the daemon
    // with an unhandled rejection — the state check below ends the
    // loop, and shutdown exits the process right after close().
    let cands = [];
    try {
      cands = await getBridge().takeCandidates(call.callId);
    } catch (e) {
      log({ kind: "pump-error", callId: call.callId, error: String(e?.message || e) });
      break;
    }
    if (cands.length > 0 && client) {
      try {
        await sendCallEvent(call.roomId, "m.call.candidates", {
          call_id: call.callId,
          candidates: cands,
          version: 1,
          party_id: call.partyId,
        });
        // One line per call when the first batch goes out — the
        // log then shows whether trickle actually started. The
        // candidate strings themselves stay out of the log.
        if (!call.candsLogged) {
          call.candsLogged = true;
          log({ kind: "pump-first-batch", callId: call.callId, count: cands.length });
        }
      } catch {
        /* peer may have hung up; the state check below ends the loop */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function answerCall(callId) {
  const call = calls.get(callId);
  if (!call) throw new Error(`no such call ${callId}`);
  if (call.state !== "incoming")
    throw new Error(`call ${callId} is ${call.state}, not incoming`);
  const b = getBridge();
  const answer = await b.answerCall(call);
  await sendCallEvent(call.roomId, "m.call.answer", {
    call_id: callId,
    answer: { type: "answer", sdp: answer.sdp },
    version: 1,
    party_id: call.partyId,
  });
  call.state = "connected";
  call.media = b.mediaState();
  startPump(call);
  log({ kind: "call-answered", callId, roomId: call.roomId });
  return call;
}

async function endCall(callId, reason) {
  const call = calls.get(callId);
  if (!call) throw new Error(`no such call ${callId}`);
  if (call.timer) clearTimeout(call.timer);
  // Mark the call ended FIRST, then tear down in the background:
  // the bridge teardown (CDP close) and even the hangup event
  // send can take 10 s+ under TCG, which would push the HANGUP
  // verb past the host's 10 s exec timeout even though the call
  // is already ended (check23: first hangup -> 124, retry -> 1
  // because the call was gone by then, yet the start screen
  // proved the call had ended). The teardown is per-callId, so a
  // background close cannot touch the next call, and the peer's
  // own timeout ends its side if the event is ever lost.
  call.state = "ended";
  call.media = "none";
  log({ kind: "call-ended", callId, reason: reason || "hangup" });
  // Dedupe the event: endCall can race (local hangup + a remote
  // hangup arriving on the timeline), and a second hangup event
  // is noise. The bridge teardown stays idempotent per callId.
  if (client && !call.hangupSent) {
    call.hangupSent = true;
    void sendCallEvent(call.roomId, "m.call.hangup", {
      call_id: callId,
      version: 1,
      party_id: call.partyId,
      reason: reason || "user hangup",
    }).catch(() => {
      /* already gone; the local state is ended regardless */
    });
  }
  void getBridge()
    .endCall(callId)
    .catch(() => {
      /* bridge already closed */
    });
  return call;
}

function onTimeline(ev, room) {
  // getType() is the decrypted type once decryption has run (and
  // "m.room.encrypted" before that, so a ciphertext Timeline event
  // is ignored here and picked up by the Decrypted listener above).
  const type = ev.getType();
  if (!type.startsWith("m.call.")) return;
  const content = ev.getContent();
  const callId = content?.call_id;
  if (!callId) return;
  // Ignore our own echoes (the sender is us).
  if (ev.getSender() === account?.userId) return;
  if (type === "m.call.invite") {
    const offer = content.offer;
    if (!offer || offer.type !== "offer") return;
    if (calls.has(callId)) return; // duplicate invite (Decrypted re-fire)
    const call = {
      callId,
      roomId: room.roomId,
      peer: ev.getSender(),
      video: offer.sdp.includes("m=video"),
      direction: "incoming",
      state: "incoming",
      media: "none",
      partyId: account.deviceId,
      offerSdp: offer.sdp,
    };
    calls.set(callId, call);
    ensureMediaPoll();
    log({
      kind: "call-incoming",
      callId,
      roomId: room.roomId,
      peer: call.peer,
      video: call.video,
    });
    // Pre-build the answer SDP so ANSWER is fast; it is only SENT on answer.
    (async () => {
      try {
        call.iceServers = await fetchIceServers();
      } catch {
        call.iceServers = [];
      }
      try {
        const a = await getBridge().prepareAnswer(call);
        call.answerSdp = a.sdp;
        call.media = getBridge().mediaState();
        startPump(call);
      } catch (e) {
        // The bridge's getTimings is a synchronous page read (no
        // pc.getStats), so it returns even while the createAnswer
        // is stuck — it shows the last step that completed. (The
        // earlier rawMediaState() attempt never surfaced timings:
        // getStats awaits pc.getStats(), which hangs on a mid-answer
        // PC under TCG.)
        let timings = null;
        try {
          timings = (await getBridge().getTimings?.()) ?? null;
        } catch {}
        log({
          kind: "call-answer-prep-failed",
          callId,
          error: String(e?.message || e),
          ...(timings ? { answerTimings: timings } : {}),
        });
      }
    })();
    call.timer = setTimeout(() => {
      if (call.state === "incoming") void endCall(callId, "timeout");
      // 180 s, not 60: under TCG the answer prep (getUserMedia +
      // SDP) can take a minute, and the ANSWER verb's retries are
      // each bounded by the host's 10 s exec timeout — a 60 s ring
      // timeout ends the call before a slow peer can answer it.
    }, 180000);
    call.timer.unref?.();
  } else if (type === "m.call.answer") {
    const call = calls.get(callId);
    if (!call || call.direction !== "outgoing" || call.state !== "ringing") return;
    const answer = content.answer;
    if (!answer || answer.type !== "answer") return;
    getBridge()
      .setRemoteAnswer(call, answer.sdp)
      .then(() => {
        call.state = "connected";
        call.media = getBridge().mediaState();
        log({ kind: "call-connected", callId });
      })
      .catch((e) =>
        log({ kind: "call-answer-failed", callId, error: String(e?.message || e) }),
      );
  } else if (type === "m.call.candidates") {
    const call = calls.get(callId);
    if (!call) return;
    // Log receipt (count only — the candidate strings stay out of
    // the log): a call stuck at ICE "new" is almost always a
    // candidate that never arrived or never got added, and this is
    // the line that tells those two apart.
    log({
      kind: "candidates-received",
      callId,
      count: (content.candidates || []).length,
      ufrag: content.candidates?.[0]?.usernameFragment || "",
    });
    for (const cand of content.candidates || []) {
      getBridge()
        .addIceCandidate(call, cand)
        .catch((e) =>
          log({
            kind: "add-candidate-failed",
            callId,
            error: String(e?.message || e),
          }),
        );
    }
  } else if (type === "m.call.hangup" || type === "m.call.reject") {
    const call = calls.get(callId);
    if (!call) return;
    if (call.timer) clearTimeout(call.timer);
    getBridge()
      .endCall(callId)
      .catch(() => {});
    call.state = "ended";
    call.media = "none";
    log({ kind: "call-ended", callId, reason: type });
  }
}

// ---------------------------------------------------------------------------
// Socket protocol (aid-style: one line in, one line out)
// ---------------------------------------------------------------------------
async function handleLine(line) {
  const parts = line.trim().split(/\s+/);
  const verb = (parts[0] || "").toUpperCase();
  try {
    switch (verb) {
      case "STATUS": {
        await refreshCallsMedia();
        return {
          ok: true,
          running: true,
          loggedIn: !!client,
          userId: account?.userId || null,
          homeserver: account?.homeserver || MOCK_MATRIX || HOMESERVER,
          deviceId: account?.deviceId || null,
          rooms: client ? client.getRooms().length : 0,
          calls: [...calls.values()].map(callView),
          bridge: BRIDGE_MODE,
        };
      }
      case "LOGIN": {
        if (client) throw new Error("already logged in (logout first)");
        // LOGIN <user> <password...> [homeserver] — the password may
        // contain spaces (the CLI sends it verbatim); the homeserver
        // is the last token only when it looks like a URL. A password
        // starting with "http://" would be misread as a homeserver —
        // vanishingly rare, and the --password-file path has the
        // same shape, so this is the documented limit.
        const rest = line.slice(line.indexOf(" ") + 1).trim();
        const user = rest.split(/\s+/)[0];
        let tail = rest.slice(user.length).trim();
        let homeserver = MOCK_MATRIX || HOMESERVER;
        const tokens = tail.split(/\s+/);
        const last = tokens[tokens.length - 1] || "";
        if (
          tokens.length > 1 &&
          (last.startsWith("http://") || last.startsWith("https://"))
        ) {
          homeserver = last;
          tail = tokens.slice(0, -1).join(" ");
        }
        const password = tail;
        if (!user || !password)
          throw new Error("usage: LOGIN <user> <password> [homeserver]");
        const tmp = sdk.createClient({ baseUrl: homeserver });
        const login = await tmp.login("m.login.password", { user, password });
        const acc = {
          homeserver,
          userId: login.user_id,
          deviceId: login.device_id,
          accessToken: login.access_token,
        };
        await saveAccount(acc);
        await startMatrix(acc);
        return { ok: true, userId: acc.userId, deviceId: acc.deviceId };
      }
      case "LOGOUT": {
        await stopMatrix();
        try {
          await fs.unlink(ACCOUNT_FILE);
        } catch {
          /* no account file */
        }
        account = null;
        calls.clear();
        return { ok: true, loggedOut: true };
      }
      case "ROOMS": {
        if (!client) throw new Error("not logged in");
        return { ok: true, rooms: client.getRooms().map(roomInfo) };
      }
      case "MESSAGES": {
        if (!client) throw new Error("not logged in");
        const roomId = parts[1];
        const limit = Math.min(Number(parts[2] || 20) || 20, 100);
        if (!roomId) throw new Error("usage: MESSAGES <roomId> [limit]");
        const room = client.getRoom(roomId);
        if (!room) throw new Error(`no such room ${roomId}`);
        const events = room.getLiveTimeline().getEvents().slice(-limit);
        return { ok: true, roomId, messages: events.map(resolveMessage) };
      }
      case "SEND": {
        if (!client) throw new Error("not logged in");
        const roomId = parts[1];
        const text = line.slice(line.indexOf(roomId) + roomId.length + 1);
        if (!roomId || !text) throw new Error("usage: SEND <roomId> <text>");
        const { event_id } = await client.sendMessage(roomId, {
          msgtype: "m.text",
          body: text,
        });
        log({ kind: "sent", roomId, eventId: event_id });
        return { ok: true, eventId: event_id };
      }
      case "CALL": {
        if (!client) throw new Error("not logged in");
        let target = parts[1];
        const video = parts.includes("--video");
        if (!target) throw new Error("usage: CALL <roomId|userId> [--video|--audio]");
        let roomId = target;
        if (target.startsWith("@")) {
          // Find the DM room, or create one with an invite.
          const dm = client.getRooms().find((r) => {
            const members = r.getJoinedMembers().map((m) => m.userId);
            return (
              members.length === 2 &&
              members.includes(target) &&
              members.includes(account.userId)
            );
          });
          if (dm) roomId = dm.roomId;
          else {
            const created = await client.createRoom({
              invite: [target],
              is_direct: true,
            });
            roomId = created.room_id;
          }
        }
        const call = await startCall(roomId, video);
        return { ok: true, ...callView(call) };
      }
      case "ANSWER": {
        if (!client) throw new Error("not logged in");
        // No id: answer the (single) incoming call. The check drives
        // bob's daemon from the Terminal, and the call id never
        // reaches the serial log — the id is only in the Terminal
        // window — so the no-arg form is how the peer answers.
        const id =
          parts[1] || [...calls.values()].find((c) => c.state === "incoming")?.callId;
        if (!id) throw new Error("no incoming call to answer");
        const call = await answerCall(id);
        return { ok: true, ...callView(call) };
      }
      case "HANGUP": {
        if (!client) throw new Error("not logged in");
        // No id: end the (single) live call.
        const id =
          parts[1] ||
          [...calls.values()].find((c) =>
            ["connected", "ringing", "incoming"].includes(c.state),
          )?.callId;
        if (!id) throw new Error("no active call to hang up");
        const call = await endCall(id, "user hangup");
        return { ok: true, ...callView(call) };
      }
      case "CALLS": {
        await refreshCallsMedia();
        return { ok: true, calls: [...calls.values()].map(callView) };
      }
      case "RCS": {
        const sub = (parts[1] || "").toUpperCase();
        if (sub === "STATUS") return { ok: true, ...rcsStatus() };
        // PROBE runs the SIP/MSRP skeleton against the mock ACS
        // (127.0.0.1:5060 by default). It proves the client shapes,
        // not interop with any real IMS core.
        if (sub === "PROBE") {
          const probe = await rcsProbe({ host: ACS_HOST, port: ACS_PORT });
          return { ok: probe.ok, ...rcsStatus(), probe };
        }
        throw new Error("usage: RCS STATUS | RCS PROBE");
      }
      case "SHUTDOWN": {
        // Proper shutdown (stop the Matrix client, close the bridge
        // and its Chromium group) — process.exit() alone would
        // orphan the Chromium tree.
        setTimeout(() => {
          void (async () => {
            await stopMatrix();
            try {
              await getBridge().close();
            } catch {
              /* no bridge */
            }
            process.exit(0);
          })();
        }, 50);
        return { ok: true, shuttingDown: true };
      }
      default:
        throw new Error(`unknown verb ${verb || "(empty)"}`);
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.unlink(SOCK_PATH);
  } catch {
    /* no stale socket */
  }
  const server = net.createServer((socket) => {
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      const reply = await handleLine(line);
      socket.write(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => {});
  });
  server.listen(SOCK_PATH, async () => {
    log({ kind: "listening", socket: SOCK_PATH, bridge: BRIDGE_MODE, data: DATA_DIR });
    // Eager bridge pre-warm (chromium mode only). The host kills any
    // `sevyn` exec after 10 s, and a cold Chromium launch takes
    // ~15-25 s — so the bridge must already be up before the first
    // CALL/ANSWER, or the verb dies at 10 s (exit 124) with the
    // invite never sent (the 2026-11-10 KVM failure mode). Best
    // effort: a failed warmup is logged, the next verb retries
    // lazily, and a verb that arrives mid-warmup fails fast with
    // "media engine still starting" instead of hanging.
    if (BRIDGE_MODE === "chromium") {
      // 300 s, not 120: under TCG (CI) a cold Chromium can take
      // minutes to reach a usable page — the 2026-11-11 CI round-2
      // failure was the warm dying at doStart's 10 s page wait
      // while the page was still loading, so every CALL/ANSWER
      // verb then failed with exit 1 and the call sat "ringing".
      // doStart's own deadlines (below) must fit inside this
      // budget: DevTools 60 s + page 120 s + CDP overhead.
      void getBridge()
        .ensureStarted(300000)
        .then(() => log({ kind: "bridge-warm" }))
        .catch((e) =>
          log({ kind: "bridge-warm-failed", error: String(e?.message || e) }),
        );
    }
    const acc = await loadAccount();
    if (acc) {
      try {
        await startMatrix(acc);
      } catch (e) {
        log({ kind: "autostart-failed", error: String(e?.message || e) });
      }
    }
  });
  const shutdown = async () => {
    await stopMatrix();
    try {
      await getBridge().close();
    } catch {
      /* no bridge */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(`COMMS fatal ${e?.stack || e}`);
  process.exit(1);
});
