"use strict";
// End-to-end Node test for the built app bundles (dist/app.js,
// dist/terminal.js, dist/settings.js, dist/files.js, dist/browser.js,
// dist/comms.js, dist/camera.js, dist/music.js) and the crash bundle
// (dist/crash.js). Loads the app bundle with the mock Sevyn host as
// several apps — files (status.read granted, the fallback screen)
// and notes/calculator/calendar/store (the M9 real screens) — and
// drives the close X. The crash bundle
// must throw during evaluation. The M4 apps load with cli.exec and a
// canned exec handler, and drive their real flows (terminal typing,
// settings channel switch + AI selection, files navigation). The M5
// Browser loads with cli.exec and a canned CDP-backed exec handler,
// and drives its real flow (tabs on mount, address-bar navigation).
// The M10 comms bundle loads as messages / video-calls / voice-calls
// with a canned `sevyn comms` handler: login form, room list, thread
// + send, and the call screens (the async login/send run in the
// async section at the end — the mock's execAsync resolves on a
// microtask, so those checks await a setImmediate flush). The
// Camera bundle loads with cli.exec + the camera permission and a
// canned `sevyn camera` handler: first-use Allow screen, no-device
// state, and the live flow (preview image op, shutter, gallery,
// viewer decode). The camera preview polls on a 1s interval — the
// async camera check unmounts at the end so the interval cannot
// keep the process alive; the sync camera checks never start it
// (no consent, or no device). The Music bundle loads with cli.exec
// and talks to the mock's fake in-memory audiod (Sevyn._audio)
// through the SevynAudio adapter — no `sevyn music` CLI anywhere:
// the scan lists the fake's 2 tracks, play/pause/resume/stop/seek/
// volume drive the fake's state, and the 1 s position poll reads it
// back. A scan failure is scripted by stubbing Sevyn.audioScan per
// check (restored after), and the files-list fallback answers
// through a canned `sevyn files` handler. The async music checks
// unmount at the end so the interval cannot keep the process alive.
//
// Run: node test/app-e2e-test.js   (from v2/apps, after npm run build)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Sevyn = require("../../rn/renderer/test/mock-sevyn");
const renderer = require("../../rn/renderer/sevyn-renderer");
global.Sevyn = Sevyn;
// Hermes has no setTimeout-driven microtask queue issues here; the
// bundle only needs the globals the host provides.
global.queueMicrotask = global.queueMicrotask || ((fn) => Promise.resolve().then(fn));

const appBundle = fs.readFileSync(path.join(__dirname, "..", "dist", "app.js"), "utf8");
const terminalBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "terminal.js"),
  "utf8",
);
const settingsBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "settings.js"),
  "utf8",
);
const filesBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "files.js"),
  "utf8",
);
const browserBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "browser.js"),
  "utf8",
);
const commsBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "comms.js"),
  "utf8",
);
const cameraBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "camera.js"),
  "utf8",
);
const musicBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "music.js"),
  "utf8",
);
const crashBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "crash.js"),
  "utf8",
);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

function textsOf(present) {
  return present.ops.filter((o) => o.type === "text").map((o) => o.text);
}

// Load the app bundle as one app identity (host-provided globals).
// execHandler answers Sevyn.exec calls (set BEFORE the bundle runs:
// Settings/Files exec during mount).
function loadAs(app, bundleSrc, execHandler) {
  renderer.unmount();
  Sevyn._reset();
  Sevyn.appId = app.id;
  Sevyn.appName = app.name;
  Sevyn.appColor = app.color;
  Sevyn.appGlyph = app.glyph;
  Sevyn.hasPermission = (name) => app.permissions.includes(name);
  if (execHandler) Sevyn._execHandler = execHandler;
  vm.runInThisContext(bundleSrc || appBundle, { filename: "app.js" });
  return Sevyn._presents[Sevyn._presents.length - 1];
}

// Key helpers (evdev codes; the renderer's US keymap).
const KEY_FOR = {
  a: [30, false],
  b: [48, false],
  c: [46, false],
  d: [32, false],
  e: [18, false],
  f: [33, false],
  g: [34, false],
  h: [35, false],
  i: [23, false],
  j: [36, false],
  k: [37, false],
  l: [38, false],
  m: [50, false],
  n: [49, false],
  o: [24, false],
  p: [25, false],
  q: [16, false],
  r: [19, false],
  s: [31, false],
  t: [20, false],
  u: [22, false],
  v: [47, false],
  w: [17, false],
  x: [45, false],
  y: [21, false],
  z: [44, false],
  " ": [57, false],
  "/": [53, false],
  ".": [52, false],
  "-": [12, false],
  ":": [39, true],
  _: [12, true],
  0: [11, false],
  1: [2, false],
  2: [3, false],
  3: [4, false],
  4: [5, false],
  5: [6, false],
  6: [7, false],
  7: [8, false],
  8: [9, false],
  9: [10, false],
};
function type(text) {
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") {
      const [code] = KEY_FOR[ch.toLowerCase()];
      Sevyn._handlers.key({ key: code, pressed: true, shift: true });
    } else {
      const [code, shift] = KEY_FOR[ch];
      Sevyn._handlers.key({ key: code, pressed: true, shift });
    }
  }
}
function pressEnter() {
  Sevyn._handlers.key({ key: 28, pressed: true });
}
function pressCtrlC() {
  Sevyn._handlers.key({ key: 46, pressed: true, ctrl: true });
}
function pressTab(n) {
  for (let i = 0; i < n; i++) Sevyn._handlers.key({ key: 15, pressed: true });
}

check("files (status.read): name, glyph, live status line", () => {
  const last = loadAs({
    id: "files",
    name: "Files",
    color: "#3b82f6",
    glyph: "F",
    permissions: ["status.read"],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Files"), "app name shown");
  assert.ok(texts.includes("F"), "glyph shown");
  assert.ok(
    texts.some((t) => t.includes("87%")),
    "live battery in status line",
  );
  assert.ok(
    texts.some((t) => t.includes("Wi-Fi")),
    "live wifi in status line",
  );
  const header = last.ops.find(
    (o) => o.type === "rect" && o.color === "#3b82f6" && o.h === 44,
  );
  assert.ok(header, "header uses the app colour");
});

// M9: the template apps have real screens now. The permission gate
// is proven by the music empty state (which still shows the status
// line) and the fallback screen; notes shows its real UI instead.
check("notes: real notes screen, no status leak", () => {
  const last = loadAs({
    id: "notes",
    name: "Notes",
    color: "#eab308",
    glyph: "N",
    permissions: [],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Notes"), "app name shown");
  assert.ok(texts.includes("New note"), "new-note button shown");
  assert.ok(
    texts.some((t) => t.includes("No notes yet")),
    "empty notes state shown",
  );
  assert.ok(
    !texts.some((t) => t.includes("87%")),
    "no live status leaks without the permission",
  );
});

// Find in note (gap unit 5, audit #6): Ctrl+F opens the find bar,
// typing selects the first match, Enter cycles (wrapping),
// Shift+Enter goes back, a query with no match changes nothing,
// an empty query clears the match, Esc closes and returns focus to
// the note, and the Find button reopens the bar. The note body is
// "buy milk and bread\nbuy milk again\n": "milk" matches [4,8) and
// [23,27).
function pressCtrl(code) {
  Sevyn._handlers.key({ key: code, pressed: true, ctrl: true });
}
function pressShiftEnter() {
  Sevyn._handlers.key({ key: 28, pressed: true, shift: true });
}
function pressEscape() {
  Sevyn._handlers.key({ key: 1, pressed: true });
}
function pressBackspace() {
  Sevyn._handlers.key({ key: 14, pressed: true });
}
function findHighlights() {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  return last.ops.filter((o) => o.type === "rect" && o.color === "#3b82f680");
}
// The note's match highlight is one rect on the match's row: match 1
// sits on row 0, match 2 on row 1 (line height 15 * 1.25 = 18.75),
// so the highlight's y tells the matches apart — the test asserts
// the row, not the instance state (the bundle's renderer is its own
// module copy, so the test cannot read instance fields).
function highlightRowY() {
  const hs = findHighlights();
  assert.equal(hs.length, 1, "exactly one highlight rect");
  return hs[0].y;
}

check("notes find: Ctrl+F, type, Enter cycles, Shift+Enter, Esc", () => {
  const handler = (cmd) => {
    if (cmd === "sevyn files list /data/notes") return "0\nf Shopping\n";
    if (cmd === "sevyn files cat /data/notes/Shopping")
      return "0\nbuy milk and bread\nbuy milk again\n";
    return "0\n";
  };
  loadAs(
    {
      id: "notes",
      name: "Notes",
      color: "#eab308",
      glyph: "N",
      permissions: ["cli.exec"],
    },
    appBundle,
    handler,
  );
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Shopping"), "seeded note listed");
  tapText("Shopping", 15);
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("buy milk and bread")),
    "note body loaded from /data/notes",
  );

  // Ctrl+F opens the find bar and focuses its field.
  pressCtrl(33); // Ctrl+F
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Find in note"), "find field opened");

  // Typing selects the first match (row 0).
  type("milk");
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("1 of 2"), "match count shown");
  const row0 = highlightRowY();
  assert.ok(findHighlights().length >= 1, "match highlighted while find has focus");

  // Enter cycles to the next match (row 1), then wraps to the first.
  pressEnter();
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("2 of 2"), "count advanced");
  assert.equal(highlightRowY(), row0 + 18.75, "second match selected, one row down");
  pressEnter();
  assert.equal(highlightRowY(), row0, "Enter wrapped to the first match");

  // Shift+Enter goes back to the previous match.
  pressShiftEnter();
  assert.equal(highlightRowY(), row0 + 18.75, "Shift+Enter went back");

  // A query with no match is reported honestly: the count says so
  // and the selection does not move.
  pressCtrl(30); // Ctrl+A in the find field, then replace the query
  type("zzz");
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("No matches"), "no-match reported");
  assert.equal(highlightRowY(), row0 + 18.75, "no match leaves the selection untouched");

  // An empty query clears the match: no highlight at all.
  pressCtrl(30); // Ctrl+A in the find field
  pressBackspace();
  assert.equal(findHighlights().length, 0, "empty query cleared the highlight");

  // Esc closes the bar and returns focus to the note: typing lands
  // in the note again, at the end.
  pressEscape();
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(!texts.includes("Find in note"), "find field closed");
  type("x");
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("buy milk again\nx")),
    "typing after Esc went back into the note",
  );

  // The Find button reopens the bar.
  tapText("Find", 15);
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Find in note"), "Find button reopened the bar");
});

// Save in note (gap unit 6, audit #7): Ctrl+S writes the current
// note to its backing file and shows "Saved."; pressing it again
// with no changes still reports saved (the same content is written
// again — idempotent, no corruption); editing clears the "Saved."
// line, and a save after the edit writes the new content.
check("notes save: Ctrl+S writes, Saved shown, no-change save, edit then save", () => {
  const writes = [];
  const handler = (cmd) => {
    if (cmd === "sevyn files list /data/notes") return "0\nf Shopping\n";
    if (cmd === "sevyn files cat /data/notes/Shopping")
      return "0\nbuy milk and bread\nbuy milk again\n";
    if (cmd === "sevyn files mkdir /data/notes") return "0\n";
    if (cmd.startsWith("sevyn files write /data/notes/")) {
      writes.push(cmd);
      return "0\n";
    }
    return "0\n";
  };
  loadAs(
    {
      id: "notes",
      name: "Notes",
      color: "#eab308",
      glyph: "N",
      permissions: ["cli.exec"],
    },
    appBundle,
    handler,
  );
  tapText("Shopping", 15);
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("buy milk and bread")),
    "note body loaded from /data/notes",
  );

  // Ctrl+S with no changes: writes the note, shows "Saved.".
  pressCtrl(31); // Ctrl+S
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Saved."), "Saved feedback shown");
  assert.equal(writes.length, 1, "one write for the first save");
  assert.ok(
    writes[0].includes("buy milk and bread"),
    "first save wrote the current note content",
  );

  // Ctrl+S again with no changes: still reports saved, same
  // content rewritten — no crash, no duplicate-write corruption.
  pressCtrl(31); // Ctrl+S
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Saved."), "no-change save still reports saved");
  assert.equal(writes.length, 2, "no-change save rewrote the note");
  assert.equal(writes[1], writes[0], "no-change save wrote identical content");

  // Editing clears the "Saved." line; a save after the edit writes
  // the new content and shows "Saved." again.
  pressCtrl(30); // Ctrl+A — select all, so the edit is caret-independent
  type("fresh words");
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(!texts.includes("Saved."), "editing cleared the Saved feedback");
  pressCtrl(31); // Ctrl+S
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Saved."), "Saved feedback shown after the edit");
  assert.equal(writes.length, 3, "save after edit wrote again");
  assert.ok(writes[2].includes("fresh words"), "save after edit wrote the new content");
  assert.ok(!writes[2].includes("buy milk"), "old content replaced, not appended");
});

check("music (no permission): status line says not permitted", () => {
  const last = loadAs({
    id: "music",
    name: "Music",
    color: "#ec4899",
    glyph: "M",
    permissions: [],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Music"), "app name shown");
  assert.ok(
    texts.some((t) => t.includes("not permitted")),
    "status line says not permitted",
  );
  assert.ok(
    !texts.some((t) => t.includes("87%")),
    "no live status leaks without the permission",
  );
});

check("music (status.read): live status line", () => {
  const last = loadAs({
    id: "music",
    name: "Music",
    color: "#ec4899",
    glyph: "M",
    permissions: ["status.read"],
  });
  const texts = textsOf(last);
  assert.ok(
    texts.some((t) => t.includes("87%")),
    "live battery in status line",
  );
  assert.ok(
    texts.some((t) => t.includes("Wi-Fi")),
    "live wifi in status line",
  );
});

// Tap a key by its label: find the text op, then the pressable rect
// containing its centre (keys are fontSize 20; the calculator
// display is 32, so the two never collide).
function tapText(label, fontSize) {
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  const text = present.ops.find(
    (o) => o.type === "text" && o.text === label && o.fontSize === fontSize,
  );
  assert.ok(text, `text ${JSON.stringify(label)} found`);
  const cx = text.x + text.w / 2;
  const cy = text.y + text.h / 2;
  const rect = present.ops.find(
    (o) =>
      o.type === "rect" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      cx >= o.x &&
      cx < o.x + o.w &&
      cy >= o.y &&
      cy < o.y + o.h,
  );
  assert.ok(rect, `pressable for ${JSON.stringify(label)} found`);
  Sevyn._handlers.pointer({
    type: "button",
    x: cx,
    y: cy,
    button: 1,
    pressed: true,
    nodeId: rect.nodeId,
  });
}

check("calculator: 2 + 3 = 5", () => {
  loadAs({
    id: "calculator",
    name: "Calculator",
    color: "#8b5cf6",
    glyph: "=",
    permissions: [],
  });
  tapText("2", 20);
  tapText("+", 20);
  tapText("3", 20);
  tapText("=", 20);
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  assert.ok(
    last.ops.some((o) => o.type === "text" && o.text === "5" && o.fontSize === 32),
    "display reads 5",
  );
});

check("calendar: current month shown", () => {
  const last = loadAs({
    id: "calendar",
    name: "Calendar",
    color: "#ef4444",
    glyph: "C",
    permissions: [],
  });
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });
  const texts = textsOf(last);
  assert.ok(
    texts.some((t) => t.includes(month) && t.includes(String(now.getFullYear()))),
    `month title shows ${month} ${now.getFullYear()}`,
  );
  assert.ok(
    texts.some((t) => t === String(now.getDate())),
    "today is on the grid",
  );
});

check("store: installed apps listed", () => {
  const last = loadAs({
    id: "store",
    name: "Store",
    color: "#f97316",
    glyph: "S",
    permissions: [],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Installed apps"), "store title shown");
  assert.ok(texts.includes("Settings"), "settings in the list");
  assert.ok(texts.includes("Terminal"), "terminal in the list");
});

check("close X calls Sevyn.closeApp()", () => {
  const last = loadAs({
    id: "files",
    name: "Files",
    color: "#3b82f6",
    glyph: "F",
    permissions: ["status.read"],
  });
  // The title bar has three pressables (— / ▢ / ✕, each 28x28);
  // the X is the rightmost.
  const pressables = last.ops.filter(
    (o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect",
  );
  assert.equal(pressables.length, 3, "three title-bar buttons (— ▢ ✕)");
  for (const b of pressables) {
    assert.equal(b.w, 28, "title-bar button is 28 wide");
  }
  const x = pressables.reduce((a, b) => (b.x > a.x ? b : a));
  Sevyn._handlers.pointer({
    type: "button",
    x: x.x + 2,
    y: x.y + 2,
    button: 1,
    pressed: true,
    nodeId: x.nodeId,
  });
  assert.ok(
    Sevyn._logs.includes("CLOSEAPP"),
    "closeApp called, logs=" + JSON.stringify(Sevyn._logs),
  );
});

check("crash bundle throws during evaluation", () => {
  assert.throws(
    () => vm.runInThisContext(crashBundle, { filename: "crash.js" }),
    /intentional startup failure/,
  );
});

// --- M4 system apps ------------------------------------------------------
const SETTINGS_JSON =
  '{\n  "terminal.integrated.defaultProfile.linux": "sevyn",\n' +
  '  "terminal.integrated.profiles.linux": {\n' +
  '    "sevyn": { "path": "/usr/local/bin/sevyn" }\n  }\n}\n';

check("terminal: help on mount, typing runs sevyn commands", () => {
  const handler = (cmd) => {
    if (cmd === "sevyn shell status") return "0\nshell: running (pid 123)\n";
    if (cmd === "sevyn update status") return "0\nversion=1 channel=nightly active=A\n";
    if (cmd === "sevyn code status")
      return (
        "0\nrunning: yes\nserving: yes\nurl: http://127.0.0.1:8080\n" +
        "version: 4.105.0\nterminal-profile: sevyn\n" +
        "terminal-shell: /usr/local/bin/sevyn\n"
      );
    if (cmd === "sevyn files cat /root/.local/share/code-server/User/settings.json")
      return "0\n" + SETTINGS_JSON;
    if (cmd === "sevyn ai status")
      return "0\nselected=echo-ai backends=echo-ai,plan-ai god_mode=off\n";
    if (cmd === "sevyn ai ask launch files")
      return "0\nbackend=echo-ai allowed=1 denied=0 failed=0\n";
    return "0\n";
  };
  loadAs(
    {
      id: "terminal",
      name: "Terminal",
      color: "#111827",
      glyph: ">",
      permissions: ["cli.exec"],
    },
    terminalBundle,
    handler,
  );
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("No bash")),
    "static help shown on mount",
  );
  type("shell status");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("EXEC sevyn shell status"),
    "exec called, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("sevyn> shell status"), "command echoed");
  assert.ok(texts.includes("shell: running (pid 123)"), "command output shown");
  type("update status");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("TERMINAL update-status channel=nightly"),
    "update-status marker logged",
  );
  type("code status");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes(
      "TERMINAL code-status running=yes serving=yes terminal-shell=/usr/local/bin/sevyn",
    ),
    "code-status marker logged",
  );
  type("files cat /root/.local/share/code-server/User/settings.json");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("TERMINAL settings-json defaultProfile=sevyn"),
    "settings-json marker logged",
  );
  type("ai status");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("TERMINAL ai-status selected=echo-ai god_mode=off"),
    "ai-status marker logged",
  );
  type("ai ask launch files");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("TERMINAL ai-ask allowed=1 denied=0"),
    "ai-ask marker logged",
  );
  // P2: the audit marker — the harness has no audit log, so the
  // count is 0, but the marker path is proven.
  type("ai audit");
  pressEnter();
  assert.ok(Sevyn._logs.includes("TERMINAL ai-audit lines=0"), "ai-audit marker logged");
});

check("terminal: without cli.exec the command is refused", () => {
  loadAs(
    {
      id: "notes",
      name: "Notes",
      color: "#eab308",
      glyph: "N",
      permissions: [],
    },
    terminalBundle,
    () => {
      throw new Error("exec must not reach the handler without cli.exec");
    },
  );
  type("shell status");
  pressEnter();
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("permission denied")),
    "refusal shown in the scrollback",
  );
});

check("terminal: Ctrl+C cancels the typed line, empty-prompt Ctrl+C is harmless", () => {
  loadAs(
    {
      id: "terminal",
      name: "Terminal",
      color: "#111827",
      glyph: ">",
      permissions: ["cli.exec"],
    },
    terminalBundle,
    (cmd) => {
      if (cmd === "sevyn shell status") return "0\nshell: running (pid 123)\n";
      return "0\n";
    },
  );
  // Clipboard sentinel: Ctrl+C in Terminal is interrupt, never copy.
  Sevyn.clipboardWrite("sentinel");
  type("shell status");
  pressCtrlC();
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.includes("sevyn> shell status^C"),
    "interrupted line echoed with ^C, texts=" + JSON.stringify(texts),
  );
  assert.ok(!texts.includes("shell status"), "input cleared by the interrupt");
  assert.equal(Sevyn.clipboardRead(), "sentinel", "Ctrl+C copied nothing");
  assert.ok(
    !Sevyn._logs.some((l) => l.startsWith("EXEC ")),
    "no command ran for the cancelled line",
  );
  // The prompt is fresh: a normal command still runs to completion.
  type("shell status");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("EXEC sevyn shell status"),
    "fresh command runs after the interrupt",
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("shell: running (pid 123)"), "command output shown");
  // Ctrl+C at an empty prompt: harmless — echoes ^C, runs nothing.
  const execsBefore = Sevyn._logs.filter((l) => l.startsWith("EXEC ")).length;
  pressCtrlC();
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("sevyn> ^C"), "empty-prompt interrupt echoed");
  assert.equal(
    Sevyn._logs.filter((l) => l.startsWith("EXEC ")).length,
    execsBefore,
    "empty-prompt Ctrl+C ran no command",
  );
  assert.equal(Sevyn.clipboardRead(), "sentinel", "still nothing copied");
});

check("settings: channel switch applies and logs", () => {
  let channel = "nightly";
  let aiSelected = "echo-ai";
  const handler = (cmd) => {
    if (cmd === "sevyn update status")
      return `0\nversion=1 channel=${channel} active=A\n`;
    if (cmd === "sevyn update channel stable") {
      channel = "stable";
      return "0\n";
    }
    if (cmd === "sevyn update channel nightly") {
      channel = "nightly";
      return "0\n";
    }
    if (cmd === "sevyn ai list")
      return `0\nselected=${aiSelected} backends=echo-ai,plan-ai\n`;
    if (cmd === "sevyn ai select plan-ai") {
      aiSelected = "plan-ai";
      return "0\nselected plan-ai\n";
    }
    if (cmd === "sevyn ai select echo-ai") {
      aiSelected = "echo-ai";
      return "0\nselected echo-ai\n";
    }
    if (cmd === "sevyn code status")
      return "0\nrunning: yes\nserving: yes\nversion: 4.105.0\nterminal-shell: /usr/local/bin/sevyn\n";
    if (cmd === "sevyn ai relay status")
      return "0\nrelay agent: disabled\nagent: not running\npaired: unpaired\ndaemon relay: off\n";
    return "0\n";
  };
  loadAs(
    {
      id: "settings",
      name: "Settings",
      color: "#6b7280",
      glyph: "S",
      permissions: ["cli.exec"],
    },
    settingsBundle,
    handler,
  );
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Channel: nightly"), "current channel shown");
  assert.ok(
    texts.some((t) => t.includes("running: yes")),
    "code status shown",
  );
  assert.ok(texts.includes("AI: echo-ai"), "current AI shown");
  assert.ok(texts.includes("echo-ai"), "echo-ai button shown");
  assert.ok(texts.includes("plan-ai"), "plan-ai button shown");
  // 1b: the relay section renders (off in the harness — the e2e
  // handler does not cover `tailscale status`, so it returns
  // "0\n" and the relay reads off), with the join form.
  assert.ok(texts.includes("AI relay"), "relay section shown");
  assert.ok(texts.includes("Relay: off"), "relay off shown");
  assert.ok(texts.includes("Join tailnet"), "relay join button shown");
  // Phase 2: the relay-agent block renders (disabled in the harness
  // — the stub above returns agent disabled / unpaired / session
  // off), with its toggle and Forget button.
  assert.ok(texts.includes("Relay agent"), "relay agent section shown");
  assert.ok(texts.includes("Relay agent: disabled"), "relay agent status shown");
  assert.ok(texts.includes("Turn relay agent on"), "relay agent toggle shown");
  assert.ok(texts.includes("Forget this pairing"), "relay agent forget shown");
  assert.ok(texts.includes("Power"), "power section shown");
  assert.ok(texts.includes("Shut Down"), "power shut down button shown");
  assert.ok(texts.includes("Restart"), "power restart button shown");
  assert.ok(texts.includes("Date & Time"), "date & time section shown");
  assert.ok(texts.includes("Sync Now"), "time sync button shown");
  // M9: the Wi-Fi Scan button is the second focusable, so the order
  // is [—, ▢, X, Scan, Nightly, Stable, echo-ai, plan-ai, Shut Down,
  // Restart] (the two window buttons lead the title bar; the power
  // buttons are the last two). #134's Date & Time section sits after
  // the channel buttons, so it adds three focusables there (Sync Now,
  // the timezone input, Apply): the order is now [—, ▢, X, Scan,
  // Nightly, Stable, Sync Now, Timezone, Apply, echo-ai, plan-ai,
  // Shut Down, Restart, Default, Solid, Cosmic, Minimal] — the
  // Appearance section sits after Power, so it appends four
  // focusables at the end (eight more swatches when Solid is picked).
  // P0's Muse API key section adds three focusables in the AI
  // section, after plan-ai and before Shut Down (the key input,
  // Save key, Clear key), so the full order is [—, ▢, X, Scan,
  // Nightly, Stable, Sync Now, Timezone, Apply, echo-ai, plan-ai,
  // key input, Save key, Clear key, Shut Down, Restart, Default,
  // Solid, Cosmic, Minimal, macOS, macOS Light] — 22 focusables.
  // P2's god-mode toggle adds one more in the AI section, after
  // Clear key and before Shut Down, so the order is [—, ▢, X, Scan,
  // Nightly, Stable, Sync Now, Timezone, Apply, echo-ai, plan-ai,
  // key input, Save key, Clear key, God toggle, Shut Down, Restart,
  // Default, Solid, Cosmic, Minimal, macOS, macOS Light] — 23.
  // 1b's relay section adds three more in the AI section, after
  // the God toggle and before Shut Down (the login-server input,
  // the auth-key input, Join), so the order is [—, ▢, X, Scan,
  // Nightly, Stable, Sync Now, Timezone, Apply, echo-ai, plan-ai,
  // key input, Save key, Clear key, God toggle, login server,
  // auth key, Join, Shut Down, Restart, Default, Solid, Cosmic,
  // Minimal, macOS, macOS Light] — 26.
  // Phase 2's relay-agent block adds two more in the AI section,
  // after Join and before Shut Down (the agent toggle, Forget this
  // pairing), so the order is [—, ▢, X, Scan, Nightly, Stable,
  // Sync Now, Timezone, Apply, echo-ai, plan-ai, key input, Save
  // key, Clear key, God toggle, login server, auth key, Join,
  // Agent toggle, Forget, Shut Down, Restart, Default, Solid,
  // Cosmic, Minimal, macOS, macOS Light] — 28. (The enable,
  // pairing, and revoke dialogs' buttons exist only while open, so
  // they never shift the count.)
  pressTab(6); // —, ▢, X, Scan, Nightly, Stable
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("SETTINGS channel=stable"),
    "channel apply logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Channel: stable"), "new channel shown");
  assert.ok(
    texts.some((t) => t.includes("Channel set to stable.")),
    "confirmation shown",
  );
  // Focus order is now [—, ▢, X, Scan, Nightly, Stable, Sync Now,
  // Timezone, Apply, echo-ai, plan-ai, key input, Save key, Clear key,
  // God toggle, login server, auth key, Join, Agent toggle, Forget,
  // Shut Down, Restart, Default, Solid, Cosmic, Minimal, macOS,
  // macOS Light]: Stable -> Sync Now -> Timezone -> Apply -> echo-ai
  // -> plan-ai -> key input -> Save key -> Clear key -> God toggle ->
  // login server -> auth key -> Join -> Agent toggle -> Forget ->
  // Shut Down -> Restart -> Default -> Solid -> Cosmic -> Minimal ->
  // macOS -> macOS Light -> — -> ▢ -> X -> Scan -> Nightly. Stable
  // is 6th, Nightly 5th, so 27 Tabs wrap back to Nightly.
  pressTab(27);
  pressEnter();
  assert.ok(Sevyn._logs.includes("SETTINGS channel=nightly"), "channel switched back");
  // Nightly -> Stable -> Sync Now -> Timezone -> Apply -> echo-ai ->
  // plan-ai: swap the AI through the same Settings surface, no code
  // change.
  pressTab(6);
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("SETTINGS ai=plan-ai"),
    "AI select logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("AI: plan-ai"), "new AI shown");
  assert.ok(
    texts.some((t) => t.includes("AI set to plan-ai.")),
    "AI confirmation shown",
  );
});

// Clipboard (gap unit 2): the known hit from the audit — the masked
// Muse API key field accepts a pasted key. The mock clipboard stands
// in for another app's copy: the key arrives through the host
// clipboard (Sevyn.clipboardRead), not the keyboard, and the save
// path proves the pasted value — not a typed one — reaches the
// backend. (The key itself is a fake test string.)
check("settings: paste a Muse API key with Ctrl+V, save it", () => {
  const seen = [];
  const handler = (cmd) => {
    seen.push(cmd);
    if (cmd === "sevyn update status") return "0\nversion=1 channel=nightly active=A\n";
    if (cmd === "sevyn ai list") return "0\nselected=echo-ai backends=echo-ai,plan-ai\n";
    if (cmd === "sevyn code status")
      return "0\nrunning: yes\nserving: yes\nversion: 4.105.0\nterminal-shell: /usr/local/bin/sevyn\n";
    if (cmd === "sevyn ai relay status")
      return "0\nrelay agent: disabled\nagent: not running\npaired: unpaired\ndaemon relay: off\n";
    return "0\n";
  };
  loadAs(
    {
      id: "settings",
      name: "Settings",
      color: "#6b7280",
      glyph: "S",
      permissions: ["cli.exec"],
    },
    settingsBundle,
    handler,
  );
  Sevyn.clipboardWrite("sk-test-pasted-key-123");
  // Focus order (see the channel check above): the Muse API key
  // input is the 12th focusable.
  pressTab(12);
  Sevyn._handlers.key({ key: 47, pressed: true, ctrl: true }); // Ctrl+V
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t === "•".repeat(22)),
    "pasted key shown masked (22 bullets), texts=" + JSON.stringify(texts),
  );
  pressTab(1); // Save key
  pressEnter();
  assert.ok(
    seen.includes('sevyn files write /tmp/muse-key.tmp "sk-test-pasted-key-123"'),
    "pasted key written to the temp file, seen=" + JSON.stringify(seen),
  );
  assert.ok(
    seen.includes("sevyn ai key --file /tmp/muse-key.tmp"),
    "key handed to sevyn ai key --file",
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Muse API key saved.")),
    "save confirmed",
  );
});

check("settings: wallpaper style + color apply and log", () => {
  let channel = "nightly";
  let aiSelected = "echo-ai";
  let wallpaperStyle = "default";
  let wallpaperColor = "#090b11";
  const handler = (cmd) => {
    if (cmd === "sevyn update status")
      return `0\nversion=1 channel=${channel} active=A\n`;
    if (cmd === "sevyn ai list")
      return `0\nselected=${aiSelected} backends=echo-ai,plan-ai\n`;
    if (cmd === "sevyn code status")
      return "0\nrunning: yes\nserving: yes\nversion: 4.105.0\\nterminal-shell: /usr/local/bin/sevyn\\n";
    if (cmd === "sevyn settings get wallpaperStyle")
      return `0\nwallpaperStyle=${wallpaperStyle}\n`;
    if (cmd === "sevyn settings get wallpaperColor")
      return `0\nwallpaperColor=${wallpaperColor}\n`;
    if (cmd.startsWith("sevyn settings set wallpaperStyle ")) {
      wallpaperStyle = cmd.slice("sevyn settings set wallpaperStyle ".length);
      return "0\n";
    }
    if (cmd.startsWith("sevyn settings set wallpaperColor ")) {
      wallpaperColor = cmd.slice("sevyn settings set wallpaperColor ".length);
      return "0\n";
    }
    return "0\n";
  };
  loadAs(
    {
      id: "settings",
      name: "Settings",
      color: "#6b7280",
      glyph: "S",
      permissions: ["cli.exec"],
    },
    settingsBundle,
    handler,
  );
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Appearance"), "appearance section shown");
  assert.ok(texts.includes("Default"), "default style button shown");
  assert.ok(texts.includes("Solid"), "solid style button shown");
  assert.ok(texts.includes("Cosmic"), "cosmic style button shown");
  assert.ok(texts.includes("Minimal"), "minimal style button shown");
  assert.ok(texts.includes("macOS"), "macos style button shown");
  assert.ok(texts.includes("macOS Light"), "macos-light style button shown");
  assert.ok(
    texts.some((t) => t.includes("Uploading your own photo is not supported yet")),
    "no-custom-image note shown under the Appearance intro",
  );
  // Focus order is [—, ▢, X, Scan, Nightly, Stable, Sync Now,
  // Timezone, Apply, echo-ai, plan-ai, key input, Save key, Clear key,
  // God toggle, login server, auth key, Join, Agent toggle, Forget,
  // Shut Down, Restart, Default, Solid, Cosmic, Minimal, macOS,
  // macOS Light]: Default is the 23rd focusable.
  pressTab(23);
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("SETTINGS wallpaperStyle=default"),
    "style apply logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  pressTab(1); // Solid
  pressEnter();
  assert.ok(Sevyn._logs.includes("SETTINGS wallpaperStyle=solid"), "solid style logged");
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Color: Sevyn Night")),
    "current color shown once solid is picked",
  );
  // Swatches join the focus order after macOS Light: Solid -> Cosmic ->
  // Minimal -> macOS -> macOS Light -> Sevyn Night -> Slate.
  pressTab(6);
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("SETTINGS wallpaperColor=#1E293B"),
    "color apply logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Color: Slate")),
    "new color shown",
  );
  assert.ok(
    texts.some((t) => t.includes("Applies when Settings closes.")),
    "applies-on-close note shown",
  );
});

// Phase 2: the relay-agent pairing dialog renders while a pending
// pairing exists (peer fingerprint short form + pairing code +
// Confirm / Dismiss), the agent banner names the enabled agent, and
// an audit line carrying via=relay shows the "remote" badge. No Tab
// presses here — the dialog buttons exist only while open, so they
// never shift the focus count proven above.
check("settings: relay agent pairing dialog + remote audit badge", () => {
  const handler = (cmd) => {
    if (cmd === "sevyn update status") return "0\nversion=1 channel=nightly active=A\n";
    if (cmd === "sevyn ai list") return "0\nselected=echo-ai backends=echo-ai,plan-ai\n";
    if (cmd === "sevyn ai status")
      return "0\nselected=echo-ai backends=echo-ai,plan-ai god_mode=off\n";
    if (cmd === "sevyn code status")
      return "0\nrunning: yes\nserving: yes\nversion: 4.105.0\nterminal-shell: /usr/local/bin/sevyn\n";
    if (cmd === "sevyn ai relay status")
      return (
        "0\nrelay agent: enabled\nagent: running (pid 1234)\n" +
        "fingerprint: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n" +
        "paired: unpaired\npairing: pending abcdef0123456789 code 1a2b3c\ndaemon relay: idle\n"
      );
    if (cmd === "sevyn ai audit 5")
      return "0\n2026-11-25T10:00:00Z muse-ai -> SESSION god_mode=off via=relay task=read\n";
    return "0\n";
  };
  loadAs(
    {
      id: "settings",
      name: "Settings",
      color: "#6b7280",
      glyph: "S",
      permissions: ["cli.exec"],
    },
    settingsBundle,
    handler,
  );
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Relay agent"), "relay agent section shown");
  assert.ok(
    texts.includes("Relay agent: enabled — unpaired — session idle"),
    "relay agent status shown",
  );
  assert.ok(
    texts.some((t) => t.includes("Relay agent is ON")),
    "relay agent banner shown",
  );
  assert.ok(texts.includes("Peer: abcdef0123456789"), "pending peer shown");
  assert.ok(texts.includes("Pairing code: 1a2b3c"), "pairing code shown");
  assert.ok(texts.includes("Confirm"), "pairing confirm shown");
  assert.ok(texts.includes("Dismiss"), "pairing dismiss shown");
  assert.ok(
    texts.some((t) => t.includes("via=relay") && t.includes("remote")),
    "remote badge shown on relay audit line",
  );
});

check("files: lists a real directory, navigates into it", () => {
  const handler = (cmd) => {
    if (cmd === "sevyn files list /data")
      return "0\nd m4-files-test\nf slot-state.json\n";
    if (cmd === "sevyn files list /data/m4-files-test") return "0\nf hello.txt\n";
    if (cmd === "sevyn files volumes")
      return "0\n/\tInternal Drive\t0\t1000000\t500000\n";
    if (cmd === "sevyn files clipboard") return "0\nempty\n";
    return "1\nerror: no such directory\n";
  };
  loadAs(
    {
      id: "files",
      name: "Files",
      color: "#3b82f6",
      glyph: "F",
      permissions: ["cli.exec"],
    },
    filesBundle,
    handler,
  );
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("/data"), "path bar shows /data");
  assert.ok(
    texts.some((t) => t.includes("m4-files-test")),
    "directory entry shown",
  );
  assert.ok(texts.includes("slot-state.json"), "file entry shown");
  assert.ok(Sevyn._logs.includes("FILES listed /data (2)"), "initial listing logged");
  // Focus order: [—, ▢, X, Cut, Copy, Paste, Delete, Internal Drive,
  // .., m4-files-test, slot-state.json] — the toolbar and the Devices
  // sidebar sit before the listing, so m4-files-test is the tenth Tab
  // from no-focus (files are pressable now, so slot-state.json is
  // eleventh). The first Enter selects the directory; the second
  // opens it (tap-to-select, tap-again-to-open).
  pressTab(10);
  pressEnter();
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("FILES listed /data/m4-files-test (1)"),
    "navigation listing logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("/data/m4-files-test"), "path bar updated");
  assert.ok(texts.includes("hello.txt"), "file inside shown");
});

// The #122 port: selection + Cut/Copy/Paste/Delete through the toolbar
// (no right-click in v2). The handler is a fake filesystem: the paste
// lands on the collision-suffixed name and the listing grows.
check("files: select, copy, paste, delete via the toolbar", () => {
  let pasted = false;
  let clipboard = null;
  const handler = (cmd) => {
    if (cmd === "sevyn files volumes")
      return "0\n/\tInternal Drive\t0\t1000000\t500000\n";
    if (cmd === "sevyn files clipboard")
      return "0\n" + (clipboard === null ? "empty\n" : clipboard + "\n");
    if (cmd === "sevyn files list /data")
      return pasted
        ? "0\nd m4-files-test\nd m4-files-test (1)\nf slot-state.json\n"
        : "0\nd m4-files-test\nf slot-state.json\n";
    if (
      cmd === "sevyn files clipboard set copy /data/m4-files-test m4-files-test directory"
    ) {
      clipboard =
        '{"kind":"copy","sourcePath":"/data/m4-files-test",' +
        '"sourceName":"m4-files-test","sourceKind":"directory"}';
      return "0\nclipboard set: copy m4-files-test\n";
    }
    if (cmd === "sevyn files copy /data/m4-files-test /data/m4-files-test (1)") {
      pasted = true;
      return "0\ncopied /data/m4-files-test to /data/m4-files-test (1)\n";
    }
    if (cmd === "sevyn files delete /data/m4-files-test (1)") {
      return "0\ndeleted /data/m4-files-test (1)\n";
    }
    return "1\nerror: no such directory\n";
  };
  loadAs(
    {
      id: "files",
      name: "Files",
      color: "#3b82f6",
      glyph: "F",
      permissions: ["cli.exec"],
    },
    filesBundle,
    handler,
  );
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Devices"), "Devices sidebar shown");
  assert.ok(texts.includes("Internal Drive"), "internal drive row shown");
  assert.ok(texts.includes("Clipboard empty"), "empty clipboard in the status bar");
  assert.ok(texts.includes("Cut"), "Cut on the toolbar");
  assert.ok(texts.includes("Paste"), "Paste on the toolbar");
  pressTab(10); // —, ▢, X, Cut, Copy, Paste, Delete, Internal Drive, .., m4-files-test
  pressEnter(); // first tap selects the directory (second tap would open it)
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Selected m4-files-test")),
    "selection shown in the status bar",
  );
  pressTab(6); // slot-state.json, —, ▢, X, Cut, Copy
  pressEnter(); // Copy
  assert.ok(
    Sevyn._logs.includes(
      "EXEC sevyn files clipboard set copy /data/m4-files-test m4-files-test directory",
    ),
    "copy sets the clipboard, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Copied m4-files-test")),
    "copy status shown",
  );
  assert.ok(
    texts.some((t) => t.includes("Clipboard: copy m4-files-test")),
    "clipboard indicator updated",
  );
  pressTab(1); // Paste
  pressEnter();
  assert.ok(
    Sevyn._logs.includes(
      "EXEC sevyn files copy /data/m4-files-test /data/m4-files-test (1)",
    ),
    "paste copies with the collision suffix, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Pasted m4-files-test (1)")),
    "paste status shown",
  );
  assert.ok(texts.includes("m4-files-test (1)"), "pasted entry listed");
  // Focus stayed on Paste across the listing refresh (the toolbar
  // instance is reused); the pasted copy is five Tabs on.
  pressTab(5); // Delete, Internal Drive, .., m4-files-test, m4-files-test (1)
  pressEnter(); // select the pasted copy
  pressTab(8); // slot-state.json, —, ▢, X, Cut, Copy, Paste, Delete
  pressEnter(); // Delete
  assert.ok(
    Sevyn._logs.includes("EXEC sevyn files delete /data/m4-files-test (1)"),
    "delete runs for the selected entry, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Deleted m4-files-test (1)")),
    "delete status shown",
  );
});

// Files right-click (gap unit 10, audit #13): drive a right-button
// press (0x111) at a presented rect, and read the menu back from
// the presented ops. The menu panel is the 220-wide #1f2937 rect;
// its item rows are the smallest hit rects under their labels (the
// full-surface click-away overlay is larger, so "smallest" picks
// the row, not the overlay).
function rightClickRect(rect, x, y) {
  Sevyn._handlers.pointer({
    type: "button",
    x,
    y,
    button: 0x111,
    pressed: true,
    nodeId: rect.nodeId,
  });
}
function smallestRectAt(x, y) {
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  let best = null;
  for (const o of present.ops) {
    if (o.type !== "rect" || o.nodeId == null || o.nodeId < 0) continue;
    if (x < o.x || x >= o.x + o.w || y < o.y || y >= o.y + o.h) continue;
    if (!best || o.w * o.h < best.w * best.h) best = o;
  }
  assert.ok(best, `hit rect at (${x},${y}) found`);
  return best;
}
// The rect of a file row, found from its name text.
function fileRowRect(name) {
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  const text = present.ops.find((o) => o.type === "text" && o.text === name);
  assert.ok(text, `file row text ${JSON.stringify(name)} found`);
  const cx = text.x + text.w / 2;
  const cy = text.y + text.h / 2;
  const rect = smallestRectAt(cx, cy);
  assert.equal(rect.h, 36, `row for ${name} is 36 tall`);
  return { rect, cx, cy };
}
// The Files list surface (the ScrollView's background rect): the only
// #f9fafb hit rect taller than a row.
function listSurfaceRect() {
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  const rect = present.ops.find(
    (o) =>
      o.type === "rect" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      o.color === "#f9fafb" &&
      o.h > 100,
  );
  assert.ok(rect, "list surface hit rect found");
  return rect;
}
function findMenuPanel() {
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  return present.ops.find(
    (o) => o.type === "rect" && o.color === "#1f2937" && o.w === 220,
  );
}
function menuPanelRect() {
  const panel = findMenuPanel();
  assert.ok(panel, "menu panel presented");
  return panel;
}
// Item labels inside the panel, in row order.
function menuTexts() {
  const panel = menuPanelRect();
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  return present.ops
    .filter(
      (o) =>
        o.type === "text" &&
        o.x >= panel.x &&
        o.x < panel.x + panel.w &&
        o.y >= panel.y &&
        o.y < panel.y + panel.h,
    )
    .map((o) => o.text);
}
function tapMenuItem(label) {
  const panel = menuPanelRect();
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  const text = present.ops.find(
    (o) =>
      o.type === "text" &&
      o.text === label &&
      o.x >= panel.x &&
      o.x < panel.x + panel.w &&
      o.y >= panel.y &&
      o.y < panel.y + panel.h,
  );
  assert.ok(text, `menu item ${JSON.stringify(label)} found`);
  const cx = text.x + text.w / 2;
  const cy = text.y + text.h / 2;
  const rect = smallestRectAt(cx, cy);
  Sevyn._handlers.pointer({
    type: "button",
    x: cx,
    y: cy,
    button: 1,
    pressed: true,
    nodeId: rect.nodeId,
  });
}
function menuItemColor(label) {
  const panel = menuPanelRect();
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  const text = present.ops.find(
    (o) =>
      o.type === "text" &&
      o.text === label &&
      o.x >= panel.x &&
      o.x < panel.x + panel.w &&
      o.y >= panel.y &&
      o.y < panel.y + panel.h,
  );
  assert.ok(text, `menu item ${JSON.stringify(label)} found`);
  return text.color;
}

check(
  "files: right-click a row selects it and opens the menu; Copy and Delete act on it",
  () => {
    const handler = (cmd) => {
      if (cmd === "sevyn files list /data")
        return "0\nd m4-files-test\nf slot-state.json\n";
      if (cmd === "sevyn files volumes")
        return "0\n/\tInternal Drive\t0\t1000000\t500000\n";
      if (cmd === "sevyn files clipboard") return "0\nempty\n";
      if (
        cmd ===
        "sevyn files clipboard set copy /data/m4-files-test m4-files-test directory"
      )
        return "0\nclipboard set: copy m4-files-test\n";
      if (cmd === "sevyn files delete /data/slot-state.json")
        return "0\ndeleted /data/slot-state.json\n";
      return "1\nerror: no such directory\n";
    };
    loadAs(
      {
        id: "files",
        name: "Files",
        color: "#3b82f6",
        glyph: "F",
        permissions: ["cli.exec"],
      },
      filesBundle,
      handler,
    );
    // Right-click the directory row: selects it, opens the menu with
    // the toolbar's actions — and does NOT navigate into it (no onPress
    // from a right-click, so the select-again-to-open rule cannot fire).
    const dir = fileRowRect("m4-files-test");
    rightClickRect(dir.rect, dir.cx, dir.cy);
    let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(
      texts.some((t) => t.includes("Selected m4-files-test")),
      "right-click selected the row",
    );
    assert.ok(
      !Sevyn._logs.includes("FILES listed /data/m4-files-test (1)"),
      "right-click did not navigate into the directory",
    );
    assert.deepEqual(
      menuTexts(),
      ["Cut", "Copy", "Paste", "Delete"],
      "menu offers the toolbar's actions",
    );
    assert.equal(
      menuItemColor("Paste"),
      "#6b7280",
      "Paste dimmed with an empty file clipboard",
    );
    // Keyboard: Down once highlights Copy, Enter copies the directory.
    Sevyn._handlers.key({ key: 108, pressed: true }); // Down
    Sevyn._handlers.key({ key: 28, pressed: true }); // Enter
    assert.ok(
      Sevyn._logs.includes(
        "EXEC sevyn files clipboard set copy /data/m4-files-test m4-files-test directory",
      ),
      "menu Copy copies the right-clicked entry, logs=" + JSON.stringify(Sevyn._logs),
    );
    texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(
      texts.some((t) => t.includes("Copied m4-files-test")),
      "copy status shown",
    );
    assert.equal(findMenuPanel(), undefined, "menu dismissed after selection");
    // Reopen: Paste is enabled now that the clipboard holds the copy,
    // and Esc dismisses the menu.
    const dir2 = fileRowRect("m4-files-test");
    rightClickRect(dir2.rect, dir2.cx, dir2.cy);
    assert.deepEqual(menuTexts(), ["Cut", "Copy", "Paste", "Delete"], "menu reopened");
    assert.equal(
      menuItemColor("Paste"),
      "#ffffff",
      "Paste enabled once the clipboard holds an item",
    );
    Sevyn._handlers.key({ key: 1, pressed: true }); // Esc
    assert.equal(findMenuPanel(), undefined, "Esc dismissed the menu");
    // Right-click the file row, click Delete in the menu.
    const file = fileRowRect("slot-state.json");
    rightClickRect(file.rect, file.cx, file.cy);
    assert.deepEqual(
      menuTexts(),
      ["Cut", "Copy", "Paste", "Delete"],
      "menu offers the actions for the file",
    );
    tapMenuItem("Delete");
    assert.ok(
      Sevyn._logs.includes("EXEC sevyn files delete /data/slot-state.json"),
      "menu Delete deletes the right-clicked file, logs=" + JSON.stringify(Sevyn._logs),
    );
    texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(
      texts.some((t) => t.includes("Deleted slot-state.json")),
      "delete status shown",
    );
    assert.equal(findMenuPanel(), undefined, "menu dismissed after Delete");
  },
);

check(
  "files: right-click on empty list space opens nothing with an empty clipboard",
  () => {
    const handler = (cmd) => {
      if (cmd === "sevyn files list /data")
        return "0\nd m4-files-test\nf slot-state.json\n";
      if (cmd === "sevyn files volumes")
        return "0\n/\tInternal Drive\t0\t1000000\t500000\n";
      if (cmd === "sevyn files clipboard") return "0\nempty\n";
      return "1\nerror: no such directory\n";
    };
    loadAs(
      {
        id: "files",
        name: "Files",
        color: "#3b82f6",
        glyph: "F",
        permissions: ["cli.exec"],
      },
      filesBundle,
      handler,
    );
    const surface = listSurfaceRect();
    // Below the last row, inside the list surface.
    rightClickRect(surface, surface.x + 100, surface.y + surface.h - 20);
    assert.equal(
      findMenuPanel(),
      undefined,
      "no menu on empty space with an empty clipboard",
    );
  },
);

check("files: right-click on empty list space offers Paste alone and pastes", () => {
  let pasted = false;
  const handler = (cmd) => {
    if (cmd === "sevyn files list /data")
      return pasted
        ? "0\nd m4-files-test\nd m4-files-test (1)\nf slot-state.json\n"
        : "0\nd m4-files-test\nf slot-state.json\n";
    if (cmd === "sevyn files volumes")
      return "0\n/\tInternal Drive\t0\t1000000\t500000\n";
    if (cmd === "sevyn files clipboard")
      return (
        '0\n{"kind":"copy","sourcePath":"/data/m4-files-test",' +
        '"sourceName":"m4-files-test","sourceKind":"directory"}\n'
      );
    if (cmd === "sevyn files copy /data/m4-files-test /data/m4-files-test (1)") {
      pasted = true;
      return "0\ncopied /data/m4-files-test to /data/m4-files-test (1)\n";
    }
    return "1\nerror: no such directory\n";
  };
  loadAs(
    {
      id: "files",
      name: "Files",
      color: "#3b82f6",
      glyph: "F",
      permissions: ["cli.exec"],
    },
    filesBundle,
    handler,
  );
  const surface = listSurfaceRect();
  rightClickRect(surface, surface.x + 100, surface.y + surface.h - 20);
  assert.deepEqual(menuTexts(), ["Paste"], "empty-space menu offers Paste alone");
  tapMenuItem("Paste");
  assert.ok(
    Sevyn._logs.includes(
      "EXEC sevyn files copy /data/m4-files-test /data/m4-files-test (1)",
    ),
    "empty-space Paste pastes into the current directory, logs=" +
      JSON.stringify(Sevyn._logs),
  );
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Pasted m4-files-test (1)")),
    "paste status shown",
  );
  assert.ok(texts.includes("m4-files-test (1)"), "pasted entry listed");
  assert.equal(findMenuPanel(), undefined, "menu dismissed after Paste");
});

check("browser: tabs on mount, address-bar navigation opens a page", () => {
  let tabCalls = 0;
  const handler = (cmd) => {
    if (cmd === "sevyn browser tabs") {
      tabCalls++;
      if (tabCalls === 1) {
        return (
          "0\nTAB AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\tSevynOS M5 Test Page\t" +
          "http://10.0.2.2:18080/m5-page.html\n"
        );
      }
      return (
        "0\nTAB AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\tSevynOS M5 Test Page\t" +
        "http://10.0.2.2:18080/m5-page.html\n" +
        "TAB BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\tSecond Page\t" +
        "http://10.0.2.2:18080/m5-page2.html\n"
      );
    }
    if (cmd === "sevyn browser status")
      return "0\nrunning: yes\ncdp: yes\ntabs: 1\nversion: Chrome/159.0.8150.0\n";
    if (cmd === "sevyn browser open http://10.0.2.2:18080/m5-page2.html")
      return (
        "0\nopened: http://10.0.2.2:18080/m5-page2.html\n" +
        "tab: BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\tSecond Page\t" +
        "http://10.0.2.2:18080/m5-page2.html\n"
      );
    return "0\n";
  };
  loadAs(
    {
      id: "browser",
      name: "Browser",
      color: "#0ea5e9",
      glyph: "B",
      permissions: ["cli.exec"],
    },
    browserBundle,
    handler,
  );
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("SevynOS M5 Test Page")),
    "the open tab's title is shown",
  );
  assert.ok(
    texts.some((t) => t.includes("http://10.0.2.2:18080/m5-page.html")),
    "the active tab's URL is shown",
  );
  assert.ok(Sevyn._logs.includes("BROWSER tabs 1"), "mount refresh logged");
  type("http://10.0.2.2:18080/m5-page2.html");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes(
      "BROWSER open title=Second Page url=http://10.0.2.2:18080/m5-page2.html",
    ),
    "open marker logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  assert.ok(Sevyn._logs.includes("BROWSER tabs 2"), "refresh after open logged");
});

// --- M10 comms -----------------------------------------------------------
// Canned `sevyn comms` answers. `loggedIn` flips the mount between
// the login form and the room/call screens.
function commsHandler(loggedIn, calls) {
  return (cmd) => {
    if (cmd === "sevyn comms status")
      return loggedIn
        ? '0\n{"loggedIn":true,"userId":"@alice:test.local","homeserver":"https://matrix.org","deviceId":"SEVYNTEST","rooms":2,"calls":[],"bridge":"chromium"}'
        : '0\n{"loggedIn":false,"userId":null,"homeserver":"https://matrix.org","deviceId":null,"rooms":0,"calls":[],"bridge":"chromium"}';
    if (cmd === "sevyn comms rooms")
      return loggedIn
        ? '0\n{"rooms":[{"roomId":"!general:test.local","name":"General","encrypted":true,"members":["@alice:test.local","@bob:test.local"],"lastMessage":{"sender":"@bob:test.local","body":"Hello from bob","ts":1794355200000}},{"roomId":"!plain:test.local","name":"Plain room","encrypted":false,"members":["@alice:test.local"],"lastMessage":null}]}'
        : '0\n{"rooms":[]}';
    if (cmd === "sevyn comms calls")
      return "0\n" + JSON.stringify({ calls: calls || [] });
    if (cmd === "sevyn comms rcs status")
      return '0\n{"staged":true,"state":"no carrier backend","detail":"RCS is staged in M10: SIP/MSRP skeleton only."}';
    if (cmd.startsWith('sevyn comms messages "!general:test.local"'))
      return '0\n{"messages":[{"eventId":"$1","sender":"@bob:test.local","type":"m.room.message","encrypted":true,"decrypted":true,"body":"Hello from bob","ts":1794355200000},{"eventId":"$2","sender":"@alice:test.local","type":"m.room.message","encrypted":true,"decrypted":true,"body":"Hi bob","ts":1794355201000}]}';
    if (cmd.startsWith("sevyn comms login"))
      return '0\n{"userId":"@alice:test.local","deviceId":"SEVYNTEST"}';
    if (cmd.startsWith("sevyn comms send")) return '0\n{"eventId":"$sent1"}';
    return "0\n";
  };
}

function loadCommsAs(appId, name, loggedIn, calls) {
  return loadAs(
    { id: appId, name, color: "#22c55e", glyph: "M", permissions: ["cli.exec"] },
    commsBundle,
    commsHandler(loggedIn, calls),
  );
}

check("comms messages (logged out): login form renders", () => {
  loadCommsAs("messages", "Messages", false);
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Messages"), "app title shown");
  assert.ok(texts.includes("LOG IN WITH MATRIX"), "login section shown");
  assert.ok(
    texts.some((t) => t.includes("@you:matrix.org")),
    "Matrix ID placeholder shown",
  );
  assert.ok(
    Sevyn._logs.includes("COMMS app=messages loggedIn=no"),
    "mount logged, logs=" + JSON.stringify(Sevyn._logs),
  );
});

check("comms messages (logged in): room list + staged RCS card", () => {
  loadCommsAs("messages", "Messages", true);
  let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("General")),
    "room name shown",
  );
  assert.ok(texts.includes("Plain room"), "second room shown");
  assert.ok(
    texts.some((t) => t.includes("Hello from bob")),
    "last message shown",
  );
  assert.ok(
    texts.some((t) => t.includes("RCS — carrier setup required")),
    "RCS staged honestly, not as working",
  );
  tapText("Refresh", 14);
  assert.ok(
    Sevyn._logs.includes("COMMS rooms=2"),
    "rooms refresh logged, logs=" + JSON.stringify(Sevyn._logs),
  );
});

check("comms video-calls (logged in): start-call screen", () => {
  loadCommsAs("video-calls", "Video Calls", true);
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("Video Calls"), "app title shown");
  assert.ok(texts.includes("START A CALL"), "start section shown");
  assert.ok(
    texts.some((t) => t.includes("@friend:matrix.org")),
    "call-target placeholder shown",
  );
});

check("comms voice-calls (logged in): incoming call banner", () => {
  loadCommsAs("voice-calls", "Voice Calls", true, [
    {
      callId: "sevyn-incoming1",
      roomId: "!general:test.local",
      peer: "@bob:test.local",
      video: false,
      direction: "incoming",
      state: "incoming",
      media: "none",
    },
  ]);
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Incoming voice call")),
    "incoming banner shown",
  );
  assert.ok(texts.includes("Answer"), "answer button shown");
  assert.ok(texts.includes("Decline"), "decline button shown");
});

// --- Camera --------------------------------------------------------------
// Canned `sevyn camera` + `sevyn files` answers. `consent` flips the
// mount between the first-use Allow screen and the camera view;
// `available` flips between the live view and the no-device state.
function cameraHandler({ consent, available, photos }) {
  const listed = photos.slice();
  return (cmd) => {
    if (cmd === "sevyn camera status")
      return available
        ? '0\n{"ok":true,"available":true,"device":"/dev/video0","driver":"uvcvideo"}'
        : '0\n{"ok":true,"available":false,"device":null}';
    if (cmd === "sevyn files list /data/camera")
      return consent ? "0\nf .consent\n" : "0\n";
    if (cmd === "sevyn files list /data/photos")
      return "0\n" + listed.map((p) => "f " + p + "\n").join("");
    if (cmd === "sevyn camera preview")
      return '0\n{"ok":true,"available":true,"device":"/dev/video0","width":640,"height":360,"png":"/data/camera/preview-1.png","rgba":"/data/camera/preview-1.rgba","frame":1}';
    if (cmd.startsWith("sevyn camera capture ")) {
      const name = cmd.slice("sevyn camera capture /data/photos/".length);
      listed.push(name);
      return (
        '0\n{"ok":true,"path":"/data/photos/' +
        name +
        '","width":1280,"height":720,"size":12345}'
      );
    }
    if (cmd.startsWith("sevyn camera decode ")) {
      const parts = cmd.split(" ");
      return (
        '0\n{"ok":true,"available":true,"width":1280,"height":720,"png":"/data/camera/view-1.png","rgba":"' +
        parts[parts.length - 1] +
        '"}'
      );
    }
    return "0\n";
  };
}

function loadCameraAs(handler) {
  return loadAs(
    {
      id: "camera",
      name: "Camera",
      color: "#14b8a6",
      glyph: "O",
      permissions: ["camera", "cli.exec"],
    },
    cameraBundle,
    handler,
  );
}

check("camera (no consent): first-use Allow screen", () => {
  loadCameraAs(cameraHandler({ consent: false, available: true, photos: [] }));
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Allow Camera to use your camera?")),
    "consent prompt shown",
  );
  assert.ok(texts.includes("Allow camera"), "allow button shown");
  assert.ok(texts.includes("Not now"), "decline button shown");
});

check("camera (no device): honest no-camera state + Retry", () => {
  loadCameraAs(
    cameraHandler({
      consent: true,
      available: false,
      photos: ["01-mountain-golden-hour.jpg"],
    }),
  );
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("No camera yet"), "no-device title shown");
  assert.ok(
    texts.some((t) => t.includes("No usable Video4Linux")),
    "honest reason shown",
  );
  tapText("Retry", 15);
  assert.ok(
    Sevyn._logs.includes("CAMERA status available=no"),
    "retry re-reads status, logs=" + JSON.stringify(Sevyn._logs),
  );
});

// Regression: GF65 Camera rendered fully blank (white) and never
// asked camd for a frame. A throw during the first render — any of
// the mount-time reads throwing — made the reconciler swallow the
// whole tree (render error, 0 ops) so the poll effect never ran.
// The reads now degrade to safe defaults and log the throw, so the
// app must still paint a screen instead of blanking.
check("camera (exec throws at mount): still paints, no blank window", () => {
  loadCameraAs(() => {
    throw new Error("exec exploded");
  });
  const present = Sevyn._presents[Sevyn._presents.length - 1];
  assert.ok(present.ops.length > 0, "mount still paints ops");
  const texts = textsOf(present);
  assert.ok(texts.includes("Camera"), "header paints");
  assert.ok(
    texts.some((t) => t.includes("Allow Camera to use your camera?")),
    "consent screen shown (safe degradation), texts=" + JSON.stringify(texts),
  );
  assert.ok(
    Sevyn._logs.some((l) => l.startsWith("CAMERA status read failed")),
    "throw logged, logs=" + JSON.stringify(Sevyn._logs),
  );
});

// --- Music ---------------------------------------------------------------
// The library comes from the mock's fake audiod (Sevyn._audio): the
// scan returns 2 tracks (01-sunrise-acoustic.wav 21.5 s, song.mp3
// 200 s). The files-list fallback answers through the exec handler
// below; MUSIC_TRACKS is the /data fixture it lists. Stubbing
// Sevyn.audioScan per check scripts a scan failure (fallback) or an
// extra track (failed play) — the stub is restored at the end of
// the check, because loadAs/_reset does not restore host functions.
const MUSIC_TRACKS = [
  "01-sunrise-acoustic.wav",
  "02-midnight-jazz.wav",
  "03-ocean-breeze.wav",
  "04-city-lights.wav",
  "05-forest-dawn.wav",
  "06-desert-drive.wav",
  "07-starlight-lullaby.wav",
];

function musicFilesHandler(files) {
  const listed = files || MUSIC_TRACKS;
  return (cmd) => {
    if (cmd === "sevyn files list /data")
      return "0\n" + listed.map((f) => "f " + f + "\n").join("");
    return "0\n";
  };
}

function loadMusicAs(handler, permissions) {
  return loadAs(
    {
      id: "music",
      name: "Music",
      color: "#ec4899",
      glyph: "M",
      permissions: permissions || ["cli.exec"],
    },
    musicBundle,
    handler,
  );
}

// Async flows (login + open room + send): the mock's execAsync
// resolves on a microtask, so flush with setImmediate after each tap.
const flush = () => new Promise((r) => setImmediate(r));
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log("ok - " + name);
}

// The mount scan is async: give the passive effect a macrotask to
// fire, then flush the adapter promise's microtasks (same pattern
// as the camera preview check below).
async function waitForMusicScan() {
  await new Promise((r) => setTimeout(r, 100));
  await flush();
  await flush();
}

(async () => {
  await checkAsync("comms messages: login flow reaches the room list", async () => {
    loadCommsAs("messages", "Messages", false);
    // Focus order after the close X: user, password, homeserver, Log in.
    pressTab(1);
    type("alice");
    pressTab(1);
    type("testpass");
    pressTab(1); // homeserver (default https://matrix.org — leave it)
    pressTab(1); // Log in button
    pressEnter();
    await flush();
    await flush();
    assert.ok(
      Sevyn._logs.some((l) => l.startsWith("EXEC sevyn comms login")),
      "login CLI issued, logs=" + JSON.stringify(Sevyn._logs),
    );
    assert.ok(
      Sevyn._logs.includes("COMMS login=@alice:test.local"),
      "login marker logged",
    );
    // The canned handler answers logged-out status on mount, so the
    // post-login refresh re-reads status — the login marker is the
    // flow proof; the room list renders from the logged-in mount
    // (proven by the sync check above).
  });

  await checkAsync("comms messages: open room shows thread, send works", async () => {
    loadCommsAs("messages", "Messages", true);
    tapText("General · encrypted", 16);
    let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(
      texts.some((t) => t.includes("Hello from bob")),
      "thread message shown",
    );
    assert.ok(
      texts.some((t) => t.includes("Write a message")),
      "composer shown",
    );
    tapText("Write a message…", 15);
    type("hi there");
    tapText("Send", 15);
    await flush();
    await flush();
    assert.ok(
      Sevyn._logs.some((l) =>
        l.startsWith('EXEC sevyn comms send "!general:test.local" "hi there"'),
      ),
      "send CLI issued, logs=" + JSON.stringify(Sevyn._logs),
    );
    assert.ok(
      Sevyn._logs.includes("COMMS sent room=!general:test.local"),
      "send marker logged",
    );
  });

  await checkAsync(
    "camera: preview frame, shutter saves a photo, gallery + viewer",
    async () => {
      loadCameraAs(
        cameraHandler({
          consent: true,
          available: true,
          photos: ["01-mountain-golden-hour.jpg"],
        }),
      );
      // The preview poll is a useEffect + setInterval: give the
      // passive effect a macrotask to fire, then flush the async
      // exec's microtasks.
      await new Promise((r) => setTimeout(r, 100));
      await flush();
      await flush();
      let present = Sevyn._presents[Sevyn._presents.length - 1];
      assert.ok(
        present.ops.some(
          (o) => o.type === "image" && o.asset === "/data/camera/preview-1.png",
        ),
        "preview frame drawn, ops=" +
          JSON.stringify(
            present.ops.map((o) => o.type + ":" + (o.asset || o.text || "")),
          ),
      );
      tapText("Take photo", 15);
      await flush();
      await flush();
      await flush();
      const captureLog = Sevyn._logs.find((l) =>
        l.startsWith("CAMERA capture /data/photos/camera-"),
      );
      assert.ok(captureLog, "shutter marker logged, logs=" + JSON.stringify(Sevyn._logs));
      const capturedName = captureLog.slice("CAMERA capture /data/photos/".length);
      let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Saved to Photos"), "save confirmation shown");
      tapText("Photos (2)", 15);
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.includes("01-mountain-golden-hour.jpg"),
        "fixture photo listed in gallery",
      );
      assert.ok(texts.includes(capturedName), "captured photo listed in gallery");
      tapText(capturedName, 15);
      await flush();
      await flush();
      await flush();
      present = Sevyn._presents[Sevyn._presents.length - 1];
      assert.ok(
        present.ops.some(
          (o) => o.type === "image" && o.asset === "/data/camera/view-1.png",
        ),
        "viewer draws the decoded photo",
      );
      assert.ok(
        Sevyn._logs.includes("CAMERA view /data/photos/" + capturedName),
        "viewer marker logged, logs=" + JSON.stringify(Sevyn._logs),
      );
      // Unmount: clears the 1s preview interval so the process exits.
      renderer.unmount();
      Sevyn._reset();
    },
  );

  await checkAsync("music: library lists the 2 scanned tracks", async () => {
    loadMusicAs(musicFilesHandler());
    await waitForMusicScan();
    const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(texts.includes("2 tracks"), "count shown");
    assert.ok(texts.includes("01-sunrise-acoustic"), "track 01 listed");
    assert.ok(texts.includes("song"), "mp3 track listed");
    assert.ok(
      texts.some((t) => t.includes("0:21")),
      "01 duration shown",
    );
    assert.ok(
      texts.some((t) => t.includes("3:20")),
      "song duration shown",
    );
    assert.ok(
      !texts.some((t) => t.includes("durations unknown")),
      "scan source, not the fallback",
    );
    assert.ok(texts.includes("Tap a track to play it."), "now-playing idle line shown");
    assert.ok(texts.includes("Volume 100%"), "volume shown");
    assert.ok(
      Sevyn._audio.calls.includes("SCAN /data"),
      "scan reached the host adapter, calls=" + JSON.stringify(Sevyn._audio.calls),
    );
  });

  await checkAsync("music: adapter needs no permission", async () => {
    loadMusicAs(musicFilesHandler(), []);
    await waitForMusicScan();
    const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(texts.includes("2 tracks"), "library lists without cli.exec");
    assert.ok(!texts.some((t) => t.includes("permission")), "no permission gate shown");
  });

  await checkAsync("music: scan failure falls back to the files list", async () => {
    const realScan = Sevyn.audioScan;
    Sevyn.audioScan = () =>
      Promise.resolve(
        JSON.stringify({ ok: false, error: "cannot list /data", code: "not-found" }),
      );
    loadMusicAs(musicFilesHandler());
    await waitForMusicScan();
    const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(
      texts.some((t) => t.includes("7 tracks")),
      "count shown",
    );
    assert.ok(
      texts.some((t) => t.includes("durations unknown")),
      "fallback note shown",
    );
    assert.ok(texts.includes("01-sunrise-acoustic"), "track listed");
    assert.ok(
      !texts.some((t) => t.includes("0:21")),
      "no fake durations in the fallback",
    );
    Sevyn.audioScan = realScan;
  });

  await checkAsync("music: empty library + Retry re-scans", async () => {
    const realScan = Sevyn.audioScan;
    Sevyn.audioScan = () =>
      Promise.resolve(
        JSON.stringify({ ok: false, error: "cannot list /data", code: "not-found" }),
      );
    loadMusicAs(musicFilesHandler([]));
    await waitForMusicScan();
    const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
    assert.ok(texts.includes("No music yet"), "empty state shown");
    assert.ok(texts.includes("Retry"), "retry button shown");
    tapText("Retry", 15);
    assert.ok(
      Sevyn._logs.includes("MUSIC rescan"),
      "retry re-scans, logs=" + JSON.stringify(Sevyn._logs),
    );
    // Let the re-scan settle before the next check loads.
    await waitForMusicScan();
    Sevyn.audioScan = realScan;
  });

  await checkAsync(
    "music: play, position poll, pause/resume, seek, volume, next/prev wrap, stop",
    async () => {
      loadMusicAs(musicFilesHandler());
      await waitForMusicScan();
      tapText("01-sunrise-acoustic", 15);
      await flush();
      await flush();
      let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Playing"), "playing state shown");
      assert.ok(
        Sevyn._logs.includes("MUSIC play /data/01-sunrise-acoustic.wav"),
        "play marker logged, logs=" + JSON.stringify(Sevyn._logs),
      );
      // The 1 s position poll fires STATUS; the fake holds the
      // position the test sets, so the poll is observable.
      Sevyn._audio.positionSec = 5;
      await new Promise((r) => setTimeout(r, 1200));
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("0:05 / 0:21")),
        "poll picked up the daemon position, texts=" + JSON.stringify(texts),
      );
      tapText("Pause", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Paused"), "paused state shown");
      await new Promise((r) => setTimeout(r, 1200));
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("0:05 / 0:21")),
        "position frozen while paused, texts=" + JSON.stringify(texts),
      );
      tapText("Resume", 15);
      await flush();
      await flush();
      tapText("+10s", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("0:15 / 0:21")),
        "seek +10s to 0:15, texts=" + JSON.stringify(texts),
      );
      tapText("Volume −", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Volume 90%"), "volume down to 90%");
      tapText("Next", 15);
      await flush();
      await flush();
      assert.ok(
        Sevyn._logs.includes("MUSIC play /data/song.mp3"),
        "next plays song.mp3, logs=" + JSON.stringify(Sevyn._logs),
      );
      tapText("Previous", 15);
      await flush();
      await flush();
      assert.ok(
        Sevyn._logs.includes("MUSIC play /data/01-sunrise-acoustic.wav"),
        "previous returns to track 01",
      );
      // Wrap: Next from the last track plays the first.
      tapText("song", 15);
      await flush();
      await flush();
      tapText("Next", 15);
      await flush();
      await flush();
      const playLogs = Sevyn._logs.filter((l) =>
        l.startsWith("MUSIC play /data/01-sunrise-acoustic.wav"),
      );
      assert.ok(playLogs.length >= 2, "next wraps to track 01");
      tapText("Stop", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Stopped"), "stopped state shown");
      // Unmount: clears the 1 s status interval so the process exits.
      renderer.unmount();
      Sevyn._reset();
    },
  );

  await checkAsync(
    "music: failed play surfaces a clean error and the app recovers",
    async () => {
      const realScan = Sevyn.audioScan;
      Sevyn.audioScan = () =>
        Promise.resolve(
          JSON.stringify({
            ok: true,
            tracks: [
              {
                id: "/data/01-sunrise-acoustic.wav",
                title: "01-sunrise-acoustic",
                artist: "Unknown Artist",
                album: "Local Library",
                durationSec: 21.5,
                path: "/data/01-sunrise-acoustic.wav",
                format: "wav",
              },
              {
                id: "/data/boom.wav",
                title: "boom",
                artist: "Unknown Artist",
                album: "Local Library",
                durationSec: 10,
                path: "/data/boom.wav",
                format: "wav",
              },
            ],
          }),
        );
      loadMusicAs(musicFilesHandler());
      await waitForMusicScan();
      tapText("boom", 15);
      await flush();
      await flush();
      let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("not a decodable MP3 file")),
        "daemon error shown, texts=" + JSON.stringify(texts),
      );
      assert.ok(
        texts.some((t) => t.includes("decode-error")),
        "stable error code shown",
      );
      assert.ok(
        texts.includes("01-sunrise-acoustic"),
        "library still listed after the bad call",
      );
      tapText("01-sunrise-acoustic", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Playing"), "a good track plays after the error");
      assert.ok(
        !texts.some((t) => t.includes("not a decodable MP3 file")),
        "error cleared by the next success",
      );
      // Stop first: the 1 s status interval is cleared by the
      // playing->stopped state change (unmount alone does not flush
      // the effect cleanup in this harness, so an active interval
      // would keep the process alive).
      tapText("Stop", 15);
      await flush();
      await flush();
      renderer.unmount();
      Sevyn._reset();
      Sevyn.audioScan = realScan;
    },
  );

  await checkAsync(
    "music: volume with the daemon down surfaces an error, never throws",
    async () => {
      loadMusicAs(musicFilesHandler());
      await waitForMusicScan();
      tapText("01-sunrise-acoustic", 15);
      await flush();
      await flush();
      const realVolume = Sevyn.audioVolume;
      Sevyn.audioVolume = () =>
        Promise.resolve(
          JSON.stringify({
            ok: false,
            error: "Could not reach the audio service.",
            code: "audio-unavailable",
          }),
        );
      tapText("Volume +", 15);
      await flush();
      await flush();
      let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("Could not reach the audio service")),
        "daemon-down error shown, texts=" + JSON.stringify(texts),
      );
      assert.ok(
        texts.includes("Playing"),
        "app still alive after the failed volume call",
      );
      Sevyn.audioVolume = realVolume;
      tapText("Volume −", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Volume 90%"), "volume recovers when the daemon does");
      assert.ok(
        !texts.some((t) => t.includes("Could not reach the audio service")),
        "error cleared by the next success",
      );
      // Stop first: the 1 s status interval is cleared by the
      // playing->stopped state change (unmount alone does not flush
      // the effect cleanup in this harness, so an active interval
      // would keep the process alive).
      tapText("Stop", 15);
      await flush();
      await flush();
      renderer.unmount();
      Sevyn._reset();
    },
  );

  console.log(`\n${passed} app e2e checks passed`);
})();
