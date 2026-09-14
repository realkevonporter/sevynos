# SevynOS Security Threat Model & Appliance Boundary

## Overview

SevynOS is architected as an appliance operating system. In contrast to traditional general-purpose Linux distributions, SevynOS intentionally prohibits users and guest application code from reaching a raw Linux/POSIX shell (`/bin/sh`, `/bin/bash`), virtual console terminals (VT1–VT6), or privileged system control daemons.

All user-visible commands, device control, application lifecycle operations, and diagnostic recovery procedures are handled through typed SevynOS surfaces (the Genesis compositor, `@sevynos/sdk`, capability brokers, and the SevynOS Terminal application).

---

## Threat Vectors & Countermeasures

### 1. Virtual Terminal (VT) Escape (`Ctrl+Alt+F1`–`F12`)

- **Risk**: On bare metal DRM/KMS systems, pressing `Ctrl+Alt+F1` through `Ctrl+Alt+F6` could switch the active display console away from the Genesis Wayland session to a raw Linux virtual terminal, exposing kernel logs or getty login prompts.
- **Countermeasure**:
  1. **Kernel VT Locking**: At system startup in `start-genesis.sh`, `ioctl(fd, VT_LOCKSWITCH, 1)` (ioctl code `0x560B`) is invoked on virtual console devices (`/dev/tty0`, `/dev/tty1`, `/dev/tty`), commanding the Linux console driver to ignore all VT switch requests.
  2. **Compositor Inhibit**: Weston is configured with `[keyboard] vt-switching=false`.
  3. **Native Bridge & Wayland Filtering**: In `hosts/linux/native/src/main.rs` and `hosts/linux/src/wayland.ts`, any key combinations matching `Ctrl+Alt+F1` through `Ctrl+Alt+F12` are trapped and suppressed before event dispatch.

### 2. Magic SysRq Key Combinations

- **Risk**: The Linux Magic SysRq mechanism (`Alt+SysRq+<key>`) can be leveraged to forcibly reboot, kill user processes, remount filesystems read-only, or drop to debugging shells.
- **Countermeasure**:
  1. **Bootloader Command Line**: `sysrq_always_enabled=0` is appended to all GRUB bootloader entries in `tools/qemu/grub.cfg`.
  2. **Early Init Inhibit**: Early initialization in both live mode (`tools/qemu/init`) and installed mode (`tools/qemu/sevyn-installed-init`) enforces `sysctl -w kernel.sysrq=0` and zeroes `/proc/sys/kernel/sysrq`.

### 3. Unauthenticated Emergency Root Shell on Boot Failure

- **Risk**: Traditional initramfs scripts drop into `/bin/sh` with root permissions if compositor initialization or device mounting fails.
- **Countermeasure**:
  1. Boot failure handlers in `init` and `sevyn-installed-init` log failure diagnostics and execute a controlled, safe shutdown or reboot.
  2. Emergency shell drops are disabled by default in production. Only an explicit kernel command line parameter (`sevyn.debug=1`), restricted to developer firmware configurations, unlocks an emergency console.

### 4. Application Sandbox & Process Execution

- **Risk**: Third-party JavaScript applications could invoke Node.js built-ins (`child_process`, `fs`, `process.binding`, `process.dlopen`) to spawn arbitrary Linux processes or inspect host system files.
- **Countermeasure**:
  1. **Hermes Sandbox**: Guest applications running on Hermes bytecode execute in an engine with zero native Node.js or POSIX bindings.
  2. **Node Runner Global Sanitization**: In `hosts/linux/src/third-party-application-process.ts`, `globalThis.require` is removed and `globalThis.process` is replaced with a frozen, safe object that exposes only standard environment metadata (`NODE_ENV`, `SEVYN_APPLICATION_ID`) and `nextTick`. All hardware and OS operations are mediated over typed JSON IPC messages through capability brokers.
  3. **No Process Spawning Permission**: The permission system does not grant `process:spawn` or arbitrary shell execution capabilities to guest applications.

### 5. Production Developer CLI Restrictions

- **Risk**: Developer tools designed to run live reload servers or build watch daemons (such as `sevyn dev`) could be invoked to spawn host processes.
- **Countermeasure**:
  - `tools/cli/src/cli.ts` verifies that `SEVYN_PRODUCTION` or `NODE_ENV=production` prohibits `dev` and `run-sevynos` commands, advising developers to use the `.sevyn` application bundle packaging workflow instead.

---

## Summary

By locking VT consoles, neutralizing SysRq, eliminating boot failure shell drops, sanitizing the guest execution scope, and routing all management through the SevynOS Terminal and Genesis surfaces, the appliance security boundary remains sealed against Linux escape hatches.
