// SevynOS M6 — live-session driver. Boots the real Tokrah bundle in
// the mock Sevyn host, drives the UI the way a user would (click the
// email field, type credentials, tap Sign In, tap the red Go Live
// button, fill the title, confirm 18+, Start Live, End), and asserts
// the wire against the mock API: POST /v1/auth/login, POST /v1/live,
// socket live:join, POST /v1/live/:id/end. Exits 0 on a full pass.
// Usage: node drive-live.js [bundle.js]
"use strict";
const mockApi = require("./mock-api.js");
const mock = require("./mock-sevyn.js");

const BUNDLE = process.argv[2] || "./tokrah.bundle.js";

// evdev keycodes (the renderer's US map), char -> [code, shift].
const KEYMAP = {};
for (const [code, pair] of [
  [2, "1!"],
  [3, "2@"],
  [4, "3#"],
  [5, "4$"],
  [6, "5%"],
  [7, "6^"],
  [8, "7&"],
  [9, "8*"],
  [10, "9("],
  [11, "0)"],
  [12, "-_"],
  [13, "=+"],
  [16, "qQ"],
  [17, "wW"],
  [18, "eE"],
  [19, "rR"],
  [20, "tT"],
  [21, "yY"],
  [22, "uU"],
  [23, "iI"],
  [24, "oO"],
  [25, "pP"],
  [26, "[{"],
  [27, "]}"],
  [30, "aA"],
  [31, "sS"],
  [32, "dD"],
  [33, "fF"],
  [34, "gG"],
  [35, "hH"],
  [36, "jJ"],
  [37, "kK"],
  [38, "lL"],
  [39, ";:"],
  [40, "'\""],
  [41, "`~"],
  [43, "\\|"],
  [44, "zZ"],
  [45, "xX"],
  [46, "cC"],
  [47, "vV"],
  [48, "bB"],
  [49, "nN"],
  [50, "mM"],
  [51, ",<"],
  [52, ".>"],
  [53, "/?"],
  [57, "  "],
]) {
  KEYMAP[pair[0]] = [code, false];
  if (pair[1] !== pair[0]) KEYMAP[pair[1]] = [code, true];
}
const ENTER = 28,
  TAB = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastPresent = () => mock.presents[mock.presents.length - 1];
const allTexts = () => {
  const p = lastPresent();
  if (!p) return [];
  return p.ops.filter((o) => o.type === "text").map((o) => o.text);
};
function findText(sub) {
  const p = lastPresent();
  if (!p) return [];
  return p.ops.filter((o) => o.type === "text" && o.text.includes(sub));
}
// Hit-test the latest present: topmost op wins; only ops with a
// nodeId are pressable (the host resolves the node under the cursor).
function hitTest(x, y) {
  const p = lastPresent();
  if (!p) return -1;
  for (let i = p.ops.length - 1; i >= 0; i--) {
    const o = p.ops[i];
    if (o.nodeId == null || o.nodeId < 0) continue;
    if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) return o.nodeId;
  }
  return -1;
}
function clickAt(x, y) {
  const nodeId = hitTest(x, y);
  if (nodeId < 0) return false;
  mock.handlers.pointer({ type: "button", pressed: true, nodeId });
  return true;
}
function clickText(sub, which = 0) {
  const hits = findText(sub);
  if (!hits[which]) return false;
  const t = hits[which];
  return clickAt(t.x + t.w / 2, t.y + t.h / 2);
}
function findRect(color) {
  const p = lastPresent();
  if (!p) return [];
  return p.ops.filter(
    (o) =>
      o.type === "rect" &&
      typeof o.color === "string" &&
      o.color.toLowerCase() === color.toLowerCase(),
  );
}
function key(code, shift = false) {
  mock.handlers.key({ key: code, pressed: true, shift });
}
function type(str) {
  for (const ch of str) {
    const m = KEYMAP[ch];
    if (!m) throw new Error(`no keycode for ${JSON.stringify(ch)}`);
    key(m[0], m[1]);
  }
}
async function waitFor(label, fn, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timeout waiting for: ${label} (texts: ${JSON.stringify(allTexts().slice(0, 12))})`,
      );
    await sleep(150);
  }
}
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await mockApi.start();
  console.log("[driver] mock API on 127.0.0.1:7070");
  require(BUNDLE);

  // 1 — login screen
  await waitFor("login screen", () => findText("Sign In to Tokrah").length > 0);
  check("login screen renders", true, allTexts().slice(0, 4).join(" | "));

  // 2 — type credentials and sign in (click each field directly: Tab
  // order includes icon pressables between the inputs).
  if (!clickText("you@example.com")) throw new Error("email field not found");
  type("m6@sevynos.test");
  if (!clickText("Enter your password")) throw new Error("password field not found");
  type("M6pass123!");
  // The submit "Sign In" is the lowest "Sign In" text on screen.
  const signIns = findText("Sign In");
  if (!clickText("Sign In", signIns.length - 1))
    throw new Error("Sign In button not found");
  await waitFor("login request", () =>
    mockApi.events.some(
      (e) => e.kind === "http" && e.method === "POST" && e.path === "/v1/auth/login",
    ),
  );
  check("POST /v1/auth/login", true);
  await waitFor(
    "home feed (Go Live button)",
    () => findRect("#E52B42").length > 0,
    20000,
  );
  check("home feed renders after login", true);

  // 3 — go live
  const red = findRect("#E52B42")[0];
  if (!clickAt(red.x + red.w / 2, red.y + red.h / 2))
    throw new Error("Go Live button not hittable");
  await waitFor(
    "go-live screen",
    () => findText("Go Live").length > 0 && findText("Start Live").length > 0,
  );
  check("go-live screen renders", true);
  if (!clickText("What’s happening?")) throw new Error("title field not found");
  type("M6 test live");
  if (!clickText("I confirm I’m at least 18 years old."))
    throw new Error("age checkbox not found");
  await sleep(300);
  if (!clickText("Start Live")) throw new Error("Start Live button not found");
  await waitFor("startLive request", () =>
    mockApi.events.some(
      (e) => e.kind === "http" && e.method === "POST" && e.path === "/v1/live",
    ),
  );
  check("POST /v1/live (startLive)", true);
  await waitFor("socket live:join", () =>
    mockApi.events.some((e) => e.kind === "socket" && e.event === "live:join"),
  );
  check("socket live:join", true);
  await waitFor("host screen", () => findText("End").length > 0, 20000);
  check("live host screen renders", true, `live id ${mockApi.live && mockApi.live.id}`);
  await sleep(500);

  // 4 — end the live
  if (!clickText("End")) throw new Error("End button not found");
  await waitFor("end confirm modal", () => findText("End live").length > 0);
  if (!clickText("End live", findText("End live").length - 1))
    throw new Error("confirm End live not found");
  await waitFor("endLive request", () =>
    mockApi.events.some(
      (e) =>
        e.kind === "http" && e.method === "POST" && e.path === "/v1/live/m6-live-1/end",
    ),
  );
  check("POST /v1/live/:id/end (endLive)", true);
  check(
    "live status ENDED on mock",
    mockApi.live && mockApi.live.status === "ENDED",
    mockApi.live && mockApi.live.status,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (mock.logs.length) {
    console.log("--- host logs (last 10) ---");
    for (const l of mock.logs.slice(-10)) console.log(`  ${l}`);
  }
  await mockApi.stop();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`DRIVER ERROR: ${err.message}`);
  console.log("texts on screen:", JSON.stringify(allTexts()));
  if (mock.logs.length) {
    console.log("--- host logs (last 10) ---");
    for (const l of mock.logs.slice(-10)) console.log(`  ${l}`);
  }
  process.exit(2);
});
