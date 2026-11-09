// SevynOS M6 — mock Tokrah API + Socket.IO server for the live-session
// proof. Runs in Node on 127.0.0.1:7070 and answers the exact endpoints
// Tokrah's real client code calls, with a fixed test user and a live
// session that moves LIVE -> ENDED. Every request and socket event is
// recorded in `events` so the driver can assert the wire happened.
// This is a test double, not a Tokrah server: no auth, no persistence,
// no media — it proves the client code path end to end.
"use strict";
const http = require("http");
// The mock API's Socket.IO server: prefer a `socket.io` resolvable
// from this file's own node_modules (the image stages one next to the
// mock server), then fall back to the Tokrah API's own node_modules
// (the same server version the real API runs). TOKRAH_SRC is the
// Tokrah repo root (the dir holding tokrah/ + api/).
let Server;
try {
  ({ Server } = require("socket.io"));
} catch (e) {
  const TOKRAH_SRC = process.env.TOKRAH_SRC;
  if (!TOKRAH_SRC) {
    throw new Error(
      "mock-api.js needs socket.io next to it or TOKRAH_SRC (Tokrah repo root)",
    );
  }
  ({ Server } = require(require("path").join(TOKRAH_SRC, "api/node_modules/socket.io")));
}

const PORT = 7070;
const HOST = "127.0.0.1";

const MOCK_USER = {
  id: "m6-user-1",
  username: "m6tester",
  name: "M6 Tester",
  gender: "MALE",
  email: "m6@sevynos.test",
  height: 180,
  birthdate: "1995-06-15",
  medias: [],
  interests: [],
  verified: true,
  authentic: false,
  onboardingComplete: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const events = []; // {kind, ...} — request + socket log, in order
// MOCK_LOG=1 (the in-guest check) also prints every event to stdout
// as `MOCK <json>` so the harness can grep the serial log for the wire.
const MOCK_LOG = process.env.MOCK_LOG === "1";
function record(ev) {
  events.push(ev);
  if (MOCK_LOG) console.log("MOCK " + JSON.stringify(ev));
}
let live = null; // the current LiveSession (or null)
let liveSeq = 0;

function liveSession(overrides) {
  return {
    id: `m6-live-${++liveSeq}`,
    title: "M6 test live",
    category: null,
    privacy: "PUBLIC",
    status: "LIVE",
    startedAt: new Date().toISOString(),
    endedAt: null,
    endedReason: null,
    summary: null,
    viewerCount: 0,
    audience: {
      hostId: MOCK_USER.id,
      host: { id: MOCK_USER.id, username: MOCK_USER.username, name: MOCK_USER.name },
      viewerCount: 0,
    },
    hostAway: null,
    participation: {
      mode: "SOLO",
      cohost: null,
      audio: { hostMutedForAudience: false, cohostMutedForAudience: false },
    },
    battle: null,
    host: { id: MOCK_USER.id, username: MOCK_USER.username, name: MOCK_USER.name },
    ...overrides,
  };
}

function credentials(session, role) {
  return {
    live: session,
    serverUrl: `http://${HOST}:${PORT}`,
    token: "m6-live-token",
    role,
    audienceHostId: MOCK_USER.id,
    following: false,
  };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const body =
    req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
      ? await readBody(req)
      : {};
  record({ kind: "http", method: req.method, path, body });

  // --- auth ---
  if (req.method === "POST" && path === "/v1/auth/login") {
    return send(res, 200, {
      accessToken: "m6-access-token",
      refreshToken: "m6-refresh-token",
      user: MOCK_USER,
    });
  }
  if (req.method === "POST" && path === "/v1/users/me") {
    return send(res, 200, { user: MOCK_USER });
  }
  if (req.method === "GET" && path === "/v1/match/filter") {
    return send(res, 200, {
      filter: {
        minAge: 18,
        maxAge: 99,
        minHeight: 100,
        maxHeight: 250,
        gender: "ALL",
        radius: 50,
        world: false,
        peopleDiscoveryEnabled: false,
        discoveryIntents: [],
      },
    });
  }

  // --- profile completion (100% complete: the banner hides) ---
  if (req.method === "GET" && path === "/v1/profile-completion") {
    return send(res, 200, {
      onboardingComplete: true,
      onboardingRequirements: {
        birthdate: true,
        gender: true,
        height: true,
        profilePhoto: true,
      },
      onboardingMissing: [],
      percentage: 100,
      checks: [
        { key: "birthdate", label: "Birthdate", complete: true },
        { key: "gender", label: "Gender", complete: true },
        { key: "height", label: "Height", complete: true },
        { key: "profilePhoto", label: "Profile photo", complete: true },
      ],
      discoverable: true,
      discoveryChecks: [],
      complete: true,
      rewarded: true,
      rewardedAt: new Date().toISOString(),
      rewardAmount: 0,
    });
  }

  // --- feed (empty, so the home tab renders) ---
  if (req.method === "POST" && path === "/v1/post/feed") {
    return send(res, 200, {
      posts: [],
      nextCursor: null,
      hasMore: false,
      sessionId: "m6",
    });
  }

  // --- live ---
  // Test-only reset: ends the current live (if any) so the next
  // headless run starts clean. Without it, phase C's still-LIVE
  // session makes the next run's home feed show the "Resume your
  // live" banner and auto-land on the live tab, shifting every
  // coordinate the check derived from the probe.
  if (req.method === "POST" && path === "/v1/live/reset") {
    if (live && live.status === "LIVE") {
      live = { ...live, status: "ENDED", endedAt: new Date().toISOString() };
      record({ kind: "live", status: "ENDED", liveId: live.id });
    }
    live = null;
    return send(res, 200, { reset: true });
  }
  if (req.method === "POST" && path === "/v1/live") {
    live = liveSession({ title: body.title || "M6 test live" });
    return send(res, 201, credentials(live, "host"));
  }
  if (req.method === "GET" && path === "/v1/live/active") {
    return send(res, 200, { lives: live && live.status === "LIVE" ? [live] : [] });
  }
  const liveIdMatch = path.match(/^\/v1\/live\/([^/]+)(\/.*)?$/);
  if (liveIdMatch) {
    const id = liveIdMatch[1];
    const rest = liveIdMatch[2] || "";
    if (!live || live.id !== id) return send(res, 404, { error: "LIVE_NOT_FOUND" });
    if (req.method === "GET" && rest === "") return send(res, 200, { live });
    if (req.method === "POST" && rest === "/join")
      return send(res, 200, credentials(live, "host"));
    if (req.method === "POST" && rest === "/end") {
      live = { ...live, status: "ENDED", endedAt: new Date().toISOString() };
      // Record the flip so the check can grep the serial log for it.
      record({ kind: "live", status: "ENDED", liveId: id });
      return send(res, 200, { live });
    }
    if (req.method === "GET" && rest === "/viewers")
      return send(res, 200, { viewers: [] });
    if (req.method === "GET" && rest === "/battles/current")
      return send(res, 200, { battle: null });
    if (req.method === "GET" && rest === "/cohost") {
      return send(res, 200, { participation: live.participation, invitation: null });
    }
    if (req.method === "GET" && rest === "/trivia/templates")
      return send(res, 200, { templates: [] });
    return send(res, 404, { error: "MOCK_NOT_IMPLEMENTED", path });
  }

  // --- everything else: empty success, logged so the driver can see it ---
  if (req.method === "GET") return send(res, 200, {});
  return send(res, 200, {});
});

// pingInterval 5s (not the socket.io default 25s): the SevynOS exec
// bridge holds each long-poll GET for at most ~8s (net fetch timeout)
// and blocks the JS thread while it runs, so a 25s server ping would
// make every poll time out, disconnect the client, and reconnect in
// a churn loop that starves the app. A 5s ping keeps each poll short
// and the client connected. (A real async host transport is the
// long-term fix; this is the mock's server-side setting.)
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 5000,
  pingTimeout: 10000,
});
io.on("connection", (socket) => {
  record({ kind: "socket", event: "connect", id: socket.id });
  socket.on("live:join", (payload) => {
    record({ kind: "socket", event: "live:join", payload });
    socket.join(`live:${payload.liveId}`);
    socket.emit("live:joined", { liveId: payload.liveId });
  });
  socket.on("live:leave", (payload) =>
    record({ kind: "socket", event: "live:leave", payload }),
  );
  socket.on("live:heartbeat", (payload) =>
    record({ kind: "socket", event: "live:heartbeat", payload }),
  );
  socket.on("live:comment", (payload, ack) => {
    record({ kind: "socket", event: "live:comment", payload });
    if (typeof ack === "function") ack(null, { success: true });
  });
  socket.on("live:reaction", (payload) =>
    record({ kind: "socket", event: "live:reaction", payload }),
  );
  socket.on("disconnect", () =>
    record({ kind: "socket", event: "disconnect", id: socket.id }),
  );
});

function start() {
  return new Promise((resolve) => server.listen(PORT, HOST, () => resolve()));
}
function stop() {
  return new Promise((resolve) => {
    io.close();
    server.close(() => resolve());
  });
}

module.exports = {
  start,
  stop,
  events,
  get live() {
    return live;
  },
  MOCK_USER,
};

// Standalone mode (the in-guest check): `node mock-api.js` starts the
// server and keeps running; events go to stdout with MOCK_LOG=1.
if (require.main === module) {
  start().then(() => {
    console.log(`MOCK mock API listening on ${HOST}:${PORT}`);
  });
}
