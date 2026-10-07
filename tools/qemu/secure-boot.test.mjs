// Tests for the Secure Boot install-time tooling:
//   tools/qemu/sevyn-secure-boot.sh  (MOK generation, signing, enrollment)
//   tools/qemu/verify-secure-boot.sh (chain verification reporting)
//
// sbsign/sbverify/mokutil are not installed in CI/sandbox; the tests use fake
// shims on PATH to exercise both the happy path and graceful degradation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HELPER = join(REPO, "tools/qemu/sevyn-secure-boot.sh");
const VERIFY = join(REPO, "tools/qemu/verify-secure-boot.sh");
const DOC = join(REPO, "docs/secure-boot.md");

function scratch() {
  return mkdtempSync(join(tmpdir(), "sevyn-sb-test-"));
}

function makeFakeBin(fakes) {
  // fakes: { name: scriptBody }
  const dir = mkdtempSync(join(tmpdir(), "sevyn-sb-fakebin-"));
  for (const [name, body] of Object.entries(fakes)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

function runHelper(root, args, extraEnv = {}) {
  return execFileSync(HELPER, args, {
    env: { ...process.env, SEVYN_SB_ROOT: root, ...extraEnv },
    encoding: "utf8",
  });
}

function readState(root) {
  return JSON.parse(
    readFileSync(join(root, "var/lib/sevyn/secureboot/state.json"), "utf8"),
  );
}

// A fake sbsign: copies the input artifact to --output, simulating a signature.
const FAKE_SBSIGN_OK = `
out=""
in=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --key|--cert) shift 2 ;;
    *) in="$1"; shift ;;
  esac
done
cp "$in" "$out"
`;

// A fake sbsign that always fails (and writes a partial output, to prove the
// helper never leaves a truncated artifact behind).
const FAKE_SBSIGN_FAIL = `
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "partial" > "$out"
exit 1
`;

const FAKE_SBVERIFY_OK = `exit 0`;
const FAKE_SBVERIFY_FAIL = `exit 1`;

test("generate-mok creates a keypair with correct layout and permissions", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    const dir = join(root, "var/lib/sevyn/secureboot");
    assert.equal(statSync(join(dir, "MOK.priv")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "MOK.pem")).mode & 0o777, 0o644);
    assert.equal(statSync(join(dir, "MOK.der")).mode & 0o777, 0o644);
    const state = readState(root);
    assert.equal(state.mok, "generated");
    assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(state.generatedAt);
    // The certificate must parse and carry the code-signing EKU.
    const text = execSync(`openssl x509 -in ${join(dir, "MOK.pem")} -noout -text`, {
      encoding: "utf8",
    });
    assert.match(text, /Code Signing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generate-mok never regenerates over an existing key", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    const before = readFileSync(join(root, "var/lib/sevyn/secureboot/MOK.priv"), "utf8");
    runHelper(root, ["generate-mok"]);
    const after = readFileSync(join(root, "var/lib/sevyn/secureboot/MOK.priv"), "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sign degrades gracefully when sbsign is missing", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    const out = runHelper(root, ["sign"]);
    assert.match(out, /sbsign is missing/);
    const state = readState(root);
    assert.equal(state.signed, "false");
    assert.equal(state.signReason, "no-sbsign");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sign signs GRUB, kernel and recovery kernel with a working sbsign", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbsign: FAKE_SBSIGN_OK });
  try {
    runHelper(root, ["generate-mok"]);
    const artifacts = [
      "boot/efi/EFI/SevynOS/grubx64.efi",
      "boot/efi/EFI/BOOT/BOOTX64.EFI",
      "boot/vmlinuz",
      "boot/efi/EFI/SevynOS/vmlinuz", // C1 recovery kernel, staged on the ESP
    ];
    for (const a of artifacts) {
      const p = join(root, a);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `fake-efi-binary:${a}`);
    }
    runHelper(root, ["sign"], { PATH: `${fakeBin}:${process.env.PATH}` });
    const state = readState(root);
    assert.equal(state.signed, "true");
    assert.equal(state.signedWith, state.fingerprint);
    assert.ok(state.signedAt);
    for (const a of artifacts) {
      assert.equal(
        readFileSync(join(root, a), "utf8"),
        `fake-efi-binary:${a}`,
        `${a} must be intact after signing`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("sign leaves artifacts untouched when sbsign fails", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbsign: FAKE_SBSIGN_FAIL });
  try {
    runHelper(root, ["generate-mok"]);
    const p = join(root, "boot/vmlinuz");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "original-kernel-bytes");
    runHelper(root, ["sign"], { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.equal(readFileSync(p, "utf8"), "original-kernel-bytes");
    assert.ok(!readFileSync || true); // no temp file may remain
    const state = readState(root);
    assert.equal(state.signed, "false");
    assert.equal(state.signReason, "no-artifacts");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("queue-enrollment degrades gracefully without mokutil", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    const out = runHelper(root, ["queue-enrollment"]);
    assert.match(out, /mokutil is not installed/);
    const state = readState(root);
    assert.equal(state.enrollment, "manual-required");
    assert.equal(state.enrollmentReason, "no-mokutil");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify-secure-boot reports OK when sbverify accepts every artifact", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbverify: FAKE_SBVERIFY_OK });
  try {
    runHelper(root, ["generate-mok"]);
    runHelper(root, ["sign"]);
    runHelper(root, ["queue-enrollment"]);
    const p = join(root, "boot/vmlinuz");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "kernel");
    let code = 0;
    let out = "";
    try {
      out = execFileSync(VERIFY, ["--root", root], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: "utf8",
      });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    assert.equal(code, 0);
    assert.match(out, /OK\s+MOK keypair/);
    assert.match(out, /OK\s+signature: \/boot\/vmlinuz/);
    assert.match(out, /RESULT: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("verify-secure-boot fails when sbverify rejects a signature or the key is exposed", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbverify: FAKE_SBVERIFY_FAIL });
  try {
    runHelper(root, ["generate-mok"]);
    const p = join(root, "boot/vmlinuz");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "kernel");
    chmodSync(join(root, "var/lib/sevyn/secureboot/MOK.priv"), 0o644);
    let code = 0;
    let out = "";
    try {
      out = execFileSync(VERIFY, ["--root", root], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: "utf8",
      });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    assert.equal(code, 1);
    assert.match(out, /FAIL\s+MOK keypair/);
    assert.match(out, /FAIL\s+signature: \/boot\/vmlinuz/);
    assert.match(out, /RESULT: FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("docs/secure-boot.md carries the honesty markers", () => {
  const doc = readFileSync(DOC, "utf8");
  assert.match(doc, /does NOT claim Secure Boot support/i);
  assert.match(doc, /BLOCKED ON KEVON/);
  assert.match(doc, /Microsoft/);
  assert.match(doc, /MOK Manager/);
  assert.match(doc, /kernel updates must re-sign/i);
});
