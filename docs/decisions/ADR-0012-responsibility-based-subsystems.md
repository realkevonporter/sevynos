# ADR-0012: Responsibility-Based Subsystems

**Status:** Accepted
**Date:** August 5, 2026
**Applies to:** SevynOS repository structure and package dependencies

## Context

The Genesis prototype originally placed display, compositor, renderer, surface,
window, input, and framework-host code inside the runtime package. Electron also
owned desktop behavior reused by Linux. These locations made the runtime appear
responsible for graphics and input, created a Linux-to-Electron dependency, and
made framework support difficult to distinguish from host integration.

## Decision

Top-level directories represent operating-system responsibilities:

- `runtime/` owns application policy, lifecycle, packages, and sessions;
- `graphics/` owns display, composition, rendering, surfaces, scenes, and
  windows;
- `input/` owns devices, events, focus, pointer interaction, and routing;
- `shell/` owns host-independent system user environments;
- `hosts/` owns platform and execution adapters;
- `frameworks/` owns host-independent framework support;
- `applications/`, `services/`, `sdk/`, and `tools/` own their named concerns.

The graphics core has no workspace dependency. Input depends on graphics window
and scene contracts. Runtime source remains independent of graphics, input,
framework, and host implementations. The desktop shell composes runtime,
graphics, input, and framework APIs. Electron and Linux depend on the desktop
shell rather than on one another.

Framework support and framework hosts are separate packages. Applications may
use public framework APIs but may not import host internals or unrestricted
runtime APIs.

## Consequences

- Subsystem ownership is visible from paths and package manifests.
- Graphics and input can be tested without starting the runtime or a platform
  host.
- Linux and Electron share desktop behavior through the shell layer without a
  host-to-host dependency.
- Package moves require workspace, TypeScript, lint, documentation, and release
  tooling to use responsibility-based paths.
- The mobile Genesis scene implementation remains a distinct graphics package
  until its UI contract can migrate to the core scene model without behavioral
  change.
