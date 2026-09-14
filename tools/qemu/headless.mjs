import { access, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const kernel = resolve(output, "vmlinuz");
const initrd = resolve(output, "initramfs.cpio.gz");
const iso = resolve(output, "sevynos-live.iso");
const data = resolve(output, "data.img");
const qmp = resolve(output, "qmp.sock");
await Promise.all([access(kernel), access(initrd), access(iso)]);
const hasData = await access(data).then(
  () => true,
  () => false,
);
await rm(qmp, { force: true });
const qemuArguments = [
  "-m",
  "4096",
  "-smp",
  "2",
  "-kernel",
  kernel,
  "-initrd",
  initrd,
  "-drive",
  `file=${iso},media=cdrom,readonly=on`,
  ...(hasData ? ["-drive", `file=${data},format=raw,if=virtio`] : []),
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
  "-qmp",
  `unix:${qmp},server=on,wait=off`,
  "-nographic",
  "-no-reboot",
];
const invocation = await resolveQemuInvocation(output, qemuArguments);
const child = spawn(invocation.command, invocation.arguments, { stdio: "inherit" });
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
