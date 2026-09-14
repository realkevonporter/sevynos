import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(import.meta.dirname, "build");
await mkdir(output, { recursive: true });
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
