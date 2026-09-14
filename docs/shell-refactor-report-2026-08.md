# SevynOS modular shell engineering report

**Completed:** August 6, 2026
**Scope:** Shell architecture, system applications, Genesis boundaries, desktop
and mobile host integration, targeted development reload, and production
verification

## Executive result

SevynOS now has a profile-driven shell that composes the user experience from
independent system applications. Desktop, tablet, and mobile use the same shell
lifecycle contract and can share applications without moving form-factor logic
into Runtime or Genesis.

The refactor establishes the intended responsibility chain:

```text
Kernel -> Runtime -> Genesis -> Shell -> System Applications -> User Applications
```

Runtime continues to own application and service policy. Genesis remains a
generic renderer and compositor. The shell selects a device profile and manages
the system applications that define the experience. A visual application can be
replaced during development without restarting Runtime, Genesis, or its sibling
applications.

This work did not create separate operating systems for each form factor. It
created one reusable shell contract, three initial profiles, host adapters for
the existing desktop and Expo experiences, and extension points for future
device classes.

## Inventory and review boundary

The source review covered the shell, application, graphics/Genesis, desktop and
mobile host, workspace configuration, tests, and architectural documentation.
The earlier whole-repository inventory remains recorded in
[`repository-review-2026-08.md`](repository-review-2026-08.md).

The following reproducible content was excluded from source analysis:

- `node_modules` and pnpm stores;
- `dist`, `build`, `out`, `release`, and generated-code directories;
- Turbo, Expo, framework, editor, and operating-system caches;
- logs, temporary files, coverage output, and TypeScript build metadata;
- Rust targets, CocoaPods, and Xcode derived data;
- packaged applications, `.iso`, `.dmg`, `.AppImage`, and QEMU images;
- `.git` object storage and third-party source.

Build output was generated only for verification. `pnpm clean` removes these
artifacts through a repository-identity and path-checked cleaner without
traversing symbolic links.

## Approved structural changes applied

### New shell core

`shell/core` is a host- and renderer-independent package named
`@sevynos/shell-core`. It defines:

- device descriptors and device classes;
- declarative device profiles and profile matching;
- system-application manifests, lifecycle instances, and mounts;
- service-only application communication;
- profile activation and shutdown;
- state capture and transactional, single-application hot reload;
- subscriptions used by host adapters to refresh presentation.

The package deliberately has no dependency on Runtime, Genesis, React, React
Native, Electron, or a platform host. This keeps layout and presentation out of
operating-system policy and gives every host the same lifecycle semantics.

Profile activation is transactional: all candidate applications must be
created and started before the previous profile is stopped. Hot reload follows
the same rule. If a replacement cannot start, the current application remains
registered and active. When replacement succeeds, captured state is passed to
the new instance and only the replaced instance receives the hot-reload stop
reason.

### Independent system applications

Visible shell responsibilities were moved into `applications/shell`, published
inside the workspace as `@sevynos/system-applications`. Each responsibility has
its own directory and lifecycle module:

| Application      | Current responsibility                                             |
| ---------------- | ------------------------------------------------------------------ |
| `wallpaper`      | Desktop background presentation and shared profile background role |
| `desktop-home`   | Desktop workspace/home role                                        |
| `tablet-home`    | Tablet home presentation and lifecycle                             |
| `mobile-home`    | Mobile home presentation and lifecycle                             |
| `dock`           | Shared dock role with desktop and mobile presentations             |
| `status-bar`     | Shared status role with mobile presentation and desktop lifecycle  |
| `launcher`       | Desktop launcher presentation and lifecycle                        |
| `app-drawer`     | Mobile app-drawer lifecycle boundary                               |
| `notifications`  | Shared notification-center lifecycle boundary                      |
| `quick-settings` | Mobile quick-settings lifecycle boundary                           |
| `lock-screen`    | Tablet/mobile lock-screen lifecycle boundary                       |
| `split-view`     | Tablet multitasking lifecycle boundary                             |

The existing desktop wallpaper, taskbar/dock, workspace controls, and launcher
scene composition now execute through system-application presentation. The
existing mobile home, dock, and status bar React Native components now live
with their applications instead of inside a monolithic mobile shell.

The lifecycle-only modules identify planned presentation seams without
pretending that unfinished notification, quick-settings, lock-screen, or
split-view interfaces are complete. Their profile membership and service
boundaries are implemented; their final visual and interaction work can now be
developed independently.

System applications receive an immutable profile/device context and a narrow
`ShellServiceClient`. They do not coordinate by importing one another. Shared
operating-system behavior therefore stays behind Runtime services, while
presentation, layout, local state, and interaction stay with the application.

### Device profiles

Three built-in profiles are registered:

- **Desktop:** wallpaper, desktop home, dock, status bar, launcher, and
  notifications.
- **Tablet:** wallpaper, tablet home, dock, status bar, split view,
  notifications, and lock screen.
- **Mobile:** wallpaper, mobile home, status bar, dock, app drawer, quick
  settings, notifications, and lock screen.

Hosts describe the device instead of hard-coding profile behavior in Runtime or
Genesis. The desktop host supplies desktop/laptop capabilities. The Expo shell
selects tablet or mobile using the platform tablet signal and display size. A
host may also request a profile explicitly.

The registry already accepts TV, watch, automotive, XR, and future string device
classes. Supporting one requires adding a profile and only the applications
whose interaction model is genuinely different.

### Desktop shell and host integration

The host-neutral desktop runtime now owns a `SystemApplicationRuntime`, selects
and activates its device profile during startup, and shuts the shell runtime
down during normal teardown. The desktop scene composer requests wallpaper,
dock/status/workspace chrome, and launcher output from active system
applications instead of owning those visual policies itself.

The Electron development host builds the currently visible desktop shell
applications as independent ES modules under
`dist/system-applications/<application-id>.js`. Its development watcher reports
the changed application ID over a narrow preload IPC API. The renderer imports
that one bundle with a revisioned URL and invokes `hotReload()`.

This reload path preserves the renderer page, SevynOS Runtime, Genesis,
application workers, window state, and all sibling system applications. It also
keeps release packaging explicit: production and development builds create the
system-application bundles, and Electron package configuration includes them.

### Mobile and tablet shell integration

The Expo shell now uses the same profile registry and system-application
runtime as desktop. It mounts generic Genesis overlays from profile slots and
normalized bounds, and renders the mobile or tablet home application selected
by the active profile.

React Native's development refresh remains the mobile bundle transport, while
the shell runtime and Genesis instances are memoized and subscribed through the
external-store interface. This keeps the architecture aligned with targeted
application replacement without introducing a second Runtime or Genesis for
mobile/tablet.

The previous mobile-local launcher, dock, frame, status-bar, and theme modules
were removed after their active responsibilities moved into system applications
or the generic host adapter.

### Genesis boundary cleanup

Genesis no longer exports or contains shell-specific nodes. The old Genesis
`shell` source and `SystemPanel` terminology were removed. Hosts now request a
generic `Overlay` and use `mountOverlay`/`unmountOverlay`.

This is intentionally vocabulary-neutral: Genesis creates surfaces, manages
scene nodes, routes input, composites, and presents. It does not know whether an
overlay represents a dock, status bar, phone home screen, lock screen, or future
vehicle control surface.

Automated architecture checks scan Genesis source and fail if shell-component
or form-factor vocabulary returns. Separate checks prevent system applications
from depending on Runtime/Genesis internals and verify the independent
application directory layout.

## Hot-reload behavior

The desktop development sequence is now:

```text
edit one desktop system application
  -> esbuild rebuilds the affected independent entry
  -> the host reports application ID + revision
  -> the renderer imports the revisioned module
  -> shell runtime starts the replacement with captured state
  -> old instance stops after replacement succeeds
  -> only that application is swapped
```

Other system applications, Runtime, Genesis, application processes, and the
Electron renderer remain alive. Failure is isolated: a malformed module,
mismatched ID, or failed lifecycle start is rejected and recorded in desktop
diagnostics without replacing the active application.

Use `pnpm dev` for the desktop workflow. Use
`pnpm --filter @sevynos/shell start` for Expo mobile/tablet development.

## Removed and reorganized source

Significant obsolete or misplaced shell source removed by this phase includes:

- Genesis-owned shell exports and system-panel node definitions;
- mobile-shell-owned home launcher, dock, status frame, and theme files;
- duplicate desktop visual composition helpers after their transfer to system
  applications;
- UI-specific compositor terminology that encoded a shell concept in Genesis.

The changes were source moves or responsibility extractions, not feature
deletions. Compatibility-facing package identities remain stable where active
consumers depend on them, and host adapters continue to translate the new
generic contracts into the existing desktop and React Native presentation
models.

## Maintainability and performance effects

- A shell visual change now invalidates a small system-application entry rather
  than requiring an operating-system or full renderer rebuild.
- Device composition is declarative and testable instead of distributed through
  desktop/mobile conditionals.
- Runtime and Genesis have fewer reasons to change when a contributor edits UI.
- Independent package and entry boundaries improve Turbo/esbuild cache
  granularity and enable parallel work.
- Transactional reload avoids leaving a partially upgraded shell active.
- State capture provides a stable migration seam for more sophisticated
  application-local state as components mature.
- Normalized profile bounds allow hosts to adapt layouts to display size without
  embedding component identity in Genesis.
- Static dependency and vocabulary checks turn architectural intent into an
  enforceable production gate.

No speculative rendering optimization was mixed into the architecture work.
The existing input and focus paths retain their behavior, and all graphics,
input, desktop-shell, Linux-host, and QEMU configuration tests continue to pass.

## Production verification

The final `pnpm check` completed successfully on August 6, 2026:

| Gate                                           | Result                     |
| ---------------------------------------------- | -------------------------- |
| Repository formatting                          | Passed                     |
| ESLint                                         | 16/16 package tasks passed |
| TypeScript/project references                  | 27/27 tasks passed         |
| Repository and QEMU architecture/configuration | 13/13 tests passed         |
| Package unit and integration tests             | 875/875 tests passed       |
| Total automated test assertions                | 888/888 passed             |
| Desktop shell                                  | 71/71 tests passed         |
| Shell core                                     | 7/7 tests passed           |
| Device profiles/system applications            | 3/3 tests passed           |
| Desktop host and reload/packaging              | 6/6 tests passed           |
| Production workspace builds                    | 15/15 tasks passed         |
| Git whitespace/error check                     | Passed                     |

The build also produced and validated four independent desktop entries:
Wallpaper, Dock, Status Bar, and Launcher. Full QEMU ISO boot testing was not
repeated because it deliberately produces a large ignored disk image; the QEMU
configuration tests and Linux host suite passed as part of the normal gate.

## Deliberate remaining work

1. Implement the final visuals and interactions for the lifecycle-ready
   notification center, quick settings, lock screen, app drawer, and tablet
   split view.
2. Add independent desktop bundles for those applications as each gains an
   active desktop presentation. The current watcher covers every visible
   desktop chrome application.
3. Connect richer shell service implementations for notifications, system
   settings, permissions, and device state; keep those APIs in Runtime services
   rather than importing applications directly.
4. Add TV, watch, automotive, and XR profiles only when their input and layout
   requirements are defined. The core contract does not require another OS.
5. Keep full ISO construction, boot smoke testing, and Linux-native Rust checks
   as release gates because they are intentionally heavier and
   artifact-producing.

## Final assessment

The repository now has the architectural seam required by the mission: UI is
owned by independent system applications, device experiences are selected by
profiles, Genesis is UI-agnostic, Runtime is UI-independent, and active visual
components can reload without an OS rebuild or reboot. The remaining work is
application implementation on top of this boundary, not another architectural
split.
