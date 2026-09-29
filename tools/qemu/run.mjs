import { access, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveQemuDisplayConfiguration } from "./display-configuration.mjs";
import {
  resolveInteractiveHardwareArguments,
  resolveQemuInvocation,
} from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const kernel = resolve(output, "vmlinuz");
const initrd = resolve(output, "initramfs.cpio.gz");
const iso = resolve(output, "sevynos-live.iso");
const data = resolve(output, "data.img");
const qmp = resolve(output, "qmp.sock");
await Promise.all([access(kernel), access(initrd), access(iso)]);
const display = resolveQemuDisplayConfiguration();
const focusTrace = process.env.SEVYN_QEMU_FOCUS_TRACE === "1";
const bitmapDiagnostics = process.env.SEVYN_QEMU_BITMAP_DIAGNOSTICS === "1";
const hasData = await access(data).then(
  () => true,
  () => false,
);
await rm(qmp, { force: true });
const qemuArguments = [
  "-m",
  "4096",
  "-smp",
  "4",
  "-kernel",
  kernel,
  "-initrd",
  initrd,
  "-drive",
  `file=${iso},media=cdrom,readonly=on`,
  ...(hasData ? ["-drive", `file=${data},format=raw,if=virtio`] : []),
  "-append",
  `boot=live components live-media-path=/live init=/init console=tty0 console=ttyS0,115200 panic=-1 loglevel=8 ignore_loglevel sevyn.live=1 ${display.kernelVideo}${focusTrace ? " sevyn.focus-trace=1" : ""}${bitmapDiagnostics ? " sevyn.bitmap-diagnostics=1" : ""}`,
  "-device",
  display.device,
  ...resolveInteractiveHardwareArguments(),
  "-device",
  "qemu-xhci",
  "-device",
  "usb-kbd",
  "-device",
  "usb-tablet",
  "-display",
  process.platform === "darwin" ? "cocoa,gl=off,full-grab=off" : "default",
  "-serial",
  "stdio",
  "-qmp",
  `unix:${qmp},server=on,wait=off`,
  "-no-reboot",
  "-no-shutdown",
];
const invocation = await resolveQemuInvocation(output, qemuArguments, { visible: true });
const child = spawn(invocation.command, invocation.arguments, { stdio: "inherit" });
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
