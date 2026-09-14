import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const disk = resolve(output, "installer-smoke-disk.img");
const firmware = process.env.SEVYN_QEMU_FIRMWARE ?? "bios";
if (firmware !== "bios" && firmware !== "uefi")
  throw new Error("SEVYN_QEMU_FIRMWARE must be bios or uefi.");
const uefiFirmware = firmware === "uefi" ? await resolveUefiFirmware() : undefined;
for (const file of ["vmlinuz", "initramfs.cpio.gz", "sevynos-live.iso"])
  await access(resolve(output, file));
await rm(disk, { force: true });
await run("qemu-img", ["create", "-f", "raw", disk, "32G"], 30_000);

const common = [
  ...(uefiFirmware === undefined
    ? []
    : [
        "-machine",
        "q35",
        "-drive",
        `if=pflash,format=raw,readonly=on,file=${uefiFirmware}`,
      ]),
  "-m",
  "3072",
  "-smp",
  "2",
  "-device",
  "virtio-vga",
  "-device",
  "qemu-xhci",
  "-device",
  "usb-kbd",
  "-device",
  "usb-tablet",
  "-nographic",
  "-no-reboot",
];
const install = await qemu(
  [
    ...common,
    "-kernel",
    resolve(output, "vmlinuz"),
    "-initrd",
    resolve(output, "initramfs.cpio.gz"),
    "-drive",
    `file=${resolve(output, "sevynos-live.iso")},media=cdrom,readonly=on`,
    "-drive",
    `file=${disk},format=raw,if=virtio`,
    "-append",
    "boot=live components live-media-path=/live init=/init console=ttyS0,115200 console=tty0 panic=-1 sevyn.live=1 sevyn.installer=1 sevyn.install.erase=/dev/vda",
  ],
  360_000,
);
requireMarker(install, "SEVYN_INSTALL_COMPLETE", "installer completion");

const installedBoot = await qemu(
  [...common, "-drive", `file=${disk},format=raw,if=virtio`, "-boot", "c"],
  150_000,
  "SEVYN_INSTALLED_MODE",
);
requireMarker(installedBoot, "SEVYN_INSTALLED_MODE", "installed-system boot");
console.log("SevynOS installer smoke: blank disk installed and booted successfully.");

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
  throw new Error("No x86-64 UEFI firmware image was found.");
}

async function qemu(arguments_, timeout, stopMarker) {
  const invocation = await resolveQemuInvocation(output, arguments_);
  return capture(invocation.command, invocation.arguments, timeout, stopMarker);
}

function requireMarker(outputText, marker, stage) {
  if (!outputText.includes(marker))
    throw new Error(`Missing ${marker} during ${stage}.\n${outputText.slice(-8000)}`);
}

function run(command, arguments_, timeout) {
  return capture(command, arguments_, timeout);
}

function capture(command, arguments_, timeout, stopMarker) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let outputText = "";
    const append = (chunk) => {
      outputText += chunk.toString();
      if (stopMarker && outputText.includes(stopMarker) && child.exitCode === null)
        child.kill("SIGTERM");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out.\n${outputText.slice(-8000)}`));
    }, timeout);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || (stopMarker && outputText.includes(stopMarker)))
        resolvePromise(outputText);
      else
        reject(
          new Error(`Command exited with ${code ?? signal}.\n${outputText.slice(-8000)}`),
        );
    });
  });
}
