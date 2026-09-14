import { access, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";
import { QmpClient } from "./qmp-client.mjs";

const output = resolve(import.meta.dirname, "build");
const qmpPath = resolve(output, "input-test-qmp.sock");
const serialPath = resolve(output, "input-test-serial.log");
await Promise.all([
  access(resolve(output, "vmlinuz")),
  access(resolve(output, "initramfs.cpio.gz")),
  access(resolve(output, "sevynos-live.iso")),
  access(resolve(output, "data.img")),
]);
await Promise.all([rm(qmpPath, { force: true }), rm(serialPath, { force: true })]);
const argumentsValue = [
  "-m",
  "4096",
  "-smp",
  "2",
  "-kernel",
  resolve(output, "vmlinuz"),
  "-initrd",
  resolve(output, "initramfs.cpio.gz"),
  "-drive",
  `file=${resolve(output, "sevynos-live.iso")},media=cdrom,readonly=on`,
  "-drive",
  `file=${resolve(output, "data.img")},format=raw,if=virtio`,
  "-append",
  "boot=live components live-media-path=/live init=/init console=ttyS0 panic=-1 sevyn.live=1 sevyn.guest-input-test=1",
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
const invocation = await resolveQemuInvocation(output, argumentsValue, { visible: true });
const child = spawn(invocation.command, invocation.arguments, { stdio: "ignore" });
try {
  await waitForMarker(serialPath, "SEVYN_QEMU_INPUT_DEVICES_INITIALIZED", 90_000);
  await waitForMarker(serialPath, "SEVYN_GENESIS_INPUT_PATH_INITIALIZED", 90_000);
  await waitForMarker(
    serialPath,
    "SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED",
    90_000,
  );
  const qmp = await QmpClient.connect(qmpPath);
  await qmp.command("input-send-event", {
    events: [
      { type: "abs", data: { axis: "x", value: 18_000 } },
      { type: "abs", data: { axis: "y", value: 14_000 } },
      { type: "btn", data: { button: "left", down: true } },
      { type: "btn", data: { button: "left", down: false } },
    ],
  });
  await waitForMarker(serialPath, "SEVYN_GENESIS_INPUT_DEVICES_INITIALIZED", 10_000);
  await waitForMarker(serialPath, "SEVYN_GENESIS_POINTER_INPUT_RECEIVED", 10_000);
  await qmp.command("send-key", {
    keys: [{ type: "qcode", data: "s" }],
  });
  await waitForMarker(serialPath, "SEVYN_GENESIS_KEYBOARD_INPUT_RECEIVED", 10_000);
  await qmp.command("quit");
  qmp.close();
  console.log(
    "QEMU guest input: pointer and keyboard reached the validated Genesis path.",
  );
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
}

async function waitForMarker(path, marker, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const contents = await readFile(path, "utf8").catch(() => "");
    if (contents.includes(marker)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${marker}.`);
}
