import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSigningKeyEnv, signFeedFile } from "../update-signing/sign-feed.mjs";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(import.meta.dirname, "build");
// OS version stamped into the image at /etc/sevynos-release and published in
// updates.json. Format: <pkg>-nightly.YYYYMMDD.<shortsha>.
const rootPkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const buildDate = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const shortSha = process.env["GITHUB_SHA"]?.slice(0, 7) ?? "local";
const osVersion = `${String(rootPkg.version)}-nightly.${buildDate}.${shortSha}`;
await mkdir(output, { recursive: true });

// ─── Update trust anchor ─────────────────────────────────────────────
// The device's feed-verification trust anchor: public keys only, baked into
// the image at /etc/sevynos/trusted-update-keys.json (see the Dockerfile
// COPY below and tools/update-signing/README.md). The private signing key
// NEVER enters the image. Without SEVYN_UPDATE_TRUSTED_KEYS the image ships
// an empty trust store and the on-device updater fails closed.
{
  const staged = resolve(output, "trusted-update-keys.json");
  const raw = process.env["SEVYN_UPDATE_TRUSTED_KEYS"];
  if (raw === undefined || raw.trim().length === 0) {
    console.warn(
      "WARNING: SEVYN_UPDATE_TRUSTED_KEYS is not set — the image will ship " +
        "an EMPTY update trust store and the on-device updater will refuse " +
        "all feeds (fail-closed). Set it to the public trusted-update-keys.json.",
    );
    await writeFile(staged, `${JSON.stringify({ keys: [] }, null, 2)}\n`, {
      mode: 0o644,
    });
  } else {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("SEVYN_UPDATE_TRUSTED_KEYS is not valid JSON.");
    }
    const keys = parsed?.keys;
    if (!Array.isArray(keys))
      throw new Error('SEVYN_UPDATE_TRUSTED_KEYS must be JSON with a "keys" array.');
    for (const [index, entry] of keys.entries()) {
      const jwk = entry?.publicKeyJwk;
      if (
        typeof entry?.keyId !== "string" ||
        jwk?.kty !== "OKP" ||
        jwk?.crv !== "Ed25519" ||
        typeof jwk?.x !== "string"
      )
        throw new Error(
          `SEVYN_UPDATE_TRUSTED_KEYS.keys[${String(index)}] must have a keyId and an Ed25519 publicKeyJwk.`,
        );
    }
    await writeFile(staged, `${JSON.stringify({ keys }, null, 2)}\n`, { mode: 0o644 });
    console.log(`Update trust anchor staged with ${String(keys.length)} public key(s).`);
  }
}
for (const generated of [
  "vmlinuz",
  "initramfs.cpio.gz",
  "rootfs.squashfs",
  "data-template.img",
  "sevynos-live.iso",
  "kernel-version.txt",
  "SHA256SUMS",
  "boot-manifest.json",
])
  await rm(resolve(output, generated), { force: true });
await run("docker", [
  "build",
  "--file",
  resolve(import.meta.dirname, "Dockerfile"),
  "--build-arg",
  `SEVYN_OS_VERSION=${osVersion}`,
  "--no-cache-filter=boot-media",
  "--output",
  `type=local,dest=${output}`,
  root,
]);
const checksums = await readFile(resolve(output, "SHA256SUMS"), "utf8");
const dataImage = resolve(output, "data.img");
const hasDataImage = await access(dataImage).then(
  () => true,
  () => false,
);
if (!hasDataImage) await copyFile(resolve(output, "data-template.img"), dataImage);
await writeFile(
  resolve(output, "boot-manifest.json"),
  `${JSON.stringify(
    {
      formatVersion: 3,
      architecture: "x86_64",
      kernelVersion: (
        await readFile(resolve(output, "kernel-version.txt"), "utf8")
      ).trim(),
      checksums: checksums.trim().split("\n"),
      bootMedia: {
        file: "sevynos-live.iso",
        type: "hybrid-iso",
        firmware: ["bios", "uefi-x86_64"],
        rootFilesystem: "squashfs-overlay",
        rootFilesystemFile: "rootfs.squashfs",
        dataDiskRequired: false,
        persistence: "optional-SEVYN_DATA-volume",
      },
      expectedLiveUsbMarkers: [
        "SEVYN_LIVE_USB_ROOT_READY",
        "SEVYN_VOLATILE_STORAGE_ACTIVE",
        "SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED",
      ],
      expectedSerialMarkers: [
        "SEVYN_QEMU_KERNEL_BOOTED",
        "SEVYN_QEMU_PERSISTENT_STORAGE_MOUNTED",
        "SEVYN_QEMU_WESTON_READY",
        "SEVYN_GENESIS_RUST_BRIDGE_CONNECTED",
        "SEVYN_GENESIS_TYPESCRIPT_RUNTIME_INITIALIZED",
        "SEVYN_GENESIS_DISPLAY_REGISTERED",
        "SEVYN_GENESIS_SYSTEM_APPLICATIONS_LAUNCHED",
        "SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED",
        "SEVYN_GENESIS_INPUT_PATH_INITIALIZED",
        "SEVYN_GENESIS_CLIPBOARD_INITIALIZED",
        "SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE",
        "SEVYN_QEMU_CONTROLLED_SHUTDOWN",
      ],
      expectedVisibleSerialMarkers: [
        "SEVYN_QEMU_GRAPHICAL_WESTON_READY",
        "SEVYN_QEMU_INPUT_DEVICES_INITIALIZED",
        "SEVYN_GENESIS_VISIBLE_SURFACE_CONFIGURED",
        "SEVYN_GENESIS_INPUT_DEVICES_INITIALIZED",
        "SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED",
      ],
    },
    null,
    2,
  )}\n`,
);
console.log(`SevynOS live USB and QEMU boot artifacts written to ${output}`);

// updates.json: the versioned update feed consumed by the OS update service.
// The workflow publishes this alongside the rootfs artifact for nightly
// releases (URL template baked into the image at build time via
// SEVYN_UPDATE_FEED_URL / defaultUpdateFeedUrl()).
{
  const rootfsPath = resolve(output, "rootfs.squashfs");
  const rootfsStat = await stat(rootfsPath);
  const rootfsHash = createHash("sha256");
  for await (const chunk of createReadStream(rootfsPath)) {
    rootfsHash.update(chunk);
  }
  const artifactUrl =
    process.env["SEVYN_UPDATE_ARTIFACT_URL"] ??
    `https://github.com/realkevonporter/sevynos/releases/download/nightly/rootfs.squashfs`;
  const feedPath = resolve(output, "updates.json");
  await writeFile(
    feedPath,
    `${JSON.stringify(
      {
        version: osVersion,
        publishedAt: new Date().toISOString(),
        releaseNotes: `SevynOS nightly ${osVersion}.`,
        artifacts: [
          {
            kind: "rootfs-squashfs",
            url: artifactUrl,
            sha256: rootfsHash.digest("hex"),
            sizeBytes: rootfsStat.size,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  // Sign the feed when a signing key is available. Without it the feed
  // ships unsigned and on-device updaters (which fail closed) will refuse
  // it — correct for dev builds, loud on purpose.
  const signingKeyEnv = process.env["SEVYN_UPDATE_SIGNING_KEY"];
  if (signingKeyEnv === undefined || signingKeyEnv.trim().length === 0) {
    console.warn(
      "WARNING: SEVYN_UPDATE_SIGNING_KEY is not set — updates.json is UNSIGNED " +
        "and devices with a trust anchor will refuse this feed.",
    );
  } else {
    const keyId = await signFeedFile(feedPath, await parseSigningKeyEnv(signingKeyEnv));
    console.log(`Update feed signed with key "${keyId}".`);
  }
  console.log(`Update feed written for version ${osVersion}`);
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited with ${String(code)}`)),
    );
  });
}
