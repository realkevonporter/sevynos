// SevynOS v2 M10 — mock Matrix homeserver (test double, never a system service).
//
// A minimal Matrix Client-Server API server, just enough for commsd's
// real matrix-js-sdk client to log in, sync, send/receive (plain and
// E2EE-encrypted rooms), and relay m.call.* events between two local
// clients. It understands the protocol, not the crypto: device keys and
// one-time keys are stored and relayed opaquely; Olm/Megolm sessions
// are negotiated by the clients themselves through /keys/* and
// /sendToDevice, exactly as against a real homeserver.
//
// Started ONLY with sevyn.mockcomms=1 on the kernel cmdline (same
// pattern as sevyn.mockapi=1). Listens on loopback only. Every request
// is logged as a `MOCK {...}` line so the m10-check harness can grep
// the serial log for the wire (POST /send, m.call.invite, ...).
//
// Usage: node mock-matrix.js [--port 7071]
//   Env: MOCK_MATRIX_PORT (default 7071), MOCK_LOG=1 (log lines).
//
// Seeded users (password "testpass"):
//   @alice:test.local (Alice), @bob:test.local (Bob)
// Seeded rooms:
//   !dm-plain:test.local  — plain DM room (Alice + Bob)
//   !dm-enc:test.local    — encrypted DM room (m.megolm.v1.aes-sha2)
//   !call:test.local      — call room (Alice + Bob)
// The server name is test.local; nothing here reaches the internet.

import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_MATRIX_PORT || 7071);
const LOG = process.env.MOCK_LOG === "1";

const SERVER = "test.local";
const PASSWORD = "testpass";

function log(kind, method, path, extra) {
  if (!LOG) return;
  const line = { kind, method, path };
  if (extra !== undefined) line.extra = extra;
  console.log(`MOCK ${JSON.stringify(line)}`);
}

function b64(n) {
  return randomBytes(n).toString("base64").replace(/[+/=]/g, "");
}

let seq = 0;
function nextSeq() {
  return ++seq;
}
function eventId() {
  return `$${b64(12)}:${SERVER}`;
}

// --- state ---------------------------------------------------------------
const users = {
  "@alice:test.local": {
    password: PASSWORD,
    displayname: "Alice",
    devices: {}, // deviceId -> { device_keys, one_time_keys: { keyId: keyObj } }
  },
  "@bob:test.local": {
    password: PASSWORD,
    displayname: "Bob",
    devices: {},
  },
};
const tokens = new Map(); // accessToken -> { userId, deviceId }
const rooms = {};
const toDevice = {}; // userId -> deviceId -> [event, ...]
const deviceChanges = []; // { seq, userId }

function newRoom(id, name, encrypted) {
  const members = ["@alice:test.local", "@bob:test.local"];
  const state = [
    {
      type: "m.room.create",
      state_key: "",
      sender: "@alice:test.local",
      content: { creator: "@alice:test.local", room_version: "10" },
    },
    ...members.map((u) => ({
      type: "m.room.member",
      state_key: u,
      sender: u,
      content: { membership: "join", displayname: users[u].displayname },
    })),
    {
      type: "m.room.name",
      state_key: "",
      sender: "@alice:test.local",
      content: { name },
    },
    {
      type: "m.room.power_levels",
      state_key: "",
      sender: "@alice:test.local",
      content: {
        users_default: 0,
        events_default: 0,
        state_default: 50,
        users: { "@alice:test.local": 100, "@bob:test.local": 100 },
      },
    },
  ];
  if (encrypted) {
    state.push({
      type: "m.room.encryption",
      state_key: "",
      sender: "@alice:test.local",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }
  rooms[id] = {
    id,
    name,
    encrypted,
    members: new Set(members),
    state,
    timeline: [], // { seq, event }
  };
}
newRoom("!dm-plain:test.local", "Alice & Bob", false);
newRoom("!dm-enc:test.local", "Alice & Bob (encrypted)", true);
newRoom("!call:test.local", "Call room", false);

function roomStateEvents(room) {
  return room.state.map((e) => ({
    ...e,
    event_id: `$state-${room.id}-${e.type}-${e.state_key}:${SERVER}`,
    room_id: room.id,
    origin_server_ts: 0,
    unsigned: { age: 0 },
  }));
}

function queueToDevice(userId, deviceId, event) {
  toDevice[userId] ??= {};
  toDevice[userId][deviceId] ??= [];
  toDevice[userId][deviceId].push(event);
}

function auth(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return tokens.get(m[1]) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

// --- sync ------------------------------------------------------------------
async function handleSync(req, res, me, url) {
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw.replace(/^s/, "")) || 0 : 0;
  const timeoutMs = Number(url.searchParams.get("timeout") || 0);
  // Short-poll: if nothing is new and the client asked to wait, hold
  // up to 2s so the SDK's sync loop does not spin. Never longer —
  // the harness waits on log lines, not on sync latency.
  const hasNew = () =>
    Object.values(rooms).some(
      (r) => r.members.has(me.userId) && r.timeline.some((t) => t.seq > since),
    ) ||
    (toDevice[me.userId]?.[me.deviceId]?.length ?? 0) > 0 ||
    deviceChanges.some((d) => d.seq > since);
  if (timeoutMs > 0 && !hasNew()) {
    await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 2000)));
  }
  const join = {};
  for (const room of Object.values(rooms)) {
    if (!room.members.has(me.userId)) continue;
    const newEvents = room.timeline.filter((t) => t.seq > since);
    const entry = {
      state: { events: since === 0 ? roomStateEvents(room) : [] },
      timeline: {
        events: newEvents.slice(-50).map((t) => t.event),
        prev_batch: `s${since}`,
        limited: false,
      },
      ephemeral: { events: [] },
      account_data: { events: [] },
      unread_notifications: { notification_count: 0, highlight_count: 0 },
    };
    join[room.id] = entry;
  }
  const td = toDevice[me.userId]?.[me.deviceId] || [];
  toDevice[me.userId] ??= {};
  toDevice[me.userId][me.deviceId] = [];
  if (LOG && td.length > 0) {
    console.log(
      `MOCK ${JSON.stringify({ kind: "todevice-deliver", user: me.userId, device: me.deviceId, count: td.length, types: td.map((e) => e.type) })}`,
    );
  }
  // The SDK learns about new devices ONLY from device_lists.changed in
  // /sync. Without it, a client never re-queries keys and never shares
  // Megolm room keys with a peer that uploaded keys after the first
  // sync — the exact failure the E2EE smoke test hit.
  const changedUsers = [
    ...new Set(
      deviceChanges
        .filter((d) => d.seq > since && d.userId !== me.userId)
        .map((d) => d.userId),
    ),
  ];
  const otkCount = {};
  for (const dev of Object.values(users[me.userId].devices)) {
    for (const keyId of Object.keys(dev.one_time_keys || {})) {
      const alg = keyId.split(":")[0];
      otkCount[alg] = (otkCount[alg] || 0) + 1;
    }
  }
  send(res, 200, {
    next_batch: `s${seq}`,
    rooms: { join, invite: {}, leave: {} },
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: td },
    device_lists: { changed: changedUsers, left: [] },
    device_one_time_keys_count: otkCount,
  });
}

// --- server ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  log("http", req.method, path);
  try {
    // Unauthenticated discovery / login.
    if (req.method === "GET" && path === "/_matrix/client/versions") {
      return send(res, 200, {
        versions: ["r0.6.1", "v1.1", "v1.2", "v1.3", "v1.4", "v1.5"],
        unstable_features: { "org.matrix.msc2732": true },
      });
    }
    if (req.method === "GET" && path === "/.well-known/matrix/client") {
      return send(res, 200, {
        "m.homeserver": { base_url: `http://127.0.0.1:${PORT}` },
      });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/login") {
      const body = await readBody(req);
      const ident = body.identifier || {};
      let userId = ident.user || body.user || "";
      if (!userId.startsWith("@")) userId = `@${userId}:${SERVER}`;
      const user = users[userId];
      if (!user || body.password !== user.password) {
        return send(res, 403, { errcode: "M_FORBIDDEN", error: "bad login" });
      }
      const deviceId = body.device_id || `SEVYN${b64(6).toUpperCase()}`;
      const token = `tok-${b64(16)}`;
      tokens.set(token, { userId, deviceId });
      return send(res, 200, {
        user_id: userId,
        access_token: token,
        device_id: deviceId,
        home_server: SERVER,
        well_known: { "m.homeserver": { base_url: `http://127.0.0.1:${PORT}` } },
      });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/logout") {
      const h = req.headers.authorization || "";
      const m = h.match(/^Bearer\s+(.+)$/);
      if (m) tokens.delete(m[1]);
      return send(res, 200, {});
    }

    // Everything below needs a token.
    const me = auth(req);
    if (!me) {
      return send(res, 401, { errcode: "M_MISSING_TOKEN", error: "missing token" });
    }

    if (req.method === "GET" && path === "/_matrix/client/v3/capabilities") {
      return send(res, 200, {
        capabilities: {
          "m.room_versions": { default: "10", available: { 10: "stable" } },
          "m.change_password": { enabled: true },
        },
      });
    }
    if (req.method === "GET" && path === "/_matrix/client/v3/account/whoami") {
      return send(res, 200, {
        user_id: me.userId,
        device_id: me.deviceId,
        is_guest: false,
      });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/room_keys/version") {
      return send(res, 404, { errcode: "M_NOT_FOUND", error: "no backup" });
    }
    if (req.method === "GET" && path === "/_matrix/client/v3/room_keys/version") {
      return send(res, 404, { errcode: "M_NOT_FOUND", error: "no backup" });
    }
    if (req.method === "GET" && path === "/_matrix/client/v3/pushrules/") {
      return send(res, 200, {
        global: { override: [], content: [], room: [], sender: [], underride: [] },
      });
    }
    if (req.method === "GET" && path === "/_matrix/client/v3/keys/changes") {
      return send(res, 200, { changed: [], left: [] });
    }
    if (req.method === "GET" && path === "/_matrix/client/v3/voip/turnServer") {
      return send(res, 200, {
        username: "mock",
        password: "mock",
        uris: [],
        ttl: 86400,
      });
    }
    if (req.method === "GET" && path.startsWith("/_matrix/client/v3/profile/")) {
      const userId = decodeURIComponent(path.split("/").pop());
      const user = users[userId];
      if (!user) return send(res, 404, { errcode: "M_NOT_FOUND", error: "no user" });
      return send(res, 200, { displayname: user.displayname });
    }
    if (
      req.method === "POST" &&
      path.startsWith("/_matrix/client/v3/user/") &&
      path.endsWith("/filter")
    ) {
      await readBody(req);
      return send(res, 200, { filter_id: "0" });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/createRoom") {
      const body = await readBody(req);
      const n = Object.keys(rooms).length + 1;
      const roomId = `!room${n}:${SERVER}`;
      const name = body.name || `Room ${n}`;
      newRoom(roomId, name, false);
      for (const invitee of body.invite || []) {
        if (users[invitee]) rooms[roomId].members.add(invitee);
      }
      return send(res, 200, { room_id: roomId });
    }
    if (
      req.method === "POST" &&
      path.match(/^\/_matrix\/client\/v3\/rooms\/[^/]+\/join$/)
    ) {
      const roomId = decodeURIComponent(path.split("/")[5]);
      const room = rooms[roomId];
      if (!room) return send(res, 404, { errcode: "M_NOT_FOUND", error: "no room" });
      room.members.add(me.userId);
      return send(res, 200, { room_id: roomId });
    }
    if (
      req.method === "GET" &&
      path.match(/^\/_matrix\/client\/v3\/rooms\/[^/]+\/members$/)
    ) {
      const roomId = decodeURIComponent(path.split("/")[5]);
      const room = rooms[roomId];
      if (!room) return send(res, 404, { errcode: "M_NOT_FOUND", error: "no room" });
      return send(res, 200, {
        chunk: [...room.members].map((u) => ({
          type: "m.room.member",
          state_key: u,
          sender: u,
          content: { membership: "join", displayname: users[u].displayname },
          event_id: `$member-${u}:${SERVER}`,
          room_id: roomId,
          origin_server_ts: 0,
        })),
      });
    }
    if (
      req.method === "POST" &&
      path.match(
        /^\/_matrix\/client\/v3\/rooms\/[^/]+\/(read_markers|receipt\/[^/]+\/[^/]+)$/,
      )
    ) {
      await readBody(req);
      return send(res, 200, {});
    }
    // send: the spec uses PUT (txnId in the path); accept POST too.
    if (
      (req.method === "PUT" || req.method === "POST") &&
      path.match(/^\/_matrix\/client\/v3\/rooms\/[^/]+\/send\/[^/]+\/[^/]+$/)
    ) {
      const parts = path.split("/");
      const roomId = decodeURIComponent(parts[5]);
      const eventType = decodeURIComponent(parts[7]);
      const body = await readBody(req);
      const room = rooms[roomId];
      if (!room || !room.members.has(me.userId)) {
        return send(res, 404, { errcode: "M_NOT_FOUND", error: "no room" });
      }
      const ev = {
        event_id: eventId(),
        type: eventType,
        sender: me.userId,
        room_id: roomId,
        content: body,
        origin_server_ts: Date.now(),
        unsigned: { age: 0 },
      };
      room.timeline.push({ seq: nextSeq(), event: ev });
      return send(res, 200, { event_id: ev.event_id });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/keys/upload") {
      const body = await readBody(req);
      const dev = (users[me.userId].devices[me.deviceId] ??= {
        device_keys: null,
        one_time_keys: {},
      });
      if (body.device_keys) dev.device_keys = body.device_keys;
      for (const [keyId, keyObj] of Object.entries(body.one_time_keys || {})) {
        dev.one_time_keys[keyId] = keyObj;
      }
      deviceChanges.push({ seq: nextSeq(), userId: me.userId });
      const counts = {};
      for (const keyId of Object.keys(dev.one_time_keys)) {
        const alg = keyId.split(":")[0];
        counts[alg] = (counts[alg] || 0) + 1;
      }
      return send(res, 200, { one_time_key_counts: counts });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/keys/query") {
      const body = await readBody(req);
      const device_keys = {};
      for (const userId of Object.keys(body.device_keys || {})) {
        const user = users[userId];
        if (!user) continue;
        device_keys[userId] = {};
        for (const [deviceId, dev] of Object.entries(user.devices)) {
          if (dev.device_keys) device_keys[userId][deviceId] = dev.device_keys;
        }
      }
      return send(res, 200, { device_keys, failures: {} });
    }
    if (req.method === "POST" && path === "/_matrix/client/v3/keys/claim") {
      const body = await readBody(req);
      const one_time_keys = {};
      for (const [userId, devs] of Object.entries(body.one_time_keys || {})) {
        const user = users[userId];
        if (!user) continue;
        one_time_keys[userId] = {};
        for (const [deviceId, alg] of Object.entries(devs)) {
          const dev = user.devices[deviceId];
          if (!dev) continue;
          const keyId = Object.keys(dev.one_time_keys).find((k) =>
            k.startsWith(alg + ":"),
          );
          if (!keyId) continue;
          one_time_keys[userId][deviceId] = { [keyId]: dev.one_time_keys[keyId] };
          delete dev.one_time_keys[keyId];
        }
      }
      return send(res, 200, { one_time_keys, failures: {} });
    }
    if (
      req.method === "PUT" &&
      path.match(/^\/_matrix\/client\/v3\/sendToDevice\/[^/]+\/[^/]+$/)
    ) {
      const parts = path.split("/");
      const eventType = decodeURIComponent(parts[5]);
      const body = await readBody(req);
      log(
        "todevice",
        req.method,
        path,
        JSON.stringify(body.messages || {}).slice(0, 300),
      );
      for (const [userId, devs] of Object.entries(body.messages || {})) {
        for (const [deviceId, content] of Object.entries(devs)) {
          queueToDevice(userId, deviceId, {
            type: eventType,
            sender: me.userId,
            content,
          });
        }
      }
      return send(res, 200, {});
    }
    if (req.method === "GET" && path === "/_matrix/client/v3/sync") {
      return handleSync(req, res, me, url);
    }

    return send(res, 404, {
      errcode: "M_NOT_FOUND",
      error: `no mock route ${req.method} ${path}`,
    });
  } catch (e) {
    console.error("mock error", e);
    return send(res, 500, { errcode: "M_UNKNOWN", error: String(e?.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-matrix listening on 127.0.0.1:${PORT}`);
});
