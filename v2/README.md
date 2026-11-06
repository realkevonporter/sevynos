# SevynOS v2 — fresh rebuild

**Status: M0 (groundwork).** This directory is the fresh SevynOS rebuild,
started 2026-11-06 on Kevon's word. Same architecture and criteria as the
original build, **zero old code reused** — Sevyn owns the full context from
line one, so a fix in one place never silently breaks another.

## Vision

Linux-level openness and freedom with Apple-level premium design and
security. An OS where React Native developers run their apps with little to
no effort.

**Winning =** real people using SevynOS + serious contributors arriving on
GitHub. Adoption and community, not commercial revenue.

## Locked criteria

These do not change. They are the same locks the original build carried,
reaffirmed 2026-11-06.

- **Linux kernel.** Layered architecture; every layer separable and
  replaceable. No custom kernel patches in v1.
- **React Native is a first-class citizen.** 100% RN compatible. The entire
  OS UI — shell and system apps — is written in React Native.
- **No Linux shell access** for users or developers. Everything goes through
  SevynOS. The Terminal app exposes only the `sevyn` CLI surface, never
  bash. VT switching, SysRq, and debug consoles are disabled in production
  images. Recovery is via the Terminal app, never a Linux TTY.
- **Security is essential.**
- **Openness wins every conflict.** No Apple-style review gate or control
  model. Design bar: open, but sleek and welcoming like Apple products.
- **`.sevyn` app bundles** (zip: `manifest.json` + `app.hbc` + `assets/`).
  Manifest carries permissions + optional signature. Self-signed allowed
  with a user note; a signature is required to replace or become a system
  app. Protected apps: shell + terminal (terminal is the recovery path).
  Developers can build their own system apps and delete stock ones.
- **Registry** system-wide at `/var/lib/sevyn/apps/`; pristine stock
  bundles ship in the image at `/usr/share/sevyn/pristine/` for offline
  reinstall.
- **Sevyn Code** is the IDE (based on Code-OSS). Its integrated terminal
  launches the Sevyn CLI as its default shell. Baked into the base image.
  "Studio" stays reserved for the future GarageBand-like app.
- **AI baked into the OS.** An AI that can control the whole system,
  through a connector baked into the OS — users can port any AI they want
  in. No single-AI lock-in. The AI acts through the system's permission
  model, never around it.
- **Targets:** desktop first, mobile next; the architecture must support
  tablets, watches, and other devices (later, not v1).
- **Networks are plug-and-play.** Every network works in SevynOS —
  SpaceX/Starlink is one option among all, not exclusive; Starlink gets
  pushed because it's available worldwide. No single-network lock-in
  (openness lock).
- **License:** GPL-3.0-or-later (see `../LICENSE`).

## Layout

```text
v2/
  README.md            # this file — vision, locks, milestones
  image/
    build-empty-image.sh  # M0: kernel + minimal initramfs ("empty image")
    boot-check.sh         # M0: boot the empty image in QEMU, assert the marker
    build/                # build outputs (git-ignored): vmlinuz, initramfs, boot.log
```

## Milestones

Each milestone stops for Kevon's word before the next starts.

- **M0 — Groundwork (this directory).** Repo skeleton + CI pipeline that
  builds a bootable image. Done when an empty image builds in CI and boots
  to a blank screen in QEMU.
- **M1 — Boots and proves the foundation.** Kernel boots, compositor up,
  input proven end to end with a click-target test harness, live system
  status (battery/wifi/volume) as an event feed. Nothing else starts until
  this passes on real hardware.
- **M2 — Shell.** RN shell: dock/taskbar (no overflow by design), launcher,
  system status. Design pass from the start, not a later polish phase.
- **M3 — App runtime.** `.sevyn` loader, registry, permissions,
  signatures.
- **M4 — System apps.** Terminal (`sevyn` CLI only), Settings, Files,
  Sevyn Code baked in.
- **M5 — Connectivity + browser.** Wifi connects, DNS resolves, the browser
  loads a real page. The old build's "wifi connected, browser dead" failure
  is a named acceptance test.
- **M6 — Tokrah bring-up (dogfood).** Tokrah runs as a third-party app —
  the "100% RN compatible" proof.
- **M7 — Public milestone.** Image published, install guide written, first
  external user boots it.

## Build + boot the empty image (M0)

```sh
# Needs: a kernel in /boot (linux-image-generic), qemu-system-x86,
# busybox-static, cpio. /boot kernels ship mode 600 (root-only), so the
# build needs read access to /boot — CI runs both steps under sudo.
sh v2/image/build-empty-image.sh   # writes v2/image/build/
sh v2/image/boot-check.sh          # boots in QEMU, expects SEVYNOS_V2_BOOT_OK
```

The empty image has no shell, no apps, no compositor — it boots to a blank
screen and prints its boot marker on the serial console. That is the whole
point of M0: the pipeline, not the OS. CI runs the same two scripts on every
push and pull request touching `v2/` (see
`.github/workflows/v2-image.yml`).

## The old tree

The original build's code still lives at the repository root, untouched by
this PR. It is reference only — nothing in `v2/` imports or reuses it. Its
disposition is an open question for Kevon: when the v2 tree is ready to
become the root, do we move `v2/` to the root (deleting the old tree then),
or keep `v2/` as the new home? No old code is deleted in this PR.
