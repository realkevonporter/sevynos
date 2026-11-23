# SevynOS

> Open. Simple. Your code.

[![Repository quality](https://github.com/realkevonporter/sevynos/actions/workflows/quality.yml/badge.svg)](https://github.com/realkevonporter/sevynos/actions/workflows/quality.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

SevynOS is an open computing platform built on Linux and React Native.
The goal is one understandable application model across desktop, mobile,
embedded, and future devices — without taking ownership away from the
people using or building them. Linux-level openness and freedom with
Apple-level premium design and security.

This repository is public so engineers, designers, technical writers,
testers, and curious builders can shape the platform while its
foundations are still flexible.

## What works today

SevynOS is early-stage software, not a production operating system. The
v2 rebuild (started 2026-11-06, zero old code reused) boots to a React
Native shell — top bar with live status, dock with 12 apps — and the
stock apps are real: Terminal (the `sevyn` CLI only, no bash), Settings,
Files, Browser (a real Chromium embed), and Tokrah as a third-party app.
The system updates itself in place (A/B slots, signed feed), installs
alongside Windows 11, and paints through Genesis, the GPU compositor,
with a CPU fallback. See [v2/README.md](v2/README.md) for the full
milestone list and the locked criteria.

## Nightly

Every push to main publishes a nightly: `sevynos.img` (a GPT USB-boot
disk image — `dd` it to a stick and boot), plus `vmlinuz` and
`initramfs.cpio.gz` for QEMU. An installed system updates itself from
the `updates-v2.json` feed — no USB re-flash. This is a development
snapshot, not a stable release.

## Repository map

| Directory                | Responsibility                                               |
| ------------------------ | ------------------------------------------------------------ |
| `v2/`                    | The whole OS: shell, apps, loader, updater, image, checks    |
| `v2/shell/`              | React Native shell: top bar, status tray, dock               |
| `v2/apps/`               | Stock system apps (Terminal, Settings, Files, Browser, …)    |
| `v2/rn/`                 | The native RN host (Hermes + Yoga + Wayland + painter)       |
| `v2/loader/`             | `.sevyn` loader + app daemon (registry, permissions)         |
| `v2/update/`             | System update daemon + `sevyn` CLI (A/B slots, signed feed)  |
| `v2/camera/`             | Native V4L2 camera daemon                                    |
| `v2/comms/`              | Matrix comms daemon + RCS skeleton                           |
| `v2/image/`              | Image builders, QEMU check harnesses, nightly feed           |
| `tools/update-signing/`  | Feed-signing scripts (kept: the v2 builders still call them) |
| `BROWSER_PLAN.md`        | Browser embed plan (v2)                                      |
| `GPU_COMPOSITOR_PLAN.md` | Genesis GPU compositor plan (v2)                             |

The pre-rebuild tree that used to live at the repository root was
deleted in 2026-11-21: it was reference only since the rebuild, and new
work kept landing in it by mistake. `v2/` is the home now.

## Start contributing

You need Node.js 24+ for the shell/apps checks, and QEMU + a Linux
toolchain for the image builds. The v2 milestone workflows
(`.github/workflows/v2-*.yml`) are the gates: each builds its image and
runs its QEMU check on every PR touching `v2/`. The repository-quality
workflow runs Prettier over the tree and the `camd` daemon check.

```sh
git clone https://github.com/realkevonporter/sevynos.git
cd sevynos
npx -y prettier@3.9.6 --check "v2/**/*.{ts,tsx,js,mjs,json,md}" ".github/workflows/*.yml" "*.md"
node v2/camera/camd-check.mjs
```

The best first contributions are focused and testable: hardware reports,
device-driver coverage, accessibility, input and layout compatibility,
system application fixes, documentation, and small React Native API
additions. Read the [Code of Conduct](CODE_OF_CONDUCT.md) before opening
a change.

## Project values

- Users own their devices.
- Developers deserve clear APIs and excellent tools.
- React Native compatibility belongs in the platform.
- Privileged behavior stays behind explicit, least-authority services.
- Working boot paths and public contracts are changed deliberately.
- A green typecheck is not device proof; claims should match the evidence.

SevynOS is available under the [GNU General Public License v3.0 or later](LICENSE).
Third-party components retain their respective licenses. Security issues
should be reported through the process in [SECURITY.md](SECURITY.md), not a
public issue.
