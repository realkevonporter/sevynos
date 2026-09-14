import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { QmpClient } from "./qmp-client.mjs";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const iso = resolve(output, "sevynos-live.iso");
const firmware = process.env.SEVYN_QEMU_FIRMWARE ?? "bios";
if (firmware !== "bios" && firmware !== "uefi")
  throw new Error("SEVYN_QEMU_FIRMWARE must be either bios or uefi.");
const uefiFirmware = firmware === "uefi" ? await resolveUefiFirmware() : undefined;
const qmpPath = resolve(output, `usb-${firmware}-smoke-qmp.sock`);
const serialPath = resolve(output, `usb-${firmware}-smoke-serial.log`);
await access(iso);
await Promise.all([rm(qmpPath, { force: true }), rm(serialPath, { force: true })]);

const qemuArguments = [
  "-m",
  "4096",
  "-smp",
  "2",
  "-cdrom",
  iso,
  ...(uefiFirmware === undefined
    ? []
    : [
        "-machine",
        "q35",
        "-drive",
        `if=pflash,format=raw,readonly=on,file=${uefiFirmware}`,
      ]),
  "-boot",
  "d",
  "-netdev",
  "user,id=sevyn-net",
  "-device",
  "virtio-net-pci,netdev=sevyn-net",
  "-device",
  "virtio-vga,xres=1280,yres=720",
  "-device",
  "qemu-xhci",
  "-device",
  "usb-kbd",
  "-device",
  "usb-tablet",
  "-display",
  "none",
  "-serial",
  `file:${serialPath}`,
  "-qmp",
  `unix:${qmpPath},server=on,wait=off`,
  "-no-reboot",
];
const invocation = await resolveQemuInvocation(output, qemuArguments);
const child = spawn(invocation.command, invocation.arguments, {
  stdio: ["ignore", "ignore", "pipe"],
});
let qemuError = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  qemuError += chunk;
});
let qmp;
try {
  await waitForMarker("SEVYN_LIVE_USB_ROOT_READY", 120_000);
  await waitForMarker("SEVYN_VOLATILE_STORAGE_ACTIVE", 30_000);
  await waitForMarker("SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED", 120_000);
  qmp = await QmpClient.connect(qmpPath);
  await qmp.command("quit");
  qmp.close();
  qmp = undefined;
  console.log(
    `SevynOS live media booted the Genesis desktop with ${firmware.toUpperCase()} firmware and no hard disk.`,
  );
} catch (error) {
  if (qemuError.trim() !== "") console.error(qemuError.trim());
  throw error;
} finally {
  qmp?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
}

async function resolveUefiFirmware() {
  const configured = process.env.SEVYN_QEMU_UEFI_FIRMWARE;
  const candidates = [
    ...(configured === undefined ? [] : [configured]),
    "/usr/local/share/qemu/edk2-x86_64-code.fd",
    "/opt/homebrew/share/qemu/edk2-x86_64-code.fd",
    "/usr/share/OVMF/OVMF_CODE.fd",
  ];
  for (const candidate of candidates)
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  throw new Error(
    "No x86-64 UEFI firmware was found. Set SEVYN_QEMU_UEFI_FIRMWARE to an EDK2 or OVMF code image.",
  );
}

async function waitForMarker(marker, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const contents = await readFile(serialPath, "utf8").catch(() => "");
    if (contents.includes(marker)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${marker}.`);
}
