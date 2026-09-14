import assert from "node:assert/strict";
import test from "node:test";
import { resolveQemuDisplayConfiguration } from "./display-configuration.mjs";

test("defaults the visible guest to 1280x720", () => {
  assert.deepEqual(resolveQemuDisplayConfiguration({}), {
    width: 1280,
    height: 720,
    device: "virtio-vga,xres=1280,yres=720",
    kernelVideo: "video=Virtual-1:1280x720@60",
  });
});

test("configures the alternate 1024x640 verification mode consistently", () => {
  assert.deepEqual(
    resolveQemuDisplayConfiguration({
      SEVYN_QEMU_WIDTH: "1024",
      SEVYN_QEMU_HEIGHT: "640",
    }),
    {
      width: 1024,
      height: 640,
      device: "virtio-vga,xres=1024,yres=640",
      kernelVideo: "video=Virtual-1:1024x640@60",
    },
  );
});

test("rejects malformed and unsafe display dimensions", () => {
  assert.throws(
    () => resolveQemuDisplayConfiguration({ SEVYN_QEMU_WIDTH: "wide" }),
    /SEVYN_QEMU_WIDTH/,
  );
  assert.throws(
    () => resolveQemuDisplayConfiguration({ SEVYN_QEMU_HEIGHT: "0" }),
    /SEVYN_QEMU_HEIGHT/,
  );
});
