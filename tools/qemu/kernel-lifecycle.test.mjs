// Tests for tools/qemu/kernel-lifecycle-lib.sh (Phase 3 B3) and the
// kernel-aware GRUB generation in tools/qemu/grub-cfg-lib.sh.
//
// The shell library is exercised hermetically: every on-disk path and
// every external binary is overridden via environment variables pointing
// at temp dirs and stub scripts. Nothing here touches the real root
// filesystem.
//
// Covers: kernel version detection, module-tree listing, the
// kernel↔modules match assertion, grub.cfg UUID parsing, GRUB generation
// (default + previous-kernel fallback + recovery entries, ESP and legacy),
// versioned-pair pruning, the rollback kernel flip (B2 pairing), and the
// MOK signing helpers (docs/secure-boot.md §7).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_QEMU = new URL("./", import.meta.url).pathname;
const LIB = join(REPO_QEMU, "kernel-lifecycle-lib.sh");
const GRUB_LIB = join(REPO_QEMU, "grub-cfg-lib.sh");

async function writeStub(path, content) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

// runLib <body> — sources the library, then runs <body> (a shell
// fragment). Returns { stdout, stderr }. Extra env via `env`.
async function runLib(body, env = {}) {
  const script = `. "${LIB}"\n${body}`;
  return execFileAsync("sh", ["-c", script], {
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("sevyn_kernel_version parses the Linux banner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const vmlinuz = join(dir, "vmlinuz");
    await writeFile(
      vmlinuz,
      "junk\nLinux version 6.8.0-60-generic (buildd@lcy02-amd64-050) #65-Ubuntu SMP PREEMPT_DYNAMIC\nmore junk\n",
    );
    const { stdout } = await runLib(`sevyn_kernel_version "${vmlinuz}"`);
    assert.equal(stdout.trim(), "6.8.0-60-generic");
    const { stdout: empty } = await runLib(`sevyn_kernel_version "${dir}/nope"`);
    assert.equal(empty.trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const UNSQUASHFS_LISTING_STUB = `#!/bin/sh
# Stub: ignore args, print a canned unsquashfs -l listing.
cat <<'EOF'
squashfs-root/lib/modules/6.8.0-60-generic/kernel/drivers/ata/ahci.ko
squashfs-root/lib/modules/6.8.0-60-generic/kernel/fs/ext4/ext4.ko
squashfs-root/lib/modules/6.8.0-60-generic/modules.dep
squashfs-root/etc/sevynos-release
EOF
`;

test("sevyn_image_modules_versions lists module trees in an image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const stub = join(dir, "unsquashfs");
    await writeStub(stub, UNSQUASHFS_LISTING_STUB);
    const image = join(dir, "image.squashfs");
    await writeFile(image, "dummy");
    const { stdout } = await runLib(`sevyn_image_modules_versions "${image}"`, {
      SEVYN_UNSQUASHFS_BIN: stub,
    });
    assert.equal(stdout.trim(), "6.8.0-60-generic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_assert_kernel_modules_match accepts a matching pair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const vmlinuz = join(dir, "vmlinuz");
    await writeFile(vmlinuz, "Linux version 6.8.0-60-generic (buildd) #1\n");
    const stub = join(dir, "unsquashfs");
    await writeStub(stub, UNSQUASHFS_LISTING_STUB);
    const image = join(dir, "image.squashfs");
    await writeFile(image, "dummy");
    await runLib(`sevyn_assert_kernel_modules_match "${vmlinuz}" "${image}"`, {
      SEVYN_UNSQUASHFS_BIN: stub,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_assert_kernel_modules_match fails loudly on mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const vmlinuz = join(dir, "vmlinuz");
    await writeFile(vmlinuz, "Linux version 6.8.0-99-generic (buildd) #1\n");
    const stub = join(dir, "unsquashfs");
    await writeStub(stub, UNSQUASHFS_LISTING_STUB);
    const image = join(dir, "image.squashfs");
    await writeFile(image, "dummy");
    await assert.rejects(
      runLib(`sevyn_assert_kernel_modules_match "${vmlinuz}" "${image}"`, {
        SEVYN_UNSQUASHFS_BIN: stub,
      }),
      /6\.8\.0-99-generic does not match/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_assert_kernel_modules_match fails when the image has no modules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const vmlinuz = join(dir, "vmlinuz");
    await writeFile(vmlinuz, "Linux version 6.8.0-60-generic (buildd) #1\n");
    const stub = join(dir, "unsquashfs");
    await writeStub(stub, `#!/bin/sh\nprintf 'squashfs-root/etc/x\\n'\n`);
    const image = join(dir, "image.squashfs");
    await writeFile(image, "dummy");
    await assert.rejects(
      runLib(`sevyn_assert_kernel_modules_match "${vmlinuz}" "${image}"`, {
        SEVYN_UNSQUASHFS_BIN: stub,
      }),
      /no kernel modules/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SAMPLE_GRUB_CFG = `# SevynOS GRUB Configuration
set default=0
search --no-floppy --set=root --fs-uuid ROOT-UUID-1
menuentry "SevynOS" {
  search --no-floppy --set=root --fs-uuid ROOT-UUID-1
  linux /boot/vmlinuz-6.8.0-60-generic root=UUID=ROOT-UUID-1 rw
  initrd /boot/initramfs-6.8.0-60-generic.cpio.gz
}
menuentry "SevynOS Recovery" {
  search --no-floppy --set=root --fs-uuid ESP-UUID-2
  linux /EFI/SevynOS/vmlinuz sevyn.recovery=1 sevyn.rootuuid=ROOT-UUID-1
  initrd /EFI/SevynOS/recovery-initramfs.cpio.gz
}
`;

test("sevyn_grub_uuids parses root and ESP UUIDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const cfg = join(dir, "grub.cfg");
    await writeFile(cfg, SAMPLE_GRUB_CFG);
    const { stdout } = await runLib(`sevyn_grub_uuids "${cfg}"`);
    assert.match(stdout, /^root_uuid=ROOT-UUID-1$/m);
    assert.match(stdout, /^esp_uuid=ESP-UUID-2$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_grub_uuids leaves esp_uuid empty when recovery boots from /boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const cfg = join(dir, "grub.cfg");
    await writeFile(
      cfg,
      "search --no-floppy --set=root --fs-uuid ROOT-UUID-1\n" +
        'menuentry "SevynOS Recovery" {\n' +
        "  search --no-floppy --set=root --fs-uuid ROOT-UUID-1\n" +
        "  linux /boot/vmlinuz sevyn.recovery=1 sevyn.rootuuid=ROOT-UUID-1\n" +
        "}\n",
    );
    const { stdout } = await runLib(`sevyn_grub_uuids "${cfg}"`);
    assert.match(stdout, /^root_uuid=ROOT-UUID-1$/m);
    assert.match(stdout, /^esp_uuid=$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_grub_uuids leaves esp_uuid empty without any recovery entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const cfg = join(dir, "grub.cfg");
    await writeFile(
      cfg,
      'search --no-floppy --set=root --fs-uuid ROOT-UUID-1\nmenuentry "SevynOS" {\n}\n',
    );
    const { stdout } = await runLib(`sevyn_grub_uuids "${cfg}"`);
    assert.match(stdout, /^root_uuid=ROOT-UUID-1$/m);
    assert.match(stdout, /^esp_uuid=$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeGrubCfg(dir, env = {}) {
  const out = join(dir, "grub.cfg");
  await execFileAsync(
    "sh",
    [
      "-c",
      `. "${GRUB_LIB}"; sevyn_write_grub_cfg "${out}" "ROOT-UUID-1" ${env.esp ? '"ESP-UUID-2"' : ""}`,
    ],
    { env: { ...process.env, ...env } },
  );
  return readFile(out, "utf8");
}

test("GRUB generation: new kernel default + previous kernel fallback + recovery (ESP)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const cfg = await writeGrubCfg(dir, {
      esp: true,
      SEVYN_KERNEL: "/boot/vmlinuz-6.8.0-60-generic",
      SEVYN_INITRAMFS: "/boot/initramfs-6.8.0-60-generic.cpio.gz",
      SEVYN_PREV_KERNEL: "/boot/vmlinuz",
      SEVYN_PREV_INITRAMFS: "/boot/initramfs.cpio.gz",
    });
    const entries = cfg.match(/^menuentry "/gm) ?? [];
    assert.equal(entries.length, 5, "default + safe + diagnostic + previous + recovery");
    assert.ok(
      cfg.indexOf('menuentry "SevynOS"') <
        cfg.indexOf('menuentry "SevynOS (previous kernel)"'),
    );
    assert.match(
      cfg,
      /menuentry "SevynOS" \{\n {2}search[^\n]*\n {2}linux \/boot\/vmlinuz-6\.8\.0-60-generic root=UUID=ROOT-UUID-1/,
    );
    assert.match(
      cfg,
      /menuentry "SevynOS \(previous kernel\)" \{\n {2}search[^\n]*\n {2}linux \/boot\/vmlinuz root=UUID=ROOT-UUID-1/,
    );
    assert.match(cfg, / {2}initrd \/boot\/initramfs\.cpio\.gz\n/);
    // Recovery entry preserved, still ESP-based with no root=.
    assert.match(
      cfg,
      /menuentry "SevynOS Recovery" \{\n {2}search --no-floppy --set=root --fs-uuid ESP-UUID-2\n/,
    );
    const recoveryLinux = cfg.split("\n").find((l) => l.includes("sevyn.recovery=1"));
    assert.ok(recoveryLinux && !/(^| )root=/.test(recoveryLinux));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GRUB generation: no fallback entry without the previous-kernel overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const cfg = await writeGrubCfg(dir, { esp: true });
    const entries = cfg.match(/^menuentry "/gm) ?? [];
    assert.equal(entries.length, 4);
    assert.ok(!cfg.includes("previous kernel"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GRUB generation: legacy BIOS recovery follows the versioned pair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const cfg = await writeGrubCfg(dir, {
      SEVYN_KERNEL: "/boot/vmlinuz-6.8.0-60-generic",
      SEVYN_INITRAMFS: "/boot/initramfs-6.8.0-60-generic.cpio.gz",
      SEVYN_PREV_KERNEL: "/boot/vmlinuz",
      SEVYN_PREV_INITRAMFS: "/boot/initramfs.cpio.gz",
      SEVYN_RECOVERY_KERNEL: "/boot/vmlinuz-6.8.0-60-generic",
      SEVYN_RECOVERY_INITRAMFS: "/boot/recovery-initramfs-6.8.0-60-generic.cpio.gz",
    });
    assert.match(
      cfg,
      / {2}linux \/boot\/vmlinuz-6\.8\.0-60-generic sevyn\.recovery=1 sevyn\.rootuuid=ROOT-UUID-1 /,
    );
    assert.match(
      cfg,
      / {2}initrd \/boot\/recovery-initramfs-6\.8\.0-60-generic\.cpio\.gz\n/,
    );
    assert.ok(!cfg.includes("/EFI/SevynOS/"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_prune_old_kernels keeps current+previous and never touches unversioned names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  const boot = join(dir, "boot");
  try {
    await mkdir(boot, { recursive: true });
    for (const f of [
      "vmlinuz",
      "initramfs.cpio.gz",
      "recovery-initramfs.cpio.gz",
      "vmlinuz-6.8.0-50-generic",
      "initramfs-6.8.0-50-generic.cpio.gz",
      "recovery-initramfs-6.8.0-50-generic.cpio.gz",
      "vmlinuz-6.8.0-60-generic",
      "initramfs-6.8.0-60-generic.cpio.gz",
      "recovery-initramfs-6.8.0-60-generic.cpio.gz",
      "vmlinuz-6.8.0-40-generic",
      "initramfs-6.8.0-40-generic.cpio.gz",
    ])
      await writeFile(join(boot, f), "x");
    await runLib(`sevyn_prune_old_kernels "${boot}" 6.8.0-60-generic 6.8.0-50-generic`);
    const { readdir } = await import("node:fs/promises");
    const remaining = (await readdir(boot)).sort();
    assert.deepEqual(remaining, [
      "initramfs-6.8.0-50-generic.cpio.gz",
      "initramfs-6.8.0-60-generic.cpio.gz",
      "initramfs.cpio.gz",
      "recovery-initramfs-6.8.0-50-generic.cpio.gz",
      "recovery-initramfs-6.8.0-60-generic.cpio.gz",
      "recovery-initramfs.cpio.gz",
      "vmlinuz",
      "vmlinuz-6.8.0-50-generic",
      "vmlinuz-6.8.0-60-generic",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_kernel_rollback_flip restores the previous pair as default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  const root = join(dir, "root");
  try {
    await mkdir(join(root, "boot", "grub"), { recursive: true });
    await mkdir(join(root, "var", "lib", "sevynos", "updates", "previous"), {
      recursive: true,
    });
    // Both pairs present in /boot (the updater never deletes them).
    for (const f of [
      "vmlinuz-6.8.0-50-generic",
      "initramfs-6.8.0-50-generic.cpio.gz",
      "recovery-initramfs-6.8.0-50-generic.cpio.gz",
      "vmlinuz-6.8.0-60-generic",
      "initramfs-6.8.0-60-generic.cpio.gz",
      "recovery-initramfs-6.8.0-60-generic.cpio.gz",
      "recovery-initramfs.cpio.gz",
    ])
      await writeFile(join(root, "boot", f), `contents-of-${f}`);
    // grub.cfg as the failed update left it: new kernel default.
    await execFileAsync(
      "sh",
      [
        "-c",
        `. "${GRUB_LIB}"; ` +
          `SEVYN_KERNEL=/boot/vmlinuz-6.8.0-60-generic SEVYN_INITRAMFS=/boot/initramfs-6.8.0-60-generic.cpio.gz ` +
          `SEVYN_PREV_KERNEL=/boot/vmlinuz-6.8.0-50-generic SEVYN_PREV_INITRAMFS=/boot/initramfs-6.8.0-50-generic.cpio.gz ` +
          `sevyn_write_grub_cfg "${join(root, "boot", "grub", "grub.cfg")}" "ROOT-UUID-1"`,
      ],
      { env: process.env },
    );
    await writeFile(
      join(root, "var", "lib", "sevynos", "updates", "previous", "kernels.json"),
      JSON.stringify({
        previousKernelVersion: "6.8.0-50-generic",
        previousKernel: "/boot/vmlinuz-6.8.0-50-generic",
        previousInitramfs: "/boot/initramfs-6.8.0-50-generic.cpio.gz",
        previousRecoveryInitramfs: "/boot/recovery-initramfs-6.8.0-50-generic.cpio.gz",
        newKernelVersion: "6.8.0-60-generic",
      }),
    );
    await writeFile(
      join(root, "var", "lib", "sevynos", "updates", "kernels.json"),
      JSON.stringify({
        current: {
          version: "6.8.0-60-generic",
          kernel: "/boot/vmlinuz-6.8.0-60-generic",
          initramfs: "/boot/initramfs-6.8.0-60-generic.cpio.gz",
          recoveryInitramfs: "/boot/recovery-initramfs-6.8.0-60-generic.cpio.gz",
        },
        previous: {
          version: "6.8.0-50-generic",
          kernel: "/boot/vmlinuz-6.8.0-50-generic",
          initramfs: "/boot/initramfs-6.8.0-50-generic.cpio.gz",
          recoveryInitramfs: "/boot/recovery-initramfs-6.8.0-50-generic.cpio.gz",
        },
      }),
    );

    const { stdout } = await runLib(`sevyn_kernel_rollback_flip "${root}"`, {
      SEVYN_GRUB_CFG_LIB: GRUB_LIB,
    });
    assert.match(stdout, /SEVYN_KERNEL_ROLLBACK_DONE/);

    const cfg = await readFile(join(root, "boot", "grub", "grub.cfg"), "utf8");
    // Previous pair is now the default; the failed kernel is the fallback.
    assert.match(
      cfg,
      /menuentry "SevynOS" \{\n {2}search[^\n]*\n {2}linux \/boot\/vmlinuz-6\.8\.0-50-generic root=UUID=ROOT-UUID-1/,
    );
    assert.match(
      cfg,
      /menuentry "SevynOS \(previous kernel\)" \{\n {2}search[^\n]*\n {2}linux \/boot\/vmlinuz-6\.8\.0-60-generic root=UUID=ROOT-UUID-1/,
    );
    // Stable recovery name refreshed from the previous pair.
    assert.equal(
      await readFile(join(root, "boot", "recovery-initramfs.cpio.gz"), "utf8"),
      "contents-of-recovery-initramfs-6.8.0-50-generic.cpio.gz",
    );
    // Pairing state swapped: current is the restored pair again.
    const state = JSON.parse(
      await readFile(
        join(root, "var", "lib", "sevynos", "updates", "kernels.json"),
        "utf8",
      ),
    );
    assert.equal(state.current.version, "6.8.0-50-generic");
    assert.equal(state.previous.version, "6.8.0-60-generic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_kernel_rollback_flip is a no-op without previous/kernels.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const { stdout } = await runLib(`sevyn_kernel_rollback_flip "${dir}"`, {
      SEVYN_GRUB_CFG_LIB: GRUB_LIB,
    });
    assert.match(stdout, /SEVYN_KERNEL_ROLLBACK_SKIP/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_kernel_rollback_flip fails when the previous pair is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  const root = join(dir, "root");
  try {
    await mkdir(join(root, "boot", "grub"), { recursive: true });
    await mkdir(join(root, "var", "lib", "sevynos", "updates", "previous"), {
      recursive: true,
    });
    await writeFile(join(root, "boot", "grub", "grub.cfg"), "x");
    await writeFile(
      join(root, "var", "lib", "sevynos", "updates", "previous", "kernels.json"),
      JSON.stringify({
        previousKernelVersion: "6.8.0-50-generic",
        previousKernel: "/boot/vmlinuz-6.8.0-50-generic",
        previousInitramfs: "/boot/initramfs-6.8.0-50-generic.cpio.gz",
        previousRecoveryInitramfs: "/boot/recovery-initramfs-6.8.0-50-generic.cpio.gz",
        newKernelVersion: "6.8.0-60-generic",
      }),
    );
    await assert.rejects(
      runLib(`sevyn_kernel_rollback_flip "${root}"`, { SEVYN_GRUB_CFG_LIB: GRUB_LIB }),
      /SEVYN_KERNEL_ROLLBACK_FAILED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SBSIGN_STUB = `#!/bin/sh
# Stub sbsign: copy input to --output, recording the key/cert used.
out=""
key=""
cert=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --output) out="$arg" ;;
    --key) key="$arg" ;;
    --cert) cert="$arg" ;;
  esac
  prev="$arg"
done
printf '%s|%s' "$key" "$cert" > "$SEVYN_TEST_SBSIGN_ARGS"
cp "$out" "$out" 2>/dev/null || true
# last arg is the input file
input=""
for arg in "$@"; do
  case "$arg" in --*) ;; *) input="$arg" ;; esac
done
cp "$input" "$out"
`;

test("sevyn_sign_boot_artifacts signs atomically and reports failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    const sbsign = join(dir, "sbsign");
    await writeStub(sbsign, SBSIGN_STUB);
    const artifact = join(dir, "vmlinuz-1");
    await writeFile(artifact, "kernel-bytes");
    await runLib(
      `sevyn_sign_boot_artifacts "${dir}/MOK.priv" "${dir}/MOK.pem" "${artifact}"`,
      {
        SEVYN_SBSIGN_BIN: sbsign,
        SEVYN_TEST_SBSIGN_ARGS: join(dir, "args"),
      },
    );
    assert.equal(
      await readFile(join(dir, "args"), "utf8"),
      `${dir}/MOK.priv|${dir}/MOK.pem`,
    );
    assert.ok(!(await fileExists(`${artifact}.sbsign-tmp`)), "no temp file left behind");

    // Missing artifact -> nonzero.
    await assert.rejects(
      runLib(
        `sevyn_sign_boot_artifacts "${dir}/MOK.priv" "${dir}/MOK.pem" "${dir}/nope"`,
        {
          SEVYN_SBSIGN_BIN: sbsign,
        },
      ),
    );
    // Missing sbsign -> nonzero.
    await assert.rejects(
      runLib(
        `sevyn_sign_boot_artifacts "${dir}/MOK.priv" "${dir}/MOK.pem" "${artifact}"`,
        {
          SEVYN_SBSIGN_BIN: join(dir, "no-such-binary"),
        },
      ),
      /sbsign is not available/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sevyn_sb_fingerprint and sevyn_sb_state_write round-trip state.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-"));
  try {
    // A real self-signed cert via the sandbox openssl.
    await execFileAsync("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "MOK.priv"),
      "-x509",
      "-days",
      "2",
      "-out",
      join(dir, "MOK.pem"),
      "-subj",
      "/CN=test/",
    ]);
    const state = join(dir, "state.json");
    const { stdout } = await runLib(
      `fp=$(sevyn_sb_fingerprint "${dir}/MOK.pem"); ` +
        `[ -n "$fp" ] || exit 1; ` +
        `sevyn_sb_state_write "${state}" "signedWith" "$fp"; ` +
        `sevyn_json_get "${state}" "signedWith"`,
    );
    assert.match(stdout.trim(), /^[0-9a-f]{64}$/);
    // Updating an existing key replaces it instead of duplicating.
    await runLib(`sevyn_sb_state_write "${state}" "signedWith" "abc123"`);
    const content = await readFile(state, "utf8");
    assert.equal(content.match(/"signedWith"/g)?.length, 1);
    assert.match(content, /"signedWith": "abc123"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

const APPLIER = join(REPO_QEMU, "sevyn-apply-update.sh");
const BOOT_HEALTH_LIB = join(REPO_QEMU, "sevyn-boot-health.sh");

// Applier-level tests: the pending.json contract between the OS update
// service (flat kernelPath/kernelSha256/… fields) and the boot-time
// applier's sed parser, plus the pre-extraction kernel preflight gates.
// The applier copy lives under /tmp so its busybox re-exec is skipped;
// SEVYN_INIT_BIN=/bin/true makes abort() exit 0 after moving pending.json
// to failed-*.json.
async function applierFixture() {
  const dir = await mkdtemp(join(tmpdir(), "sevyn-klib-apply-"));
  const updates = join(dir, "updates");
  await mkdir(join(updates, "9.9.9"), { recursive: true });
  const copy = join(dir, "apply-test.sh");
  await execFileAsync("cp", [APPLIER, copy]);
  const env = {
    ...process.env,
    SEVYN_UPDATES_DIR: updates,
    SEVYN_INIT_BIN: "/bin/true",
    SEVYN_BOOT_HEALTH_LIB: BOOT_HEALTH_LIB,
    SEVYN_KERNEL_LIFECYCLE_LIB: LIB,
  };
  return {
    dir,
    updates,
    copy,
    env,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function stagePayload(fx, extraFields = {}) {
  const { createHash } = await import("node:crypto");
  const payload = Buffer.from("fake-new-rootfs");
  const payloadPath = join(fx.updates, "9.9.9", "rootfs.squashfs");
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
      ...extraFields,
    }),
  );
  return { payloadPath, sha };
}

test("applier aborts loudly on a half kernel pair in pending.json", async () => {
  const fx = await applierFixture();
  try {
    const kernel = join(fx.dir, "vmlinuz");
    await writeFile(kernel, "Linux version 6.8.0-60-generic (buildd) #1\n");
    const { createHash } = await import("node:crypto");
    const khash = createHash("sha256")
      .update(await readFile(kernel))
      .digest("hex");
    await stagePayload(fx, { kernelPath: kernel, kernelSha256: khash });
    const { stdout } = await execFileAsync("sh", [fx.copy], { env: fx.env });
    assert.match(stdout, /SEVYN_UPDATE_ABORT/);
    assert.match(stdout, /half a kernel pair/);
    assert.ok(!(await fileExists(join(fx.updates, "pending.json"))));
  } finally {
    await fx.cleanup();
  }
});

test("applier aborts before extraction on kernel/modules mismatch", async () => {
  const fx = await applierFixture();
  try {
    const kernel = join(fx.dir, "vmlinuz");
    await writeFile(kernel, "Linux version 6.8.0-99-generic (buildd) #1\n");
    const initramfs = join(fx.dir, "initramfs.cpio.gz");
    await writeFile(initramfs, "fake-initramfs");
    const { createHash } = await import("node:crypto");
    const khash = createHash("sha256")
      .update(await readFile(kernel))
      .digest("hex");
    const ihash = createHash("sha256")
      .update(await readFile(initramfs))
      .digest("hex");
    await stagePayload(fx, {
      kernelPath: kernel,
      kernelSha256: khash,
      initramfsPath: initramfs,
      initramfsSha256: ihash,
    });
    // unsquashfs stub: -l lists modules for 6.8.0-60-generic, not the
    // staged 6.8.0-99 kernel.
    const unsquashfs = join(fx.dir, "unsquashfs");
    await writeStub(
      unsquashfs,
      `#!/bin/sh\nprintf 'squashfs-root/lib/modules/6.8.0-60-generic/kernel/x.ko\\n'\n`,
    );
    const { stdout } = await execFileAsync("sh", [fx.copy], {
      env: { ...fx.env, SEVYN_UNSQUASHFS_BIN: unsquashfs },
    });
    assert.match(stdout, /SEVYN_UPDATE_ABORT/);
    assert.match(stdout, /kernel\/modules version mismatch/);
    // No partial state: the snapshot was never taken, the payload never
    // extracted.
    assert.ok(!(await fileExists(join(fx.updates, "previous", "kernels.json"))));
    assert.ok(!(await fileExists(join(fx.updates, "pending.json"))));
  } finally {
    await fx.cleanup();
  }
});
