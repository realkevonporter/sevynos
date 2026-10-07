/**
 * Tests for the SevynOS recovery environment (Phase 3, Worker C).
 *
 * Covers: the shared GRUB config generator (recovery menuentry, ESP vs
 * legacy-BIOS variants), the pure helpers in recovery-lib.sh (cmdline
 * parsing, preserved-path rules, manifest normalization, the
 * updates/previous snapshot contract), the recovery menu's operation list,
 * the factory-reset Unix-account cleanup, and the preserve/restore
 * round-trip used by rollback and reinstall. Shell is exercised through
 * `sh -c`; sourcing recovery-lib.sh has no side effects by design.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const qemuDir = dirname(fileURLToPath(import.meta.url));
const recoveryBase = join(qemuDir, "recovery", "usr", "lib", "sevyn", "recovery");
const recoveryLib = join(recoveryBase, "recovery-lib.sh");
const grubCfgLib = join(qemuDir, "grub-cfg-lib.sh");

function shSourceLib(script) {
  // Runs `script` with recovery-lib.sh sourced; SEVYN_RECOVERY_BASE points
  // at the repo tree so no initramfs is needed.
  return execFileSync("sh", ["-c", `. "${recoveryLib}"; ${script}`], {
    encoding: "utf8",
    env: { ...process.env, SEVYN_RECOVERY_BASE: recoveryBase },
  });
}

function shExpectFail(script) {
  assert.throws(() => shSourceLib(script));
}

function extractFunction(file, name) {
  // Pull one top-level `name() { … }` function out of a shell script so it
  // can be evaluated without running the rest of the file.
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${name}() {`);
  assert.notEqual(start, -1, `function ${name} not found in ${file}`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.notEqual(end, -1, `end of ${name} not found in ${file}`);
  return lines.slice(start, end + 1).join("\n");
}

function writeGrubCfg(rootUuid, espUuid) {
  const out = join(mkdtempSync(join(tmpdir(), "sevyn-grub-")), "grub.cfg");
  const espArg = espUuid === undefined ? "" : ` "${espUuid}"`;
  execFileSync(
    "sh",
    ["-c", `. "${grubCfgLib}"; sevyn_write_grub_cfg "${out}" "${rootUuid}"${espArg}`],
    { encoding: "utf8" },
  );
  return readFileSync(out, "utf8");
}

test("all recovery shell scripts are syntactically valid", () => {
  const scripts = [
    grubCfgLib,
    join(qemuDir, "build-recovery-image.sh"),
    join(qemuDir, "build-image.sh"),
    join(qemuDir, "build-live-media.sh"),
    join(qemuDir, "sevyn-installer.sh"),
    join(qemuDir, "sevyn-installer-chroot.sh"),
    join(qemuDir, "sevyn-apply-update.sh"),
    join(qemuDir, "recovery", "init"),
    join(recoveryBase, "recovery-lib.sh"),
    join(recoveryBase, "recovery-menu.sh"),
    join(recoveryBase, "rollback.sh"),
    join(recoveryBase, "reinstall.sh"),
    join(recoveryBase, "factory-reset.sh"),
    join(recoveryBase, "disk-check.sh"),
    join(recoveryBase, "view-logs.sh"),
  ];
  for (const script of scripts) {
    execFileSync("sh", ["-n", script]);
  }
});

test("GRUB config with an ESP boots recovery without the main rootfs", () => {
  const cfg = writeGrubCfg("ROOT-UUID-1", "ESP-UUID-2");
  const entries = cfg.match(/^menuentry "/gm) ?? [];
  assert.equal(entries.length, 4, "SevynOS + safe graphics + diagnostic + recovery");
  assert.match(
    cfg,
    /menuentry "SevynOS Recovery" \{\n {2}search --no-floppy --set=root --fs-uuid ESP-UUID-2\n/,
  );
  assert.match(
    cfg,
    / {2}linux \/EFI\/SevynOS\/vmlinuz sevyn\.recovery=1 sevyn\.rootuuid=ROOT-UUID-1 /,
  );
  assert.match(cfg, / {2}initrd \/EFI\/SevynOS\/recovery-initramfs\.cpio\.gz\n/);
  // The recovery linux line must not mount the main rootfs…
  const recoveryLinux = cfg.split("\n").find((l) => l.includes("sevyn.recovery=1"));
  assert.ok(recoveryLinux && !/(^| )root=/.test(recoveryLinux));
  // …while the normal entries still do.
  assert.match(
    cfg,
    /menuentry "SevynOS" \{\n {2}search[^}]*root=UUID=ROOT-UUID-1 rw init=\/init/s,
  );
});

test("GRUB config without an ESP falls back to /boot on the root filesystem", () => {
  const cfg = writeGrubCfg("ROOT-UUID-1");
  assert.match(
    cfg,
    /menuentry "SevynOS Recovery" \{\n {2}search --no-floppy --set=root --fs-uuid ROOT-UUID-1\n/,
  );
  assert.match(
    cfg,
    / {2}linux \/boot\/vmlinuz sevyn\.recovery=1 sevyn\.rootuuid=ROOT-UUID-1 /,
  );
  assert.match(cfg, / {2}initrd \/boot\/recovery-initramfs\.cpio\.gz\n/);
  assert.ok(!cfg.includes("/EFI/SevynOS/"));
});

test("GRUB config requires a root UUID", () => {
  assert.throws(() =>
    execFileSync("sh", ["-c", `. "${grubCfgLib}"; sevyn_write_grub_cfg /tmp/x ""`]),
  );
});

test("cmdline_value reads the sevyn.rootuuid hint", () => {
  const out = shSourceLib(
    `cmdline_value sevyn.rootuuid "BOOT_IMAGE=/vmlinuz sevyn.recovery=1 sevyn.rootuuid=DEAD-BEEF ro quiet"`,
  );
  assert.equal(out.trim(), "DEAD-BEEF");
  shExpectFail(`cmdline_value sevyn.rootuuid "BOOT_IMAGE=/vmlinuz ro quiet"`);
});

test("path_preserved keeps user/machine state and drops OS paths", () => {
  const keep = [
    "boot",
    "boot/vmlinuz",
    "var/lib/sevyn/users/alice",
    "var/lib/sevyn/accounts/registry.json",
    "var/lib/sevynos/updates/previous/rootfs.squashfs",
    "etc/hostname",
    "etc/machine-id",
    "var/log/syslog",
    "media",
    "tmp",
  ];
  const drop = [
    "usr/bin/dialog",
    "etc/passwd",
    "etc/shadow",
    "var/lib/sevyn/apps/registry.json",
    "var/lib/sevynox", // near-miss: must not match the var/lib/sevyn/users prefix
    "opt/sevynos/genesis-wayland.mjs",
  ];
  for (const p of keep) {
    shSourceLib(`path_preserved "${p}"`);
  }
  for (const p of drop) {
    shExpectFail(`path_preserved "${p}"`);
  }
});

test("restore_moved_paths covers the account databases", () => {
  const out = shSourceLib("restore_moved_paths");
  for (const p of [
    "var/lib/sevyn/users",
    "var/lib/sevyn/accounts",
    "etc/passwd",
    "etc/shadow",
    "etc/group",
    "etc/gshadow",
    "etc/hostname",
    "etc/machine-id",
  ]) {
    assert.ok(out.split("\n").includes(p), `missing ${p}`);
  }
});

test("manifest_paths normalizes unsquashfs -ll output", () => {
  const dir = mkdtempSync(join(tmpdir(), "sevyn-manifest-"));
  const sampleFile = join(dir, "sample.txt");
  writeFileSync(
    sampleFile,
    [
      "squashfs-root",
      "drwxr-xr-x root/root                 52 2026-10-07 14:00 squashfs-root/usr",
      "-rw-r--r-- root/root                123 2026-10-07 14:00 squashfs-root/usr/bin/dialog",
      "lrwxrwxrwx root/root                  7 2026-10-07 14:00 squashfs-root/bin/sh",
    ].join("\n") + "\n",
  );
  const out = shSourceLib(`manifest_paths < "${sampleFile}"`);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(out.trim().split("\n"), ["/", "/bin/sh", "/usr", "/usr/bin/dialog"]);
});

test("previous_snapshot_valid enforces the rollback contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "sevyn-prev-"));
  const prev = join(dir, "var", "lib", "sevynos", "updates", "previous");
  mkdirSync(prev, { recursive: true });
  const payload = join(prev, "rootfs.squashfs");
  writeFileSync(payload, "fake-squashfs-bytes");
  const sha = createHash("sha256").update("fake-squashfs-bytes").digest("hex");
  const versionJson = join(prev, "version.json");
  const check = () => shSourceLib(`previous_snapshot_valid "${dir}"`).trim();

  // Missing version.json → invalid.
  shExpectFail(`previous_snapshot_valid "${dir}"`);

  writeFileSync(
    versionJson,
    `{"version":"0.2.0","appliedAt":"2026-10-07T00:00:00Z","sha256":"${sha}"}\n`,
  );
  assert.equal(check(), "version=0.2.0");

  // Tampered payload → invalid.
  writeFileSync(payload, "tampered-bytes");
  shExpectFail(`previous_snapshot_valid "${dir}"`);

  rmSync(dir, { recursive: true, force: true });
});

test("pending_update_present detects a staged update", () => {
  const dir = mkdtempSync(join(tmpdir(), "sevyn-pending-"));
  const updates = join(dir, "var", "lib", "sevynos", "updates");
  shExpectFail(`pending_update_present "${dir}"`);
  mkdirSync(updates, { recursive: true });
  writeFileSync(join(updates, "pending.json"), "{}\n");
  shSourceLib(`pending_update_present "${dir}"`);
  rmSync(dir, { recursive: true, force: true });
});

test("recovery menu lists every required operation", () => {
  const fn = extractFunction(join(recoveryBase, "recovery-menu.sh"), "menu_items");
  const out = execFileSync("sh", ["-c", `${fn}; menu_items`], { encoding: "utf8" });
  const tags = out
    .trim()
    .split("\n")
    .map((l) => l.split("|")[0]);
  assert.deepEqual(tags, [
    "rollback",
    "reinstall",
    "reset",
    "diskcheck",
    "logs",
    "reboot",
    "poweroff",
  ]);
  // Every destructive/maintenance operation maps to a shipped, executable script.
  const opScripts = {
    rollback: "rollback.sh",
    reinstall: "reinstall.sh",
    reset: "factory-reset.sh",
    diskcheck: "disk-check.sh",
    logs: "view-logs.sh",
  };
  for (const [op, file] of Object.entries(opScripts)) {
    assert.ok(tags.includes(op), `menu missing ${op}`);
    const mode = statSync(join(recoveryBase, file)).mode;
    assert.ok(mode & 0o111, `${file} must be executable`);
  }
});

test("remove_unix_user deletes the account but never root", () => {
  const dir = mkdtempSync(join(tmpdir(), "sevyn-reset-"));
  const etc = join(dir, "etc");
  mkdirSync(etc, { recursive: true });
  writeFileSync(
    join(etc, "passwd"),
    "root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/var/lib/sevyn/users/alice:/usr/sbin/nologin\n",
  );
  writeFileSync(
    join(etc, "shadow"),
    "root:!:1:0:99999:7:::\nalice:$y$j9T$salt$hash:20000:0:99999:7:::\n",
  );
  writeFileSync(join(etc, "group"), "root:x:0:\nsudo:x:27:alice,bob\nalice:x:1000:\n");
  writeFileSync(join(etc, "gshadow"), "root:!::\nsudo:!::alice,bob\nalice:!::\n");
  const fn = extractFunction(join(recoveryBase, "factory-reset.sh"), "remove_unix_user");
  const run = (user) =>
    execFileSync("sh", ["-c", `${fn}; remove_unix_user "${dir}" "${user}"`], {
      encoding: "utf8",
    });

  run("alice");
  const passwd = readFileSync(join(etc, "passwd"), "utf8");
  assert.ok(passwd.includes("root:x:0:0"), "root entry kept");
  assert.ok(!passwd.includes("alice"), "alice entry removed");
  const group = readFileSync(join(etc, "group"), "utf8");
  assert.ok(!/^alice:/m.test(group), "alice group removed");
  assert.match(group, /^sudo:x:27:bob$/m, "alice dropped from sudo members, bob kept");
  const shadow = readFileSync(join(etc, "shadow"), "utf8");
  assert.ok(!/^alice:/m.test(shadow), "alice shadow removed");

  // root is never removed, even if requested.
  run("root");
  assert.ok(readFileSync(join(etc, "passwd"), "utf8").includes("root:x:0:0"));
  // Hostile usernames are ignored.
  run("alice;touch");
  assert.ok(!readFileSync(join(etc, "passwd"), "utf8").includes("touch"));

  rmSync(dir, { recursive: true, force: true });
});

test("stash_preserved / restore_preserved_back round-trips user state", () => {
  const dir = mkdtempSync(join(tmpdir(), "sevyn-stash-"));
  const root = join(dir, "root");
  const keep = join(dir, "keep");
  mkdirSync(join(root, "var", "lib", "sevyn", "users", "alice"), { recursive: true });
  mkdirSync(join(root, "var", "lib", "sevyn", "accounts"), { recursive: true });
  mkdirSync(join(root, "etc"), { recursive: true });
  writeFileSync(
    join(root, "var", "lib", "sevyn", "users", "alice", "notes.txt"),
    "precious\n",
  );
  writeFileSync(
    join(root, "etc", "passwd"),
    "root:x:0:0::/root:/bin/bash\nalice:x:1000:1000::/x:/usr/sbin/nologin\n",
  );
  writeFileSync(join(root, "etc", "hostname"), "sevynos\n");
  const fns = [
    extractFunction(recoveryLib, "restore_moved_paths"),
    extractFunction(recoveryLib, "stash_preserved"),
    extractFunction(recoveryLib, "restore_preserved_back"),
  ].join("\n");
  const run = (script) =>
    execFileSync("sh", ["-c", `${fns}; ${script}`], { encoding: "utf8" });

  run(`stash_preserved "${root}" "${keep}"`);
  assert.throws(() => statSync(join(root, "etc", "passwd")), "passwd moved aside");
  assert.throws(() => statSync(join(root, "var", "lib", "sevyn", "users", "alice")));
  assert.equal(
    readFileSync(
      join(keep, "var", "lib", "sevyn", "users", "alice", "notes.txt"),
      "utf8",
    ),
    "precious\n",
  );

  // Simulate the image extraction clobbering the tree, then move back.
  writeFileSync(join(root, "etc", "passwd"), "root:x:0:0::/root:/bin/bash\n");
  run(`restore_preserved_back "${root}" "${keep}"`);
  const passwd = readFileSync(join(root, "etc", "passwd"), "utf8");
  assert.ok(passwd.includes("alice:x:1000"), "current account database restored");
  assert.equal(
    readFileSync(
      join(root, "var", "lib", "sevyn", "users", "alice", "notes.txt"),
      "utf8",
    ),
    "precious\n",
    "user data restored",
  );
  assert.equal(readFileSync(join(root, "etc", "hostname"), "utf8"), "sevynos\n");

  rmSync(dir, { recursive: true, force: true });
});
