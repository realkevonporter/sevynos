# ADR-0013: Modular cross-device shell applications

- Status: Accepted
- Date: 2026-08-06

## Context

SevynOS must support desktop, laptop, tablet, mobile, and future form factors
without cloning the Runtime or Genesis graphics stack. The former desktop shell
composed its background, taskbar, launcher, and workspace controls directly,
while the mobile shell directly owned its home screen, dock, and status bar.
Those arrangements made visual components part of a shell monolith and made
targeted reload difficult.

## Decision

SevynOS uses one responsibility chain:

```text
Kernel → Runtime → Genesis → Shell → System Applications → User Applications
```

`@sevynos/shell-core` owns only device-profile selection and the lifecycle of
system applications. It imports neither Runtime, Genesis, React, nor a platform
host. A system application receives an immutable device/profile context and a
service client. It cannot import another system application through that
context.

Visible shell components live in `applications/shell/<application>/`. Built-in
profiles select and position those applications. Desktop, tablet, and mobile
profiles share applications such as Wallpaper, Dock, Status Bar, and
Notification Center where their interaction model permits it.

Hot reload replaces one registered system-application module transactionally.
The replacement receives the prior instance's captured state. Runtime,
Genesis, and sibling system-application instances remain running. A failed
replacement does not replace the active module.

Genesis exposes generic surfaces and overlays. It must not contain identifiers,
layout, or behavior for a desktop, dock, taskbar, launcher, home screen, status
bar, notification center, lock screen, or device class.

## Consequences

- New form factors add profiles and system applications, not operating systems.
- A visual application can be built, shipped, and reloaded separately from the
  kernel, Runtime, and Genesis.
- Hosts remain responsible for adapting generic shell/application presentation
  to their platform output.
- Direct application-to-application imports are prohibited for coordination;
  shared operating-system behavior belongs behind Runtime services.
- The existing desktop scene-node and mobile React Native renderers remain host
  adapters during the migration rather than moving into Genesis.
