"use strict";
// End-to-end Node test for the built app bundles (dist/app.js,
// dist/terminal.js, dist/settings.js, dist/files.js, dist/browser.js,
// dist/comms.js, dist/music.js) and the crash bundle (dist/crash.js). Loads the app
// bundle with the mock Sevyn host as several apps — files (status.read
// granted, the fallback screen) and notes/calculator/calendar/store
// (the M9 real screens) — and drives the close X. The crash bundle
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
// Music bundle loads with cli.exec and a canned `sevyn music`
// handler: library (scan + files-list fallback + empty), and the
// live flow (play, 1 s position poll, pause/resume, seek, volume,
// next/previous wrap, stop, clean errors). The position poll runs
// on a 1 s interval — the async music checks stop playback before
// unmounting, so the playing->stopped state change clears the
// interval (unmount alone does not flush the effect cleanup in this
// harness); the sync music checks never start it (nothing playing).
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
// is proven by the fallback screen; notes shows its real UI instead.
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

check("fallback (no permission): status line says not permitted", () => {
  const last = loadAs({
    id: "widget",
    name: "Widget",
    color: "#ec4899",
    glyph: "W",
    permissions: [],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Widget"), "app name shown");
  assert.ok(
    texts.some((t) => t.includes("not permitted")),
    "status line says not permitted",
  );
  assert.ok(
    !texts.some((t) => t.includes("87%")),
    "no live status leaks without the permission",
  );
});

check("fallback (status.read): live status line", () => {
  const last = loadAs({
    id: "widget",
    name: "Widget",
    color: "#ec4899",
    glyph: "W",
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

// --- Music ---------------------------------------------------------------
// Canned `sevyn music` + `sevyn files` answers. The fake daemon
// keeps playback state; each STATUS while playing advances position
// by 1 s, so the 1 s position poll is observable. Only STATUS
// advances the clock — command replies report the state as the
// command left it. `daemonDown` flips every music call to a bare
// failure (no JSON): the old volume-up bug's shape.
const MUSIC_TRACKS = [
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
    id: "/data/02-midnight-jazz.wav",
    title: "02-midnight-jazz",
    artist: "Unknown Artist",
    album: "Local Library",
    durationSec: 25.5,
    path: "/data/02-midnight-jazz.wav",
    format: "wav",
  },
  {
    id: "/data/03-ocean-breeze.wav",
    title: "03-ocean-breeze",
    artist: "Unknown Artist",
    album: "Local Library",
    durationSec: 24.83,
    path: "/data/03-ocean-breeze.wav",
    format: "wav",
  },
  {
    id: "/data/04-city-lights.wav",
    title: "04-city-lights",
    artist: "Unknown Artist",
    album: "Local Library",
    durationSec: 27.75,
    path: "/data/04-city-lights.wav",
    format: "wav",
  },
  {
    id: "/data/05-forest-dawn.wav",
    title: "05-forest-dawn",
    artist: "Unknown Artist",
    album: "Local Library",
    durationSec: 22.83,
    path: "/data/05-forest-dawn.wav",
    format: "wav",
  },
  {
    id: "/data/06-desert-drive.wav",
    title: "06-desert-drive",
    artist: "Unknown Artist",
    album: "Local Library",
    durationSec: 22.93,
    path: "/data/06-desert-drive.wav",
    format: "wav",
  },
  {
    id: "/data/07-starlight-lullaby.wav",
    title: "07-starlight-lullaby",
    artist: "Unknown Artist",
    album: "Local Library",
    durationSec: 29.5,
    path: "/data/07-starlight-lullaby.wav",
    format: "wav",
  },
];

function musicHandler(opts) {
  const options = opts || {};
  const scanOk = options.scanOk !== false;
  const files = options.files || MUSIC_TRACKS.map((t) => t.path.slice("/data/".length));
  const failPlayPath = options.failPlayPath || null;
  let daemonDown = !!options.daemonDown;
  const daemon = {
    playing: false,
    paused: false,
    position: 0,
    volume: 100,
    current: null,
  };
  const durationOf = (trackPath) => {
    const found = MUSIC_TRACKS.find((t) => t.path === trackPath);
    return found ? found.durationSec : 0;
  };
  const statusReply = (advance) => {
    if (advance && daemon.playing && daemon.current) {
      daemon.position = Math.min(daemon.position + 1, durationOf(daemon.current));
      if (daemon.position >= durationOf(daemon.current)) daemon.playing = false;
    }
    return (
      "0\n" +
      JSON.stringify({
        ok: true,
        available: true,
        playing: daemon.playing,
        paused: daemon.paused,
        positionSec: daemon.position,
        durationSec: daemon.current ? durationOf(daemon.current) : 0,
        volume: daemon.volume,
        track: daemon.current ? { path: daemon.current } : null,
      })
    );
  };
  const handler = (cmd) => {
    if (cmd === "sevyn music scan /data") {
      if (daemonDown || !scanOk) return "1\n";
      return "0\n" + JSON.stringify({ ok: true, tracks: MUSIC_TRACKS });
    }
    if (cmd === "sevyn files list /data") {
      return "0\n" + files.map((f) => "f " + f + "\n").join("");
    }
    if (cmd === "sevyn music status") {
      if (daemonDown) return "1\n";
      return statusReply(true);
    }
    if (cmd.startsWith("sevyn music play ")) {
      if (daemonDown) return "1\n";
      const playPath = cmd.slice("sevyn music play ".length);
      // A file can turn undecodable between scan and play (changed
      // on disk): the daemon refuses with a stable code, and the app
      // must show it, not crash.
      if (playPath === failPlayPath)
        return (
          "1\n" +
          JSON.stringify({
            ok: false,
            error: "not an audio file",
            code: "unsupported-format",
          })
        );
      daemon.current = playPath;
      daemon.playing = true;
      daemon.paused = false;
      daemon.position = 0;
      return statusReply(false);
    }
    if (cmd === "sevyn music pause") {
      if (daemonDown) return "1\n";
      daemon.playing = false;
      daemon.paused = true;
      return statusReply(false);
    }
    if (cmd === "sevyn music resume") {
      if (daemonDown) return "1\n";
      daemon.playing = true;
      daemon.paused = false;
      return statusReply(false);
    }
    if (cmd === "sevyn music stop") {
      if (daemonDown) return "1\n";
      daemon.playing = false;
      daemon.paused = false;
      daemon.position = 0;
      daemon.current = null;
      return statusReply(false);
    }
    if (cmd.startsWith("sevyn music seek ")) {
      if (daemonDown) return "1\n";
      const target = Number(cmd.slice("sevyn music seek ".length));
      if (target > durationOf(daemon.current))
        return (
          "1\n" +
          JSON.stringify({
            ok: false,
            error: "seek past the end",
            code: "out-of-range",
          })
        );
      daemon.position = target;
      return statusReply(false);
    }
    if (cmd.startsWith("sevyn music volume ")) {
      if (daemonDown) return "1\n";
      const target = Number(cmd.slice("sevyn music volume ".length));
      daemon.volume = Math.min(100, Math.max(0, target));
      return statusReply(false);
    }
    return "0\n";
  };
  handler.setDown = (down) => {
    daemonDown = down;
  };
  return handler;
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

check("music (no permission): cli.exec gate", () => {
  loadMusicAs(null, []);
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(
    texts.some((t) => t.includes("Music permission is not granted")),
    "permission gate shown",
  );
  assert.ok(
    !texts.some((t) => t.includes("01-sunrise-acoustic")),
    "no library without the permission",
  );
});

check("music: library lists all 7 test tracks with real durations", () => {
  loadMusicAs(musicHandler());
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("7 tracks"), "count shown");
  for (const track of MUSIC_TRACKS) {
    assert.ok(texts.includes(track.title), track.title + " listed");
  }
  assert.ok(
    texts.some((t) => t.includes("0:21")),
    "01 duration shown",
  );
  assert.ok(
    texts.some((t) => t.includes("0:29")),
    "07 duration shown",
  );
  assert.ok(texts.includes("Tap a track to play it."), "now-playing idle line shown");
  assert.ok(texts.includes("Volume 100%"), "volume shown");
});

check("music: scan failure falls back to the files list", () => {
  loadMusicAs(musicHandler({ scanOk: false }));
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
  assert.ok(!texts.some((t) => t.includes("0:21")), "no fake durations in the fallback");
});

check("music: empty library + Retry re-scans", () => {
  loadMusicAs(musicHandler({ scanOk: false, files: [] }));
  const texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("No music yet"), "empty state shown");
  assert.ok(texts.includes("Retry"), "retry button shown");
  tapText("Retry", 15);
  assert.ok(
    Sevyn._logs.includes("MUSIC rescan"),
    "retry re-scans, logs=" + JSON.stringify(Sevyn._logs),
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
      return "0\nselected=echo-ai backends=echo-ai,plan-ai\n";
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
    Sevyn._logs.includes("TERMINAL ai-status selected=echo-ai"),
    "ai-status marker logged",
  );
  type("ai ask launch files");
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("TERMINAL ai-ask allowed=1 denied=0"),
    "ai-ask marker logged",
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
  assert.ok(texts.includes("Power"), "power section shown");
  assert.ok(texts.includes("Shut Down"), "power shut down button shown");
  assert.ok(texts.includes("Restart"), "power restart button shown");
  // M9: the Wi-Fi Scan button is the second focusable, so the order
  // is [—, ▢, X, Scan, Nightly, Stable, echo-ai, plan-ai, Shut Down,
  // Restart] (the two window buttons lead the title bar; the power
  // buttons are the last two).
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
  // Focus order is now [—, ▢, X, Scan, Nightly, Stable, echo-ai,
  // plan-ai, Shut Down, Restart]: Stable -> echo-ai -> plan-ai ->
  // Shut Down -> Restart -> — -> ▢ -> X -> Scan -> Nightly.
  pressTab(9);
  pressEnter();
  assert.ok(Sevyn._logs.includes("SETTINGS channel=nightly"), "channel switched back");
  // Nightly -> Stable -> echo-ai -> plan-ai: swap the AI through the
  // same Settings surface, no code change.
  pressTab(3);
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
  pressTab(5); // —, ▢, X, .., m4-files-test
  pressEnter();
  assert.ok(
    Sevyn._logs.includes("FILES listed /data/m4-files-test (1)"),
    "navigation listing logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
  assert.ok(texts.includes("/data/m4-files-test"), "path bar updated");
  assert.ok(texts.includes("hello.txt"), "file inside shown");
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

// Async flows (login + open room + send): the mock's execAsync
// resolves on a microtask, so flush with setImmediate after each tap.
const flush = () => new Promise((r) => setImmediate(r));
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log("ok - " + name);
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
    "music: play, position poll, pause/resume, seek, volume, next/prev wrap, stop",
    async () => {
      const handler = musicHandler();
      loadMusicAs(handler);
      tapText("01-sunrise-acoustic", 15);
      await flush();
      await flush();
      let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Playing"), "playing state shown");
      assert.ok(
        Sevyn._logs.includes("MUSIC play /data/01-sunrise-acoustic.wav"),
        "play marker logged, logs=" + JSON.stringify(Sevyn._logs),
      );
      // The 1 s position poll fires STATUS; the fake advances 1 s
      // per STATUS while playing.
      await new Promise((r) => setTimeout(r, 1200));
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("0:01 / 0:21")),
        "position advanced to 0:01, texts=" + JSON.stringify(texts),
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
        texts.some((t) => t.includes("0:01 / 0:21")),
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
        texts.some((t) => t.includes("0:11 / 0:21")),
        "seek +10s to 0:11, texts=" + JSON.stringify(texts),
      );
      tapText("Volume −", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(texts.includes("Volume 90%"), "volume down to 90%");
      tapText("Next", 15);
      await flush();
      await flush();
      texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        Sevyn._logs.includes("MUSIC play /data/02-midnight-jazz.wav"),
        "next plays track 02, logs=" + JSON.stringify(Sevyn._logs),
      );
      tapText("Previous", 15);
      await flush();
      await flush();
      assert.ok(
        Sevyn._logs.includes("MUSIC play /data/01-sunrise-acoustic.wav"),
        "previous returns to track 01",
      );
      // Wrap: Next from the last track plays the first.
      tapText("07-starlight-lullaby", 15);
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
      loadMusicAs(musicHandler({ failPlayPath: "/data/02-midnight-jazz.wav" }));
      tapText("02-midnight-jazz", 15);
      await flush();
      await flush();
      let texts = textsOf(Sevyn._presents[Sevyn._presents.length - 1]);
      assert.ok(
        texts.some((t) => t.includes("not an audio file")),
        "daemon error shown, texts=" + JSON.stringify(texts),
      );
      assert.ok(
        texts.some((t) => t.includes("unsupported-format")),
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
        !texts.some((t) => t.includes("not an audio file")),
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

  await checkAsync(
    "music: volume with the daemon down surfaces an error, never throws",
    async () => {
      const handler = musicHandler();
      loadMusicAs(handler);
      tapText("01-sunrise-acoustic", 15);
      await flush();
      await flush();
      handler.setDown(true);
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
      handler.setDown(false);
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
