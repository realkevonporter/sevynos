# SevynOS v2 — fresh rebuild

**Status: M1 merged (PR #82, 2026-11-06). M2 in progress (this PR).**
M0 merged 2026-11-06 (PR #81). M1 passes its full check locally — 15/15,
~30 s under QEMU/TCG, twice in a row — and is merged. This directory is
the fresh SevynOS rebuild, started 2026-11-06 on Kevon's word. Same
architecture and criteria as the original build, **zero old code reused**
— Sevyn owns the full context from line one, so a fix in one place never
silently breaks another.

Rebuild pace is **autopilot** (Kevon, 2026-11-06: "You finish one, you
merge, you move on to the next"): finish a milestone, merge when CI is
green and the diff is exactly that milestone's scope, move to the next.
**M2 is Kevon's checkpoint** — when the shell lands, he downloads the
nightly himself and boots it. That means the nightly release must publish
a real, bootable v2 image by M2 (today it still publishes the old tree's
image — see "Nightly" below).

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
  tablets, watches, and other devices (later, not v1). **Pace targets
  (Kevon, 2026-11-06):** a fully working desktop before end of year.
  After desktop, mobile follows in ~another month — core is send/receive
  texts + make/receive calls only, everything else incremental. Once
  mobile runs with basic text + call, Kevon will use it 100% permanently
  as his daily driver (dogfooding drives what gets fixed next).
- **Networks are plug-and-play.** Every network works in SevynOS —
  SpaceX/Starlink is one option among all, not exclusive; Starlink gets
  pushed because it's available worldwide. No single-network lock-in
  (openness lock). **SpaceX pitch: NOT yet (Kevon, 2026-11-06)** — it
  needs a solid prototype first (Starlink as one plug-and-play network,
  permissions + user-owned experience working end to end). No
  outreach/one-pager until he gives the word.
- **License:** GPL-3.0-or-later (see `../LICENSE`).

## Layout

```text
v2/
  README.md            # this file — vision, locks, milestones
  compositor/
    test-client.c      # M1: Wayland test client (one window, two click targets)
  services/
    statusd.c          # M1: status daemon (battery/wifi/volume event feed)
    status-client.c    # M1: status subscriber (the feed's proof client)
  rn/
    README.md          # M2: host design + host↔JS contract + pinned deps
    host/              # M2: the native host (Hermes + Yoga + Wayland + painter)
      sevyn-rn-host.cc #   Hermes embed, JSI Sevyn global, main loop
      common.{h,cc}    #   draw ops, colour parsing, logging
      painter.{h,cc}   #   CPU raster: rects, FreeType text, PNG images
      wayland.{h,cc}   #   fullscreen xdg_toplevel, pointer/keyboard
      status.{h,cc}    #   statusd subscriber thread
      yoga-bridge.{h,cc} # Yoga C API wrapper (integer node ids)
      build-deps.sh    #   fetch + build Hermes 0.13.0 + Yoga into deps/
    renderer/
      sevyn-renderer.js  # M2: react-reconciler host config (View/Text/…)
      test/              #   Node smoke tests (mock Sevyn host)
    shell/             # M2: the shell app (TSX: top bar, tray, dock)
      src/Shell.tsx    #   layout + "Starting…" state
      src/Dock.tsx     #   12-app dock, never overflows (scrolls)
      src/StatusTray.tsx # live status via the renderer status store
      src/apps.ts      #   app registry
      build-shell.mjs  #   esbuild bundle + hermesc -> shell.hbc
  image/
    build-empty-image.sh  # M0: kernel + minimal initramfs ("empty image")
    boot-check.sh         # M0: boot the empty image in QEMU, assert the marker
    build-m1-image.sh     # M1: kernel + initramfs with Weston + test client + statusd
    build-m2-image.sh     # M2: kernel + initramfs with Weston + RN host + shell
    copy-closure.py       # M1: copy binaries + shared-library closure into the rootfs
    weston.ini            # M1: Weston configuration (DRM backend, dark background)
    m1-check.mjs          # M1: QMP harness — boot, cursor, clicks, keys, status
    m2-check.mjs          # M2: QMP harness — shell, dock, launch, tray, keys
    build/                # build outputs (git-ignored): vmlinuz, initramfs, logs, shots
```

## The compositor is upstream Weston

M1's compositor is **Weston, not SevynOS code**. It is the boring
display/input layer — the same category as the Linux kernel: an upstream
component, separable and replaceable, per the layered architecture. Weston
owns screens, input devices, and surfaces; SevynOS owns everything above
it (the shell in M2, the app runtime in M3). The M1 test client is
SevynOS code: it is the click-target proof that the layer routes input
correctly, not a compositor of its own. Writing a compositor from scratch
would be a multi-month project before any input could be proven; M1's job
is to prove input and status, and Weston is how that proof is built on a
layer Kevon can replace later without touching the shell.

## Nightly

The `nightly` release (published by the `Public build` workflow on every
push to main) ships the **old tree's ISO and the v2 image side by side**:
`vmlinuz` + `initramfs.cpio.gz` + `v2-SHA256SUMS` + `v2-BOOT-NOTES.txt`
are the M2 shell image — boot it in QEMU with the command in the boot
notes. The v2 image is also a CI artifact of the `SevynOS v2 M2`
workflow on every PR. **M2 is Kevon's checkpoint** — when it merges, he
downloads the nightly himself and boots it.

## Milestones

- **M0 — Groundwork (merged, PR #81).** Repo skeleton + CI pipeline that
  builds a bootable image. Done when an empty image builds in CI and boots
  to a blank screen in QEMU.
- **M1 — Boots and proves the foundation (merged, PR #82).** Kernel
  boots, compositor up, input proven end to end with a click-target test
  harness, live system status (battery/wifi/volume) as an event feed.
  Done when: boot → cursor moves → click lands on the intended surface
  → status values change live. Proven locally under QEMU (screendumps +
  serial log, 15/15 checks); CI runs the same check on the PR; real-
  hardware proof is Kevon's M2 boot of the nightly.
- **M2 — Shell (Kevon's checkpoint, in progress).** RN shell: top bar
  with live status tray, main area, dock with 12 apps that never
  overflows (scrolls with chevrons). Design pass from the start, not a
  later polish phase. The shell is a real React Native app on a
  purpose-built native host: Hermes embeds the JS, Yoga lays it out,
  a CPU raster paints it to a Weston surface — no Electron, no web
  view, no Node in the image (see `rn/README.md`). Done when: the
  shell surface is on screen → the dock never overflows at 12 apps →
  clicking a launcher logs `LAUNCH <appId>` and shows "Starting…" →
  a pushed status change repaints the tray → Tab/Enter activates the
  focused control. When M2 merges, Kevon downloads the nightly and
  boots it himself.
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

## Build + check the M1 image

```sh
# Needs: a kernel in /boot (linux-image-generic), qemu-system-x86,
# busybox-static, cpio, gcc, pkg-config, libwayland-dev,
# wayland-protocols, weston, seatd, adwaita-icon-theme,
# fonts-dejavu-core, xkb-data. /boot kernels ship mode 600 (root-only), so
# the build needs read access to /boot — CI runs it under sudo.
# SEVYN_V2_SYSROOT (default /) is the tree packages are copied from: on CI
# it is the runner itself; locally it is an extracted-deb sysroot.
sh v2/image/build-m1-image.sh   # writes v2/image/build/
node v2/image/m1-check.mjs      # boots in QEMU, proves M1, writes m1-check.json
```

The harness drives the guest with QMP: it sweeps the pointer across the
screen and reads which surface each point lands on, clicks in each surface
region and asserts the right surface logs the button, presses a key and
asserts it reaches the focused surface, injects status changes on the host
control serial and asserts the subscriber logs them, and proves the cursor
moves by diffing two screendumps taken with the pointer at two different
points. CI runs the same build + check on every push and pull request
touching `v2/` (see `.github/workflows/v2-m1.yml`); screendumps, the
serial log, and `m1-check.json` are kept as artifacts.

## Build + check the M2 image

```sh
# Needs (on top of the M1 list): g++, cmake, node, libfreetype-dev,
# libpng-dev. The Hermes build is the slow part (10-20 min first run);
# it is cached in v2/rn/host/deps — CI caches that dir.
sh v2/rn/host/build-deps.sh  # Hermes 0.13.0 + Yoga -> v2/rn/host/deps
sh v2/image/build-m2-image.sh   # writes v2/image/build/
node v2/image/m2-check.mjs      # boots in QEMU, proves M2, writes m2-check.json
```

The JS side is checked without QEMU first (Node, mock host):

```sh
cd v2/rn/renderer && npm ci && npm test        # 8 renderer checks
cd ../../shell && npm ci && npm run typecheck && npm run build && npm test  # tsc + bundle + 5 shell e2e checks
```

The M2 harness boots the image, asserts the shell surface (top bar +
dock colours), the dock never overflowing at 12 apps (first tile fully
visible, right edge is the scroll chevron), a Files-tile click logging
`LAUNCH files` and changing the main area, a pushed battery/wifi/volume
change repainting the tray, and Tab + Enter launching the focused app
(Terminal). CI runs the same build + check on every push and pull request
touching `v2/` (see `.github/workflows/v2-m2.yml`); screendumps, the
serial log, and `m2-check.json` are kept as artifacts. The v2 image is
also published to the `nightly` release by the `Public build` workflow
(see "Nightly" above).

## The old tree

The original build's code still lives at the repository root, untouched by
this PR. It is reference only — nothing in `v2/` imports or reuses it. Its
disposition is an open question for Kevon: when the v2 tree is ready to
become the root, do we move `v2/` to the root (deleting the old tree then),
or keep `v2/` as the new home? No old code is deleted in this PR.
