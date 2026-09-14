import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { QmpClient } from "./qmp-client.mjs";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const iso = resolve(output, "sevynos-live.iso");
const qmpPath = resolve(output, "capture-qmp.sock");
const serialPath = resolve(output, "capture-serial.log");
const capturePath = resolve(output, "desktop-capture.ppm");
await access(iso);
await Promise.all([
  rm(qmpPath, { force: true }),
  rm(serialPath, { force: true }),
  rm(capturePath, { force: true }),
]);

const invocation = await resolveQemuInvocation(output, [
  "-m",
  "4096",
  "-smp",
  "4",
  "-cdrom",
  iso,
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
]);
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
  await waitForMarker("SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED", 180_000);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  qmp = await QmpClient.connect(qmpPath);
  await qmp.command("screendump", { filename: capturePath });
  await access(capturePath);
  await qmp.command("quit");
  qmp.close();
  qmp = undefined;
  console.log(capturePath);
} catch (error) {
  if (qemuError.trim() !== "") console.error(qemuError.trim());
  throw error;
} finally {
  qmp?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
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
