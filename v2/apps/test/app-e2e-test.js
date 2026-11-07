"use strict";
// End-to-end Node test for the built app bundles (dist/app.js,
// dist/terminal.js, dist/settings.js, dist/files.js) and the crash
// bundle (dist/crash.js). Loads the app bundle with the mock Sevyn
// host as two different apps — files (status.read granted) and notes
// (no permission) — and drives the close X. The crash bundle must
// throw during evaluation. The M4 apps load with cli.exec and a
// canned exec handler, and drive their real flows (terminal typing,
// settings channel switch, files navigation).
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
  _: [12, true],
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

check("notes (no permission): status line says not permitted", () => {
  const last = loadAs({
    id: "notes",
    name: "Notes",
    color: "#eab308",
    glyph: "N",
    permissions: [],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Notes"), "app name shown");
  assert.ok(
    texts.some((t) => t.includes("not permitted")),
    "status line says not permitted",
  );
  assert.ok(
    !texts.some((t) => t.includes("87%")),
    "no live status leaks without the permission",
  );
});

check("close X calls Sevyn.closeApp()", () => {
  const last = loadAs({
    id: "files",
    name: "Files",
    color: "#3b82f6",
    glyph: "F",
    permissions: ["status.read"],
  });
  // The X is the only pressable in the app window (28x28).
  const pressables = last.ops.filter(
    (o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect",
  );
  assert.equal(pressables.length, 1, "one pressable (the X)");
  const x = pressables[0];
  assert.equal(x.w, 28, "X button is 28 wide");
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

check("settings: channel switch applies and logs", () => {
  let channel = "nightly";
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
    if (cmd === "sevyn code status")
      return "0\nrunning: yes\nserving: yes\nversion: 4.105.0\nterminal-shell: /usr/local/bin/sevyn\n";
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
  assert.ok(
    texts.some((t) => t.includes("coming in M4.5")),
    "AI placeholder shown",
  );
  pressTab(3); // X, Nightly, Stable
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
  pressTab(2); // Stable -> X -> Nightly
  pressEnter();
  assert.ok(Sevyn._logs.includes("SETTINGS channel=nightly"), "channel switched back");
});

check("files: lists a real directory, navigates into it", () => {
  const handler = (cmd) => {
    if (cmd === "sevyn files list /data")
      return "0\nd m4-files-test\nf slot-state.json\n";
    if (cmd === "sevyn files list /data/m4-files-test") return "0\nf hello.txt\n";
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
  pressTab(3); // X, .., m4-files-test
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("FILES listed /data/m4-files-test (1)"),
    "navigation listing logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("/data/m4-files-test"), "path bar updated");
  assert.ok(texts.includes("hello.txt"), "file inside shown");
});

console.log(`\n${passed} app e2e checks passed`);
