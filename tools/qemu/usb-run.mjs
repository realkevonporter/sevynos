import { access, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveQemuDisplayConfiguration } from "./display-configuration.mjs";
import {
  resolveInteractiveHardwareArguments,
  resolveQemuInvocation,
} from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const iso = resolve(output, "sevynos-live.iso");
const qmp = resolve(output, "usb-qmp.sock");
await access(iso);
await rm(qmp, { force: true });
const display = resolveQemuDisplayConfiguration();
const qemuArguments = [
  "-m",
  "4096",
  "-smp",
  "4",
  "-cdrom",
  iso,
  "-boot",
  "d",
  ...resolveInteractiveHardwareArguments(),
  "-device",
  display.device,
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
