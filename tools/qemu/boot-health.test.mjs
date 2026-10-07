// Tests for tools/qemu/sevyn-boot-health.sh (boot-attempt counting,
// rollback trigger/decision, snapshot verification, history rotation)
// and the rollback mode of tools/qemu/sevyn-apply-update.sh.
//
// The pre-update snapshot slot is the one shared with the manual
// recovery environment: updates/previous/{rootfs.squashfs,version.json}
// (written by the applier's snapshot_previous), plus the tamper-evident
// pin at <trust>/previous.sha256.
//
// The shell library is exercised hermetically: every on-disk path is
// overridden via environment variables pointing at temp dirs, and the
// destructive binaries (mksquashfs/unsquashfs) are stub scripts. Nothing
// here touches the real root filesystem.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_QEMU = new URL("./", import.meta.url).pathname;
const LIB = join(REPO_QEMU, "sevyn-boot-health.sh");
const APPLIER = join(REPO_QEMU, "sevyn-apply-update.sh");

const MKSQUASHFS_STUB = `#!/bin/sh
# Stub: pretend to snapshot; write a small stand-in payload to the
# output file (the 2nd argument, like the real mksquashfs invocation).
printf 'fake-squashfs-backup' > "$2"
`;

const UNSQUASHFS_STUB = `#!/bin/sh
# Stub: record the arguments, then succeed without touching anything.
printf '%s\\n' "$@" > "$SEVYN_TEST_UNSQUASHFS_ARGS"
`;

const UNSQUASHFS_FAIL_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$SEVYN_TEST_UNSQUASHFS_ARGS"
exit 1
`;

const APPLIER_STUB = `#!/bin/sh
# Stub for the applier binary: record the arguments, then succeed.
printf '%s\\n' "$@" > "$SEVYN_TEST_APPLIER_ARGS"
`;

async function writeStub(path, content) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "sevyn-boot-health-"));
  const updates = join(root, "updates");
  const trust = join(root, "trust");
  const machineState = join(root, "machine-state");
  const etcDir = join(root, "etc");
  await mkdir(join(updates, "previous"), { recursive: true });
  await mkdir(trust, { recursive: true });
  await mkdir(machineState, { recursive: true });
  await mkdir(etcDir, { recursive: true });
  // Machine-identity fixture: must round-trip through preserve/restore.
  await writeFile(join(etcDir, "hostname"), "test-machine\n", "utf8");
  const releaseFile = join(root, "sevynos-release");
  await writeFile(releaseFile, "VERSION_ID=1.2.4\n", "utf8");

  const mksquashfs = join(root, "stub-mksquashfs.sh");
  const unsquashfs = join(root, "stub-unsquashfs.sh");
  const applier = join(root, "stub-applier.sh");
  await writeStub(mksquashfs, MKSQUASHFS_STUB);
  await writeStub(unsquashfs, UNSQUASHFS_STUB);
  await writeStub(applier, APPLIER_STUB);

  const env = {
    ...process.env,
    SEVYN_UPDATES_DIR: updates,
    SEVYN_UPDATE_TRUST_DIR: trust,
    SEVYN_OS_RELEASE_FILE: releaseFile,
    SEVYN_MACHINE_STATE_DIR: machineState,
    SEVYN_ETC_DIR: etcDir,
    SEVYN_MKSQUASHFS_BIN: mksquashfs,
    SEVYN_UNSQUASHFS_BIN: unsquashfs,
    SEVYN_APPLY_UPDATE_BIN: applier,
    SEVYN_INIT_BIN: "/bin/true",
    SEVYN_TEST_LIB: LIB,
    SEVYN_TEST_APPLIER_ARGS: join(root, "applier-args.txt"),
    SEVYN_TEST_UNSQUASHFS_ARGS: join(root, "unsquashfs-args.txt"),
  };
  return {
    root,
    updates,
    previousDir: join(updates, "previous"),
    trust,
    machineState,
    releaseFile,
    env,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runShell(env, script) {
  return execFileAsync("sh", ["-c", script], { env });
}

function check(env) {
  return runShell(env, '. "$SEVYN_TEST_LIB"; sevyn_boot_health_check');
}

async function readCounter(updates) {
  return (await readFile(join(updates, "boot-attempts"), "utf8")).trim();
}

async function historyEvents(updates) {
  const raw = await readFile(join(updates, "rollback-history.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Installs a valid pre-update snapshot (payload + version.json + pin). */
async function installSnapshot(fx, version = "1.2.3") {
  const payload = Buffer.from(`fake-snapshot-${version}`);
  await writeFile(join(fx.previousDir, "rootfs.squashfs"), payload);
  const sha = createHash("sha256").update(payload).digest("hex");
  await writeFile(
    join(fx.previousDir, "version.json"),
    JSON.stringify({ version, appliedAt: "2026-10-07T00:00:00.000Z", sha256: sha }),
  );
  await writeFile(join(fx.trust, "previous.sha256"), `${sha}\n`);
}

test("increments the boot-attempt counter on boots without a marker", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());

  const first = await check(fx.env);
  assert.match(first.stdout, /SEVYN_BOOT_ATTEMPT count=1/);
  assert.equal(await readCounter(fx.updates), "1");

  const second = await check(fx.env);
  assert.match(second.stdout, /SEVYN_BOOT_ATTEMPT count=2/);
  assert.doesNotMatch(second.stdout, /ROLLBACK/);
  assert.equal(await readCounter(fx.updates), "2");
});

test("consumes the session-ready marker and resets the counter", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await writeFile(join(fx.updates, "boot-attempts"), "2\n", "utf8");
  await writeFile(
    join(fx.updates, "session-ready"),
    "2026-10-07T00:00:00.000Z\n",
    "utf8",
  );

  const result = await check(fx.env);
  assert.doesNotMatch(result.stdout, /SEVYN_BOOT_ATTEMPT/);
  assert.equal(await readCounter(fx.updates), "0");
  assert.equal(await fileExists(join(fx.updates, "session-ready")), false);
});

test("treats a corrupt counter as zero", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await writeFile(join(fx.updates, "boot-attempts"), "bogus\n", "utf8");

  await check(fx.env);
  assert.equal(await readCounter(fx.updates), "1");
});

test("does not trigger rollback below the threshold", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await installSnapshot(fx);

  await check(fx.env);
  assert.equal(await readCounter(fx.updates), "1");
  assert.equal(await fileExists(fx.env["SEVYN_TEST_APPLIER_ARGS"]), false);
});

test("triggers rollback on the Nth consecutive failed boot", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await installSnapshot(fx);
  await writeFile(join(fx.updates, "boot-attempts"), "2\n", "utf8");

  const result = await check(fx.env);
  assert.match(result.stdout, /SEVYN_ROLLBACK_TRIGGERED attempts=3/);
  const args = await readFile(fx.env["SEVYN_TEST_APPLIER_ARGS"], "utf8");
  assert.equal(args.trim(), "rollback");
});

test("honours a SEVYN_MAX_FAILED_BOOTS override", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await installSnapshot(fx);
  await writeFile(join(fx.updates, "boot-attempts"), "1\n", "utf8");

  const result = await check({ ...fx.env, SEVYN_MAX_FAILED_BOOTS: "2" });
  assert.match(result.stdout, /SEVYN_ROLLBACK_TRIGGERED attempts=2/);
});

test("records rollback-unavailable and resets when the snapshot is missing", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await writeFile(join(fx.updates, "boot-attempts"), "2\n", "utf8");

  const result = await check(fx.env);
  assert.match(result.stdout, /SEVYN_ROLLBACK_UNAVAILABLE reason=no-verified-snapshot/);
  const events = await historyEvents(fx.updates);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "rollback-unavailable");
  assert.match(events[0].reason, /no verified pre-update snapshot/);
  assert.equal(await readCounter(fx.updates), "0");
});

function applierCopy(fx) {
  const dest = join(fx.root, "apply-test.sh");
  return copyFile(APPLIER, dest).then(() => dest);
}

async function runApplierRollback(fx, extraEnv = {}) {
  const copy = await applierCopy(fx);
  return runShell(
    { ...fx.env, SEVYN_BOOT_HEALTH_LIB: LIB, ...extraEnv },
    `sh "${copy}" rollback`,
  );
}

test("applier rollback aborts when the pin does not match", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await writeFile(join(fx.previousDir, "rootfs.squashfs"), "tampered-payload");
  const realSha = createHash("sha256").update("tampered-payload").digest("hex");
  await writeFile(
    join(fx.previousDir, "version.json"),
    JSON.stringify({
      version: "1.2.3",
      appliedAt: "2026-10-07T00:00:00.000Z",
      sha256: realSha,
    }),
  );
  await writeFile(join(fx.trust, "previous.sha256"), `${"0".repeat(64)}\n`);

  const result = await runApplierRollback(fx);
  assert.match(
    result.stdout,
    /SEVYN_ROLLBACK_ABORTED reason=snapshot-verification-failed/,
  );
  assert.equal(await fileExists(fx.env["SEVYN_TEST_UNSQUASHFS_ARGS"]), false);
  const events = await historyEvents(fx.updates);
  assert.equal(events[0].event, "rollback-aborted");
  assert.match(events[0].reason, /unverified payload/);
  // The tampered snapshot is left alone for forensics; it is never restored.
  assert.equal(await fileExists(join(fx.previousDir, "rootfs.squashfs")), true);
});

test("applier rollback aborts when version.json sha does not match", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await writeFile(join(fx.previousDir, "rootfs.squashfs"), "corrupted-payload");
  await writeFile(
    join(fx.previousDir, "version.json"),
    JSON.stringify({
      version: "1.2.3",
      appliedAt: "2026-10-07T00:00:00.000Z",
      sha256: "0".repeat(64),
    }),
  );

  const result = await runApplierRollback(fx);
  assert.match(
    result.stdout,
    /SEVYN_ROLLBACK_ABORTED reason=snapshot-verification-failed/,
  );
  assert.equal(await fileExists(fx.env["SEVYN_TEST_UNSQUASHFS_ARGS"]), false);
});

test("applier rollback falls back to version.json when the pin is absent", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  // Snapshot written by an older applier (pre-pin): version.json only.
  const payload = Buffer.from("old-snapshot");
  await writeFile(join(fx.previousDir, "rootfs.squashfs"), payload);
  const sha = createHash("sha256").update(payload).digest("hex");
  await writeFile(
    join(fx.previousDir, "version.json"),
    JSON.stringify({
      version: "1.2.2",
      appliedAt: "2026-10-07T00:00:00.000Z",
      sha256: sha,
    }),
  );
  await writeFile(join(fx.updates, "boot-attempts"), "3\n", "utf8");

  const result = await runApplierRollback(fx);
  assert.match(result.stdout, /SEVYN_ROLLBACK_COMPLETE from=1\.2\.4 to=1\.2\.2/);
  assert.equal(await fileExists(fx.env["SEVYN_TEST_UNSQUASHFS_ARGS"]), true);
});

test("applier rollback restores the snapshot and records history", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await installSnapshot(fx, "1.2.3");
  await writeFile(join(fx.updates, "boot-attempts"), "3\n", "utf8");
  await writeFile(
    join(fx.updates, "pending.json"),
    JSON.stringify({
      version: "1.2.4",
      payloadPath: "/tmp/x",
      sha256: "y",
      sizeBytes: 1,
    }),
  );
  // Machine state that must survive the restore.
  await writeFile(join(fx.machineState, "marker.txt"), "keep me\n", "utf8");

  const result = await runApplierRollback(fx);
  assert.match(result.stdout, /SEVYN_ROLLBACK_RESTORING from=1\.2\.4 to=1\.2\.3/);
  assert.match(result.stdout, /SEVYN_ROLLBACK_COMPLETE from=1\.2\.4 to=1\.2\.3/);

  // unsquashfs was invoked to extract the snapshot over /.
  const args = (await readFile(fx.env["SEVYN_TEST_UNSQUASHFS_ARGS"], "utf8")).split("\n");
  assert.deepEqual(args.slice(0, 3), ["-f", "-d", "/"]);
  assert.equal(args[3], join(fx.previousDir, "rootfs.squashfs"));

  // The snapshot is NOT consumed: it stays in place for the manual
  // recovery environment's "Roll Back Update" entry, which shares it.
  assert.equal(await fileExists(join(fx.previousDir, "rootfs.squashfs")), true);
  assert.equal(await fileExists(join(fx.previousDir, "version.json")), true);
  assert.equal(await fileExists(join(fx.trust, "previous.sha256")), true);

  // Counter reset; history recorded with versions and reason.
  assert.equal(await readCounter(fx.updates), "0");
  const events = await historyEvents(fx.updates);
  assert.equal(events[0].event, "rollback");
  assert.equal(events[0].fromVersion, "1.2.4");
  assert.equal(events[0].toVersion, "1.2.3");
  assert.match(events[0].reason, /3 consecutive boots/);

  // The stale pending.json was moved aside so the broken update is not re-applied.
  assert.equal(await fileExists(join(fx.updates, "pending.json")), false);
  const leftovers = (await readdir(fx.updates)).filter((n) => n.startsWith("failed-"));
  assert.equal(leftovers.length, 1);

  // Machine state survived the restore.
  assert.equal(await readFile(join(fx.machineState, "marker.txt"), "utf8"), "keep me\n");
  assert.equal(
    await readFile(join(fx.env["SEVYN_ETC_DIR"], "hostname"), "utf8"),
    "test-machine\n",
  );
});

test("applier rollback retries on extraction failure", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  await installSnapshot(fx, "1.2.3");
  await writeFile(join(fx.updates, "boot-attempts"), "3\n", "utf8");
  const failingUnsquashfs = join(fx.root, "stub-unsquashfs-fail.sh");
  await writeStub(failingUnsquashfs, UNSQUASHFS_FAIL_STUB);

  const result = await runApplierRollback(fx, {
    SEVYN_UNSQUASHFS_BIN: failingUnsquashfs,
  });
  assert.match(result.stdout, /SEVYN_ROLLBACK_FAILED reason=extraction-failed/);
  // Counter is NOT reset so the next boot retries the restore.
  assert.equal(await readCounter(fx.updates), "3");
  const events = await historyEvents(fx.updates);
  assert.equal(events[0].event, "rollback-failed");
});

test("apply path writes the snapshot pin on success", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());
  // Stage a payload the applier will verify and "apply".
  const payload = Buffer.from("fake-new-rootfs");
  const payloadPath = join(fx.updates, "9.9.9", "rootfs.squashfs");
  await mkdir(join(fx.updates, "9.9.9"), { recursive: true });
  await writeFile(payloadPath, payload);
  const sha = createHash("sha256").update(payload).digest("hex");
  await writeFile(
    join(fx.updates, "pending.json"),
    JSON.stringify({
      version: "9.9.9",
      payloadPath,
      sha256: sha,
      sizeBytes: payload.byteLength,
      stagedAt: "2026-10-07T00:00:00.000Z",
    }),
  );
  // Machine state fixture (the apply path preserves + restores it).
  await writeFile(join(fx.machineState, "marker.txt"), "keep me\n", "utf8");
  const copy = await applierCopy(fx);

  const result = await runShell(
    { ...fx.env, SEVYN_BOOT_HEALTH_LIB: LIB },
    `sh "${copy}"`,
  );
  assert.match(result.stdout, /SEVYN_UPDATE_SNAPSHOT_DONE version=1\.2\.4/);
  assert.match(result.stdout, /SEVYN_UPDATE_APPLIED version=9\.9\.9/);

  // The snapshot slot holds the pre-update system; the pin matches it.
  const snapSha = (await readFile(join(fx.previousDir, "rootfs.squashfs"), "utf8"))
    .length;
  assert.ok(snapSha > 0);
  const meta = JSON.parse(await readFile(join(fx.previousDir, "version.json"), "utf8"));
  assert.equal(meta.version, "1.2.4");
  const pin = (await readFile(join(fx.trust, "previous.sha256"), "utf8")).trim();
  assert.equal(pin, meta.sha256);

  // The staged payload was consumed and machine state survived.
  assert.equal(await fileExists(join(fx.updates, "pending.json")), false);
  assert.equal(await readFile(join(fx.machineState, "marker.txt"), "utf8"), "keep me\n");
});

test("rotates the rollback history to a bounded size", async (t) => {
  const fx = await makeFixture();
  t.after(() => fx.cleanup());

  // Rotation keeps the most recent KEEP entries once the log grows past
  // 2x KEEP (so the file is not rewritten on every event). 50 appends:
  // at #41 the log is cut to the last 20 (events 22..41), then 42..50
  // are appended -> 29 lines, still bounded far below 2x KEEP.
  await runShell(
    fx.env,
    `. "$SEVYN_TEST_LIB"; i=1; while [ "$i" -le 50 ]; do ` +
      `sevyn_record_history "rollback" "1.0.$i" "1.0.0" "reason $i"; ` +
      `i=$((i + 1)); done`,
  );

  const events = await historyEvents(fx.updates);
  assert.equal(events.length, 29);
  assert.equal(events[0].fromVersion, "1.0.22");
  assert.equal(events[28].fromVersion, "1.0.50");

  // A pathological loop stays bounded: 200 more appends never exceed 2x KEEP.
  await runShell(
    fx.env,
    `. "$SEVYN_TEST_LIB"; i=1; while [ "$i" -le 200 ]; do ` +
      `sevyn_record_history "rollback" "2.0.$i" "1.0.0" "reason $i"; ` +
      `i=$((i + 1)); done`,
  );
  const later = await historyEvents(fx.updates);
  assert.ok(later.length <= 40);
  assert.equal(later[later.length - 1].fromVersion, "2.0.200");
});
