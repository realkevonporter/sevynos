"use strict";
// Unit tests for the Files port's pure modules (v2/apps/src/clipboard.ts,
// volumes.ts, file-icons.ts) — the #122 rules ported 1:1, plus the v2
// additions (volumes/clipboard output parsing, byte formatting, glyphs).
//
// The modules are bundled with esbuild (zero new deps) into a temp
// CommonJS file and driven with node:assert.
//
// Run: node test/files-units-test.js   (from v2/apps, after install)
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

const entry = path.join(os.tmpdir(), "sevyn-files-units-entry.mjs");
const bundle = path.join(os.tmpdir(), "sevyn-files-units-bundle.cjs");
fs.writeFileSync(
  entry,
  "export * as clipboard from " +
    JSON.stringify(path.join(__dirname, "..", "src", "clipboard.ts")) +
    ";\n" +
    "export * as volumes from " +
    JSON.stringify(path.join(__dirname, "..", "src", "volumes.ts")) +
    ";\n" +
    "export * as icons from " +
    JSON.stringify(path.join(__dirname, "..", "src", "file-icons.ts")) +
    ";\n" +
    "export * as selection from " +
    JSON.stringify(path.join(__dirname, "..", "src", "selection.ts")) +
    ";\n",
);

esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
});
const { clipboard, volumes, icons, selection } = require(bundle);

const cutDir = {
  kind: "cut",
  sourcePath: "/Documents/Photos",
  sourceName: "Photos",
  sourceKind: "directory",
};
const copyFile = {
  kind: "copy",
  sourcePath: "/Documents/photo.png",
  sourceName: "photo.png",
  sourceKind: "file",
};

// --- clipboard ---------------------------------------------------------
check("clipboard: joinPath joins without doubling slashes", () => {
  assert.equal(clipboard.joinPath("/", "a"), "/a");
  assert.equal(clipboard.joinPath("/Documents", "a"), "/Documents/a");
  assert.equal(clipboard.joinPath("/Documents/", "a"), "/Documents/a");
});

check("clipboard: splitName splits base and extension", () => {
  assert.deepEqual(clipboard.splitName("photo.png"), {
    base: "photo",
    extension: ".png",
  });
  assert.deepEqual(clipboard.splitName("Docs"), { base: "Docs", extension: "" });
  assert.deepEqual(clipboard.splitName(".gitignore"), {
    base: ".gitignore",
    extension: "",
  });
});

check("clipboard: isPasteIntoSelfOrDescendant refuses self and descendants", () => {
  assert.equal(
    clipboard.isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents/Photos"),
    true,
  );
  assert.equal(
    clipboard.isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents/Photos/Trip"),
    true,
  );
  assert.equal(
    clipboard.isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents"),
    false,
  );
  assert.equal(
    clipboard.isPasteIntoSelfOrDescendant("/Documents/Photos", "/Downloads"),
    false,
  );
  assert.equal(
    clipboard.isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents/Photos2"),
    false,
  );
});

check("clipboard: isCutPasteNoop is a no-op only for a cut into its own parent", () => {
  assert.equal(clipboard.isCutPasteNoop(cutDir, "/Documents"), true);
  assert.equal(clipboard.isCutPasteNoop(cutDir, "/Downloads"), false);
  assert.equal(
    clipboard.isCutPasteNoop({ ...cutDir, kind: "copy" }, "/Documents"),
    false,
  );
});

check("clipboard: resolvePasteTarget returns the plain name with no collision", () => {
  assert.deepEqual(clipboard.resolvePasteTarget(copyFile, "/Downloads", new Set()), {
    targetPath: "/Downloads/photo.png",
    targetName: "photo.png",
  });
});

check("clipboard: resolvePasteTarget suffixes before the extension on collision", () => {
  const existing = new Set(["photo.png", "photo (1).png"]);
  assert.deepEqual(clipboard.resolvePasteTarget(copyFile, "/Downloads", existing), {
    targetPath: "/Downloads/photo (2).png",
    targetName: "photo (2).png",
  });
});

check("clipboard: resolvePasteTarget suffixes folders without an extension", () => {
  const existing = new Set(["Photos"]);
  assert.deepEqual(
    clipboard.resolvePasteTarget(
      {
        kind: "copy",
        sourcePath: "/Documents/Photos",
        sourceName: "Photos",
        sourceKind: "directory",
      },
      "/Downloads",
      existing,
    ),
    { targetPath: "/Downloads/Photos (1)", targetName: "Photos (1)" },
  );
});

check("clipboard: resolvePasteTarget refuses a folder pasted into itself", () => {
  assert.equal(
    clipboard.resolvePasteTarget(cutDir, "/Documents/Photos/Trip", new Set()),
    undefined,
  );
});

check("clipboard: isCrossVolumeMove detects moves between volumes", () => {
  const vols = [{ mountPoint: "/media/usb" }, { mountPoint: "/" }];
  assert.equal(clipboard.isCrossVolumeMove("/Documents/a.txt", "/media/usb", vols), true);
  assert.equal(clipboard.isCrossVolumeMove("/media/usb/a.txt", "/Documents", vols), true);
  assert.equal(
    clipboard.isCrossVolumeMove("/Documents/a.txt", "/Downloads", vols),
    false,
  );
  assert.equal(
    clipboard.isCrossVolumeMove("/media/usb/a.txt", "/media/usb/Photos", vols),
    false,
  );
});

check("clipboard: isCrossDeviceError recognises EXDEV", () => {
  const err = new Error("rename: EXDEV (cross-device link)");
  assert.equal(clipboard.isCrossDeviceError(err), true);
  assert.equal(clipboard.isCrossDeviceError(new Error("boom")), false);
  assert.equal(clipboard.isCrossDeviceError(null), false);
});

// --- volumes -----------------------------------------------------------
check("volumes: isPathOnVolume matches the mount point and its subfolders only", () => {
  assert.equal(volumes.isPathOnVolume("/media/usb", "/media/usb"), true);
  assert.equal(volumes.isPathOnVolume("/media/usb/photos", "/media/usb"), true);
  assert.equal(volumes.isPathOnVolume("/media/usb2", "/media/usb"), false);
  assert.equal(volumes.isPathOnVolume("/", "/media/usb"), false);
  assert.equal(volumes.isPathOnVolume("/Documents", "/media/usb"), false);
});

check("volumes: detectUnpluggedBrowsePath returns the vanished mount point", () => {
  const seen = new Set(["/media/usb", "/media/backup"]);
  assert.equal(volumes.detectUnpluggedBrowsePath("/", seen, []), undefined);
  assert.equal(
    volumes.detectUnpluggedBrowsePath("/media/usb/photos", seen, [
      { mountPoint: "/media/usb" },
    ]),
    undefined,
  );
  assert.equal(
    volumes.detectUnpluggedBrowsePath("/media/usb/photos", seen, [
      { mountPoint: "/media/backup" },
    ]),
    "/media/usb",
  );
  assert.equal(volumes.detectUnpluggedBrowsePath("/media/usb", seen, []), "/media/usb");
  assert.equal(volumes.detectUnpluggedBrowsePath("/media/newstick", seen, []), undefined);
  assert.equal(volumes.detectUnpluggedBrowsePath("/Documents", seen, []), undefined);
});

check("volumes: formatVolumeCapacity renders a free-of-total line", () => {
  assert.equal(
    volumes.formatVolumeCapacity(1000, 250, (bytes) => `${String(bytes)}B`),
    "250B free of 1000B",
  );
  assert.equal(
    volumes.formatVolumeCapacity(0, 0, (bytes) => `${String(bytes)}B`),
    "Size unknown",
  );
});

check("volumes: sortVolumesForSidebar puts / first, then USB alphabetically", () => {
  const sorted = volumes.sortVolumesForSidebar([
    { mountPoint: "/media/zeta", removable: true, label: "Zeta" },
    { mountPoint: "/data", removable: false, label: "data" },
    { mountPoint: "/", removable: false, label: "Internal Drive" },
    { mountPoint: "/media/alpha", removable: true, label: "Alpha" },
  ]);
  assert.deepEqual(
    sorted.map((v) => v.mountPoint),
    ["/", "/data", "/media/alpha", "/media/zeta"],
  );
});

check("volumes: parseVolumesOutput parses the CLI lines and skips malformed ones", () => {
  const parsed = volumes.parseVolumesOutput(
    "/\tInternal Drive\t0\t8000000000\t5000000000\n" +
      "/media/usb\tMYUSB\t1\t16000000000\t9000000000\n" +
      "garbage line\n" +
      "/media/bad\tBAD\t0\tnot-a-number\t0\n",
  );
  assert.deepEqual(parsed, [
    {
      mountPoint: "/",
      label: "Internal Drive",
      removable: false,
      sizeBytes: 8000000000,
      availableBytes: 5000000000,
    },
    {
      mountPoint: "/media/usb",
      label: "MYUSB",
      removable: true,
      sizeBytes: 16000000000,
      availableBytes: 9000000000,
    },
  ]);
});

check("volumes: parseClipboardOutput reads the CLI JSON and treats empty as null", () => {
  assert.equal(volumes.parseClipboardOutput("empty\n"), null);
  assert.equal(volumes.parseClipboardOutput(""), null);
  assert.deepEqual(
    volumes.parseClipboardOutput(
      '{"kind":"copy","sourcePath":"/data/photo.png","sourceName":"photo.png","sourceKind":"file"}\n',
    ),
    {
      kind: "copy",
      sourcePath: "/data/photo.png",
      sourceName: "photo.png",
      sourceKind: "file",
    },
  );
  assert.equal(volumes.parseClipboardOutput("not json"), null);
  assert.equal(
    volumes.parseClipboardOutput('{"kind":"explode","sourcePath":"/x"}'),
    null,
  );
});

check("volumes: formatBytes renders short human-readable sizes", () => {
  assert.equal(volumes.formatBytes(512), "512 B");
  assert.equal(volumes.formatBytes(2048), "2 KB");
  assert.equal(volumes.formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(volumes.formatBytes(Math.round(1.5 * 1024 * 1024 * 1024)), "1.5 GB");
});

// --- file icons ----------------------------------------------------------
check("file-icons: getFileIcon keeps the extension mapping", () => {
  assert.equal(icons.getFileIcon("Photos", "directory"), "folder");
  assert.equal(icons.getFileIcon("photo.png", "file"), "image");
  assert.equal(icons.getFileIcon("song.mp3", "file"), "music-note");
  assert.equal(icons.getFileIcon("clip.mp4", "file"), "film");
  assert.equal(icons.getFileIcon("app.ts", "file"), "gear");
  assert.equal(icons.getFileIcon("notes.txt", "file"), "file-text");
  assert.equal(icons.getFileIcon("unknown.xyz", "file"), "file-text");
});

check("file-icons: fileTileForEntry varies the tile color by type", () => {
  assert.deepEqual(icons.fileTileForEntry("Photos", "directory"), {
    icon: "folder",
    tileColor: "#F5A623",
    kind: "folder",
  });
  assert.equal(icons.fileTileForEntry("photo.png", "file").kind, "image");
  assert.equal(icons.fileTileForEntry("clip.mp4", "file").kind, "video");
  assert.equal(icons.fileTileForEntry("song.mp3", "file").kind, "audio");
  assert.equal(icons.fileTileForEntry("app.ts", "file").kind, "code");
  assert.equal(icons.fileTileForEntry("notes.txt", "file").kind, "document");
  assert.equal(icons.fileTileForEntry("backup.zip", "file").kind, "archive");
  assert.equal(icons.fileTileForEntry("unknown.xyz", "file").kind, "file");
});

check("file-icons: every type gets a distinct tile color", () => {
  const colors = new Set(
    [
      icons.fileTileForEntry("d", "directory"),
      icons.fileTileForEntry("a.png", "file"),
      icons.fileTileForEntry("a.mp4", "file"),
      icons.fileTileForEntry("a.mp3", "file"),
      icons.fileTileForEntry("a.ts", "file"),
      icons.fileTileForEntry("a.txt", "file"),
      icons.fileTileForEntry("a.zip", "file"),
      icons.fileTileForEntry("a.xyz", "file"),
    ].map((tile) => tile.tileColor),
  );
  assert.equal(colors.size, 8);
});

check("file-icons: driveTile is a hard-drive glyph on the drive color", () => {
  assert.deepEqual(icons.driveTile(), {
    icon: "hard-drive",
    tileColor: "#1D9BF0",
    kind: "drive",
  });
});

check("file-icons: glyphForIcon gives every icon a glyph", () => {
  for (const icon of [
    "folder",
    "image",
    "music-note",
    "film",
    "gear",
    "file-text",
    "hard-drive",
  ]) {
    assert.equal(typeof icons.glyphForIcon(icon), "string");
    assert.ok(icons.glyphForIcon(icon).length > 0, icon + " has a glyph");
  }
});

// --- multi-selection (gap unit 13) --------------------------------------
const PLAIN = { shiftKey: false, ctrlKey: false, metaKey: false };
const CTRL = { shiftKey: false, ctrlKey: true, metaKey: false };
const META = { shiftKey: false, ctrlKey: false, metaKey: true };
const SHIFT = { shiftKey: true, ctrlKey: false, metaKey: false };
const NAMES = ["alpha", "beta.txt", "gamma.txt", "delta.txt"];

check("selection: plain click selects one item and moves the anchor", () => {
  const next = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 1, PLAIN);
  assert.deepEqual(next, { selected: ["beta.txt"], anchor: 1 });
  const again = selection.applyPressSelection(NAMES, next, 3, PLAIN);
  assert.deepEqual(again, { selected: ["delta.txt"], anchor: 3 });
});

check("selection: Ctrl-click toggles in and out, anchor moves to it", () => {
  let s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 0, PLAIN);
  s = selection.applyPressSelection(NAMES, s, 2, CTRL);
  assert.deepEqual(s, { selected: ["alpha", "gamma.txt"], anchor: 2 });
  s = selection.applyPressSelection(NAMES, s, 0, CTRL);
  assert.deepEqual(s, { selected: ["gamma.txt"], anchor: 0 });
  s = selection.applyPressSelection(NAMES, s, 2, META);
  assert.deepEqual(s, { selected: [], anchor: 2 });
});

check("selection: Cmd-click (meta) toggles like Ctrl-click", () => {
  const s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 1, META);
  assert.deepEqual(s, { selected: ["beta.txt"], anchor: 1 });
});

check("selection: Shift-click adds the range from the anchor, anchor stays", () => {
  let s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 0, PLAIN);
  s = selection.applyPressSelection(NAMES, s, 2, SHIFT);
  assert.deepEqual(s, { selected: ["alpha", "beta.txt", "gamma.txt"], anchor: 0 });
  // A second Shift-click re-ranges from the same anchor.
  s = selection.applyPressSelection(NAMES, s, 1, SHIFT);
  assert.deepEqual(s, { selected: ["alpha", "beta.txt", "gamma.txt"], anchor: 0 });
  // Upwards works too.
  s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 3, PLAIN);
  s = selection.applyPressSelection(NAMES, s, 1, SHIFT);
  assert.deepEqual(s, { selected: ["beta.txt", "gamma.txt", "delta.txt"], anchor: 3 });
});

check("selection: Shift-click keeps Ctrl-picked items outside the range", () => {
  let s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 0, PLAIN);
  s = selection.applyPressSelection(NAMES, s, 3, CTRL);
  s = selection.applyPressSelection(NAMES, s, 2, SHIFT);
  assert.deepEqual(s, {
    selected: ["alpha", "gamma.txt", "delta.txt"],
    anchor: 3,
  });
});

check("selection: Shift-click with no anchor behaves like a plain click", () => {
  const s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 2, SHIFT);
  assert.deepEqual(s, { selected: ["gamma.txt"], anchor: 2 });
});

check("selection: clearSelection empties the selection and the anchor", () => {
  let s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 0, PLAIN);
  s = selection.applyPressSelection(NAMES, s, 2, CTRL);
  assert.deepEqual(selection.clearSelection(), selection.EMPTY_SELECTION);
  assert.deepEqual(s.selected, ["alpha", "gamma.txt"]);
});

check("selection: press outside the listing leaves the selection alone", () => {
  const s = selection.applyPressSelection(NAMES, selection.EMPTY_SELECTION, 0, PLAIN);
  assert.deepEqual(selection.applyPressSelection(NAMES, s, 9, PLAIN), s);
  assert.deepEqual(selection.applyPressSelection(NAMES, s, -1, CTRL), s);
});

check("selection: resolveMultiPasteTargets suffixes same-named files apart", () => {
  const entries = [
    {
      kind: "copy",
      sourcePath: "/data/photo.png",
      sourceName: "photo.png",
      sourceKind: "file",
    },
    {
      kind: "copy",
      sourcePath: "/other/photo.png",
      sourceName: "photo.png",
      sourceKind: "file",
    },
  ];
  assert.deepEqual(selection.resolveMultiPasteTargets(entries, "/Downloads", new Set()), [
    {
      entry: entries[0],
      targetPath: "/Downloads/photo.png",
      targetName: "photo.png",
    },
    {
      entry: entries[1],
      targetPath: "/Downloads/photo (1).png",
      targetName: "photo (1).png",
    },
  ]);
});

check(
  "selection: resolveMultiPasteTargets refuses the whole paste on a self-paste",
  () => {
    const entries = [
      {
        kind: "copy",
        sourcePath: "/data/a.txt",
        sourceName: "a.txt",
        sourceKind: "file",
      },
      {
        kind: "cut",
        sourcePath: "/data/Photos",
        sourceName: "Photos",
        sourceKind: "directory",
      },
    ];
    assert.equal(
      selection.resolveMultiPasteTargets(entries, "/data/Photos/Trip", new Set()),
      undefined,
    );
  },
);

console.log(`\nfiles units: ${passed} checks passed`);
