import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("QEMU development environment", () => {
  it("contains reproducible build, run, cleanup, and real boot smoke definitions", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const qemuRoot = resolve(root, "tools/qemu");
    await Promise.all([
      access(resolve(qemuRoot, "build.mjs")),
      access(resolve(qemuRoot, "run.mjs")),
      access(resolve(qemuRoot, "headless.mjs")),
      access(resolve(qemuRoot, "input-test.mjs")),
      access(resolve(qemuRoot, "focus-latency-test.mjs")),
      access(resolve(qemuRoot, "stop.mjs")),
      access(resolve(qemuRoot, "clean.mjs")),
      access(resolve(qemuRoot, "smoke.mjs")),
      access(resolve(qemuRoot, "usb-run.mjs")),
      access(resolve(qemuRoot, "usb-smoke.mjs")),
      access(resolve(qemuRoot, "qemu-launcher.mjs")),
      access(resolve(qemuRoot, "display-configuration.mjs")),
      access(resolve(qemuRoot, "Dockerfile")),
      access(resolve(qemuRoot, "init")),
      access(resolve(qemuRoot, "start-genesis.sh")),
      access(resolve(qemuRoot, "grub.cfg")),
      access(resolve(qemuRoot, "build-live-media.sh")),
    ]);
    const build = await readFile(resolve(qemuRoot, "build.mjs"), "utf8");
    const init = await readFile(resolve(qemuRoot, "init"), "utf8");
    const startup = await readFile(resolve(qemuRoot, "start-genesis.sh"), "utf8");
    const launcher = await readFile(resolve(qemuRoot, "qemu-launcher.mjs"), "utf8");
    const run = await readFile(resolve(qemuRoot, "run.mjs"), "utf8");
    const headless = await readFile(resolve(qemuRoot, "headless.mjs"), "utf8");
    const usbSmoke = await readFile(resolve(qemuRoot, "usb-smoke.mjs"), "utf8");
    const grub = await readFile(resolve(qemuRoot, "grub.cfg"), "utf8");
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as {
      readonly scripts: {
        readonly "qemu:build": string;
        readonly "usb:build": string;
        readonly "usb:run": string;
        readonly "usb:smoke": string;
        readonly "usb:uefi:smoke": string;
      };
    };
    const displayConfiguration = (await import(
      pathToFileURL(resolve(qemuRoot, "display-configuration.mjs")).href
    )) as {
      readonly resolveQemuDisplayConfiguration: (environment: Record<string, string>) => {
        readonly width: number;
        readonly height: number;
        readonly device: string;
        readonly kernelVideo: string;
      };
    };
    expect(build).toContain("SHA256SUMS");
    expect(build).toContain("data-template.img");
    expect(build).toContain("sevynos-live.iso");
    expect(build).toContain('type: "hybrid-iso"');
    expect(build).toContain("dataDiskRequired: false");
    expect(build).not.toContain("rm(output");
    expect(init).toContain("SEVYN_QEMU_KERNEL_BOOTED");
    expect(init).toContain("SEVYN_LIVE_USB_ROOT_READY");
    expect(init).toContain("SEVYN_VOLATILE_STORAGE_ACTIVE");
    expect(init).toContain("/dev/disk/by-label/SEVYN_DATA");
    expect(init).not.toMatch(/\/dev\/(?:sd|vd)[a-z]/);
    expect(init).toContain("start-genesis");
    expect(startup).toContain("SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED");
    expect(startup).toContain("genesis-wayland.mjs");
    expect(startup).toContain("drm-backend.so");
    expect(startup).toContain("headless-backend.so");
    expect(startup).toContain("--use-pixman");
    expect(run).toContain("display.device");
    expect(run).toContain("display.kernelVideo");
    expect(
      displayConfiguration.resolveQemuDisplayConfiguration({
        SEVYN_QEMU_WIDTH: "1024",
        SEVYN_QEMU_HEIGHT: "640",
      }),
    ).toMatchObject({
      width: 1024,
      height: 640,
      device: "virtio-vga,xres=1024,yres=640",
      kernelVideo: "video=Virtual-1:1024x640@60",
    });
    expect(run).toContain("usb-tablet");
    expect(run).toContain("resolveInteractiveHardwareArguments");
    expect(run).not.toContain("sevyn.headless=1");
    expect(headless).toContain("sevyn.headless=1");
    expect(headless).toContain("data.img");
    expect(usbSmoke).toContain("sevynos-live.iso");
    expect(usbSmoke).not.toContain("data.img");
    expect(usbSmoke).toContain("if=pflash");
    expect(grub).toContain("sevyn.live=1");
    expect(grub).toContain("set gfxpayload=text");
    expect(grub).toContain("unset gfxpayload");
    expect(grub).not.toContain("gfxpayload=keep");
    expect(init).toContain("SEVYN_QEMU_PERSISTENT_STORAGE_MOUNTED");
    expect(init).toContain("systemd-udevd");
    expect(startup).toContain("QEMU/WESTON OUTPUT SIZE");
    expect(startup).toContain("SEVYN_FOCUS_TRACE=1");
    expect(launcher).toContain("qemu-system-x86_64");
    expect(launcher).toContain("sevynos-qemu-runner");
    expect(packageJson.scripts["qemu:build"].indexOf("desktop:build")).toBeLessThan(
      packageJson.scripts["qemu:build"].indexOf("linux:build"),
    );
    expect(packageJson.scripts["usb:build"]).toBe("pnpm qemu:build");
    expect(packageJson.scripts["usb:run"]).toContain("usb-run.mjs");
    expect(packageJson.scripts["usb:smoke"]).toContain("usb-smoke.mjs");
    expect(packageJson.scripts["usb:uefi:smoke"]).toContain("SEVYN_QEMU_FIRMWARE=uefi");
  });
});
