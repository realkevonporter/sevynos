import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const manifest = JSON.parse(
  await readFile(resolve(output, "boot-manifest.json"), "utf8"),
);
const qemuArguments = [
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
  "boot=live components live-media-path=/live init=/init console=ttyS0 panic=-1 sevyn.live=1 sevyn.headless=1 sevyn.full-desktop-smoke=1",
  "-device",
  "virtio-vga,xres=1280,yres=720",
  "-device",
  "qemu-xhci",
  "-device",
  "usb-kbd",
  "-device",
  "usb-tablet",
  "-nographic",
  "-no-reboot",
];
const invocation = await resolveQemuInvocation(output, qemuArguments);
const result = await capture(invocation.command, invocation.arguments, 120_000);
for (const marker of manifest.expectedSerialMarkers)
  if (!result.includes(marker))
    throw new Error(`QEMU serial output is missing ${marker}.`);
console.log(
  "QEMU smoke: kernel booted and the native Genesis Wayland frame was presented.",
);

function capture(command, arguments_, timeout) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let outputText = "";
    child.stdout.on("data", (chunk) => {
      outputText += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      outputText += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`QEMU timed out.\n${outputText}`));
    }, timeout);
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(outputText);
    });
  });
}
