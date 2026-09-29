import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveInteractiveHardwareArguments,
  resolveLocalQemuArguments,
} from "./qemu-launcher.mjs";

test("provides network and audible duplex hardware to interactive guests", () => {
  const darwin = resolveInteractiveHardwareArguments("darwin");
  assert.ok(darwin.includes("virtio-net-pci,netdev=sevyn-net"));
  assert.ok(darwin.includes("coreaudio,id=sevyn-audio"));
  assert.ok(darwin.includes("hda-duplex,audiodev=sevyn-audio"));

  const linux = resolveInteractiveHardwareArguments("linux");
  assert.ok(linux.includes("pa,id=sevyn-audio"));
});

test("uses HVF for an x86-64 guest on an Intel Mac", () => {
  assert.deepEqual(resolveLocalQemuArguments(["-m", "4096"], "darwin", "x64"), [
    "-accel",
    "hvf",
    "-cpu",
    "max",
    "-m",
    "4096",
  ]);
});

test("preserves an explicitly selected accelerator", () => {
  assert.deepEqual(
    resolveLocalQemuArguments(["-accel", "tcg", "-m", "4096"], "darwin", "x64"),
    ["-cpu", "max", "-accel", "tcg", "-m", "4096"],
  );
});

test("does not request HVF on unsupported hosts", () => {
  assert.deepEqual(resolveLocalQemuArguments(["-m", "4096"], "linux", "x64"), [
    "-cpu",
    "max",
    "-m",
    "4096",
  ]);
  assert.deepEqual(resolveLocalQemuArguments(["-m", "4096"], "darwin", "arm64"), [
    "-cpu",
    "max",
    "-m",
    "4096",
  ]);
});

test("preserves an explicitly selected CPU", () => {
  assert.deepEqual(
    resolveLocalQemuArguments(["-cpu", "host", "-m", "4096"], "linux", "x64"),
    ["-cpu", "host", "-m", "4096"],
  );
});
