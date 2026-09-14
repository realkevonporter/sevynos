# Phase 1: Genesis

Genesis proves that SevynOS can boot, present its own coherent desktop, run
React Native applications through a controlled runtime, and broker real Linux
capabilities without coupling application code to one host.

## Implemented foundation

- application manifests, packages, sessions, lifecycle, permissions, and
  service brokering;
- shared desktop composition across Electron, headless Linux, and native
  Wayland hosts;
- React Native shell and system applications using a custom reconciler and Yoga;
- isolated Hermes application execution and bounded native IPC;
- hybrid BIOS/UEFI live media and tested installation to blank virtual disks;
- QEMU boot, input, focus-latency, live-media, and installer regression gates;
- reusable compatibility tests that contributors can extend with their own
  React Native applications.

Clipboard, keyboard input, camera capture, audible audio output, and Wi-Fi are
known target-hardware gaps. Existing service code and automated tests for those
areas are foundations, not evidence that the device paths work end to end.

## Active priorities

1. Restore and physically verify clipboard, keyboard, camera, audio, and Wi-Fi.
2. Finish text input, selection, IME, shaping, and AT-SPI accessibility.
3. Improve GPU acceleration, damage tracking, animation, and power efficiency.
4. Strengthen kernel-enforced application isolation and document grants.
5. Build a graphical installer, signed update channel, and recovery workflow.
6. Expand React Native and Expo compatibility using application-driven tests.
7. Turn Studio into a dependable on-device development and debugging tool.

## Phase exit criteria

Genesis exits alpha when supported hardware profiles can boot, install, update,
recover, connect, play and capture media, accept everyday text input, and run a
documented application compatibility set with repeatable physical-device proof.

Detailed host and image workflows live in
[Genesis host roadmap](../genesis-host-roadmap.md) and
[Linux, Wayland, and QEMU](../linux-wayland-qemu.md).
