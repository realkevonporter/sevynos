# SevynOS

> Open. Simple. Your code.

[![Repository quality](https://github.com/realkevonporter/sevynos/actions/workflows/quality.yml/badge.svg)](https://github.com/realkevonporter/sevynos/actions/workflows/quality.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Project status](https://img.shields.io/badge/status-early%20development-f4b942.svg)](docs/roadmap/phase-1.md)

SevynOS is an open computing platform built on Linux, TypeScript, and React
Native. The goal is one understandable application model across desktop,
mobile, embedded, and future devices—without taking ownership away from the
people using or building them.

This repository is public so engineers, designers, technical writers, testers,
and curious builders can shape the platform while its foundations are still
flexible.

## What works today

SevynOS is early-stage software, not a production operating system. The current
Genesis milestone includes:

- a bootable x86-64 Linux live image with BIOS and UEFI support;
- a Weston/Wayland desktop presented through a native Rust bridge;
- a TypeScript runtime for applications, lifecycle, permissions, and services;
- a native SevynOS React Native renderer with Yoga layout and Hermes execution;
- React Native shell surfaces and system applications;
- keyboard, pointer, clipboard, storage, audio, camera, Wi-Fi, and other Linux
  capabilities behind typed service boundaries;
- an installer exercised against blank BIOS and UEFI virtual disks;
- Electron and deterministic headless hosts for fast development and testing.

Hardware support varies by computer. Camera, Wi-Fi, graphics, audio routing,
sleep, and power behavior still need broader real-device testing. See the
[Genesis roadmap](docs/roadmap/phase-1.md) for the honest project status.

## The platform, not a collection of ports

Applications should remain normal React Native and TypeScript projects. When an
application expects a React Native or native API, the preferred solution is to
implement a reusable platform contract in SevynOS—not create an app-specific
fork. Contributors can bring their own React Native applications as real-world
compatibility workloads.

```text
React Native application
  -> @sevynos/react-native
  -> Sevyn Runtime and capability broker
  -> Genesis shell, windows, input, and graphics
  -> native host services
  -> Weston / Wayland / Linux
```

Read [React Native on SevynOS](docs/react-native-platform.md) and
[Application development](docs/application-development.md) before extending
the compatibility surface.

## Start contributing

You need Node.js 22+, the pinned pnpm version, and Docker for Linux image work.

```sh
git clone https://github.com/realkevonporter/sevynos.git
cd sevynos
corepack enable
pnpm install
pnpm check
```

Useful workflows:

```sh
pnpm desktop        # run the Genesis desktop in Electron
pnpm desktop:dev    # desktop development with isolated app reload
pnpm linux:headless # deterministic Linux-host execution
pnpm qemu:build     # build Linux/QEMU artifacts and the live ISO
pnpm qemu:run       # boot the graphical VM
pnpm usb:smoke      # prove no-disk BIOS live-media boot
pnpm usb:uefi:smoke # prove no-disk UEFI live-media boot
```

The live image is written to `tools/qemu/build/sevynos-live.iso`. Writing it to
a USB drive erases that drive; follow the
[Linux, Wayland, and QEMU guide](docs/linux-wayland-qemu.md).

The best first contributions are focused and testable: hardware reports,
device-driver coverage, accessibility, input and layout compatibility, system
application fixes, documentation, and small React Native API additions. Read
[Contributing](docs/contributing.md), the [community guide](docs/community.md),
and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a change.

## Repository map

| Directory       | Responsibility                                                  |
| --------------- | --------------------------------------------------------------- |
| `runtime/`      | Application identity, lifecycle, packages, policy, and sessions |
| `graphics/`     | Displays, scenes, surfaces, rendering, and windows              |
| `input/`        | Keyboard, pointer, touch, focus, gestures, and routing          |
| `shell/`        | Host-independent desktop and mobile shell composition           |
| `hosts/`        | Electron, Linux/Wayland, headless, and native adapters          |
| `frameworks/`   | React Native compatibility and framework services               |
| `applications/` | React Native system applications and examples                   |
| `services/`     | Reusable operating-system services                              |
| `sdk/`          | Public developer contracts and tools                            |
| `tools/`        | CLI, Metro, QEMU, image, and repository tooling                 |
| `docs/`         | Architecture, decisions, guides, security, and roadmap          |

Architecture changes should start with
[Architecture v0.1](docs/architecture/v0.1.md) and the
[architecture decision records](docs/decisions/).

## Project values

- Users own their devices.
- Developers deserve clear APIs and excellent tools.
- React Native compatibility belongs in the platform.
- Privileged behavior stays behind explicit, least-authority services.
- Working boot paths and public contracts are changed deliberately.
- A green typecheck is not device proof; claims should match the evidence.

SevynOS is available under the [Apache License 2.0](LICENSE). Security issues
should be reported through the process in [SECURITY.md](SECURITY.md), not a
public issue.
