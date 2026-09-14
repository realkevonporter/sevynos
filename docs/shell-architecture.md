# SevynOS shell architecture

The SevynOS shell is a profile-driven host for independent system
applications. The kernel does not know about UI, Runtime owns application and
service policy, Genesis renders generic surfaces and overlays, and the shell
chooses the applications that define a device experience.

## Source layout

```text
shell/
  core/                  device profiles and system-application lifecycle
  desktop/               desktop policy and host-neutral window coordination
  mobile/                Expo adapter for the mobile profile

applications/shell/
  desktop-home/
  tablet-home/
  mobile-home/
  wallpaper/
  dock/
  status-bar/
  launcher/
  app-drawer/
  notifications/
  quick-settings/
  lock-screen/
  split-view/
```

`shell/core` has no dependency on Runtime, Genesis, React, or a host. Each
application module declares its identity, version, roles, supported device
classes, lifecycle factory, state capture, and optional presentation function.

## Startup

1. A host describes its device class, display size, pointer precision, keyboard,
   touch support, and capabilities.
2. The profile registry selects the highest-priority compatible profile or an
   explicit profile requested by the user or device policy.
3. The system-application runtime verifies that required modules are registered
   and support the device class.
4. It starts the profile's applications in isolation and exposes their slots and
   layers to the host adapter.
5. The host turns application presentation into Genesis surfaces or overlays.

The built-in catalog currently supplies desktop, tablet, and mobile profiles.
TV, watch, automotive, and XR can be added without changing Runtime or Genesis.

## Communication

System applications receive a `ShellServiceClient`. Coordination goes through
named service requests instead of importing a dock, launcher, status bar, or
other system application. Shared business logic belongs in Runtime services;
layout and interaction stay in the system application or profile.

## Hot reload

`SystemApplicationRuntime.hotReload()` creates and starts a replacement module,
passes it the previous instance's captured state, stops only the replaced
instance, and swaps it into the active profile. It does not restart the SevynOS
Runtime, Genesis, or sibling applications.

Desktop development uses independently bundled ES modules:

```sh
pnpm dev
```

Editing `applications/shell/dock/index.ts`, `launcher/index.ts`,
`wallpaper/index.ts`, or `status-bar/index.ts` rebuilds only the system
application bundles affected by that edit. The Electron development host
detects the changed bundle and invokes targeted hot reload without refreshing
the renderer page.

Mobile development uses Expo Fast Refresh:

```sh
pnpm --filter @sevynos/shell start
```

The mobile launcher, wallpaper, taskbar, status bar, and application viewport
are React Native components. The Expo host composes them directly in a flex
layout; profile mounts select lifecycle responsibilities but do not provide
pixel or normalized UI bounds. Genesis continues to track application-window
state and surfaces, but it does not render or position shell chrome.

Editing a mobile system component refreshes that React Native component while
the shell's Runtime and Genesis instances remain memoized. Shell visuals must
not be expressed as scene-node records, JSON UI schemas, or generic overlay
callbacks in the mobile host.

## Adding a device profile

Create a profile with matching device classes/capabilities and an ordered list
of application mounts. Reuse existing application IDs where behavior is shared.
Create a new system application only when the presentation or interaction model
is genuinely different. A host may supply a profile override, but it must not
add device-specific conditionals to Runtime or Genesis.

## Architectural constraints

- Genesis source cannot mention shell components or form factors.
- Runtime production source cannot import graphics, input, shell, or UI
  frameworks.
- `applications/shell` depends on `shell/core`, not Runtime or Genesis.
- System applications do not coordinate by importing one another.
- System application developers author visual components in React Native.
- Mobile and desktop shell visuals are React Native components composed by profile hosts.
- Device profiles select applications and policy; React Native owns visual layout.
- Generated bundles, `dist`, caches, native targets, and packaged images remain
  outside source review and version control.
