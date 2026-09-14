# React Native on SevynOS

## Current architecture

React Native is an application framework above the framework-neutral SevynOS
Runtime. The Runtime owns application identity, sessions, lifecycle, packages,
permissions and service policy. The React Native framework maps React elements
to native render commands; the desktop shell maps those commands to Genesis
surfaces and windows; the Linux host presents the resulting scene through the
existing Wayland bridge. React Native does not own hardware, privileged policy,
the compositor or the operating-system ABI.

```text
React Native application
  -> @sevynos/react-native
  -> Sevyn Runtime session and capability broker
  -> Genesis window/surface/input APIs
  -> Genesis compositor and host renderer
  -> Wayland/Weston/DRM on the current Linux image
```

The repository currently contains a custom React reconciler using Meta's Yoga
engine. It is a functional native SevynOS renderer, not an upstream Fabric renderer.
Linux and Electron isolated application hosts now evaluate the verified package
entrypoint, resolve its `AppRegistry` key, and mount the resulting tree. The
`sevyn dev`/`sevyn run-sevynos` workflow watches and reloads a development
package in the running Electron host; a persistent installer and source-mapped
Metro diagnostics remain incomplete.

The Linux image now builds the version-matched Hermes VM from source and ships
`sevyn-hermes-host`. That native executable evaluates packaged HBC bytecode and
provides a bounded JSI message channel through `__sevynPostMessage` and
`__sevynReceiveHostMessage`. The package builder emits HBC alongside its
JavaScript compatibility bundle. The Linux Wayland host now dispatches isolated
applications to Hermes. Initialization, native surface rendering, input events,
lifecycle messages, timers, promises, brokered service requests and shutdown all
cross the same validated worker protocol used by the compatibility host.

The TurboModule registry and brokered native invocation surface are available,
including an Expo modules-core compatibility layer. Fabric, TurboModule codegen,
native autolinking and a production kernel-enforced application sandbox remain
separate compatibility milestones.

## Application entry point and platform resolution

Applications use the familiar registration contract:

```ts
import { AppRegistry } from "react-native";
import { Application } from "./Application";

AppRegistry.registerComponent("main", () => Application);
```

`Platform.OS` is `"sevynos"`, and `Platform.select` prefers `sevynos`, then
`native`, then the default value. Sevyn Metro builds use `platform: "sevynos"`,
so files resolve in this order before their generic equivalents:

```text
Component.sevynos.tsx
Component.sevynos.ts
Component.sevynos.jsx
Component.sevynos.js
Component.tsx / Component.ts / Component.jsx / Component.js
```

The Metro configuration aliases the `react-native` module to the installed
`@sevynos/react-native` package using an absolute package root. This makes the
configuration usable outside this monorepo and avoids treating a package name as
a filesystem path.

## Build and development commands

Inside this repository:

```sh
pnpm --filter @sevynos/react-native build
pnpm --filter @sevynos/metro test
pnpm --filter @sevynos/cli test
pnpm --filter @sevynos/desktop-host dev
```

`sevyn create <directory> <reverse.domain.id> <name>` creates a normal
AppRegistry entry, shared application source, `app.json`, a SevynOS manifest and
a small `sevynos/` platform directory. `sevyn build` emits the package entry
bundle and optimized Hermes bytecode. `sevyn package` verifies content hashes,
including the HBC payload, and writes a Sevyn package.
The dual-boot installer scripts are part of the Linux image; package signatures
and a persistent system update channel remain separate work.

The Electron development host reloads arbitrary watched Metro application
packages while preserving the application window and session. Standard React
Native Fast Refresh semantics and source-mapped runtime diagnostics are still
future work.

## Permissions and native services

An application manifest declares `runtime: "react-native"`, an `applicationKey`,
permissions and window modes. Worker service requests cross bounded structured
IPC and are checked by the trusted broker. Application storage is namespaced and
quota-limited. The current Linux filesystem service is rooted under the SevynOS
user directory, while ordinary third-party app filesystem grants still need
per-application directories and user-mediated document grants.

Use feature detection for optional facilities:

```ts
import { SevynOS } from "@sevynos/react-native";

if (SevynOS.supports("camera")) {
  // Request permission and open the camera when a camera module is available.
}
```

`SevynOS.require(feature)` throws an error with code `UnsupportedFeature` rather
than returning mock data.

## Compatibility matrix

Status means behavior implemented by the current repository and covered by at
least source-level tests. It does not imply upstream React Native compatibility
or physical-hardware validation.

| React Native core             | Status    | Current limitation                                                        |
| ----------------------------- | --------- | ------------------------------------------------------------------------- |
| AppRegistry                   | Supported | Verified packages load in isolated Linux and Electron hosts               |
| Platform / `.sevynos.*`       | Supported | Metro bundle selection is tested                                          |
| View, Text                    | Supported | Custom reconciler, not Fabric                                             |
| Image                         | Supported | URI/data/local loading, cache, size, prefetch and bitmap surfaces         |
| TextInput                     | Partial   | Keyboard editing exists; IME, shaping and selection incomplete            |
| ScrollView                    | Partial   | Wheel/offset path exists; mature momentum/scrollbar behavior incomplete   |
| Pressable / touchables        | Supported | Real button chrome (background, radius, pressed/hover/focus feedback)     |
| FlatList                      | Supported | Bounded render windows, spacers, keys, separators and end-reached support |
| SectionList / VirtualizedList | Supported | Section flattening uses the same bounded list engine                      |
| Modal, Switch, SafeAreaView   | Partial   | Basic native primitives                                                   |
| Animated                      | Partial   | Shared motion primitives; no native-thread Reanimated worklet runtime     |
| Accessibility                 | Partial   | Live Linux settings, announcements and state events; AT-SPI focus remains |

| Native capability                  | Status    | Current limitation                                                                         |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| Namespaced key/value storage       | Supported | In-memory default; Linux file-backed adapter exists for host use                           |
| Text clipboard                     | Supported | Wayland round trip; no rich/image/file clipboard contract                                  |
| Filesystem                         | Partial   | Real Linux filesystem; per-app document broker is incomplete                               |
| Notifications                      | Supported | Brokered policy plus Linux desktop notification daemon integration                         |
| Network/fetch/WebSocket            | Partial   | Bounded fetch, dynamic NetInfo, and brokered text/binary WebSockets; browser media remains |
| Window lifecycle                   | Partial   | Genesis windows and app lifecycle exist; public multi-window API incomplete                |
| Audio/battery/Wi-Fi                | Partial   | Linux services and dynamic state are wired; full routing remains                           |
| Camera, microphone, video, capture | Partial   | V4L2 capture and ALSA start/stop are brokered; video streaming remains                     |
| Bluetooth, location, printing      | Partial   | BlueZ, GeoClue and IIO services are wired; pairing/printing remain                         |

| Expo                                     | Status        |
| ---------------------------------------- | ------------- |
| Expo Router architecture                 | Not validated |
| expo-modules-core                        | Partial       |
| expo-file-system / secure-store / sqlite | Unsupported   |
| expo-image / font                        | Unsupported   |
| expo-camera / audio / video              | Unsupported   |
| expo-notifications / location / sensors  | Unsupported   |

## Button Chrome and Control Commands

Third-party React Native applications can use standard `<Pressable>`, `<Button>`,
`<TouchableOpacity>`, and `<TouchableHighlight>` primitives without requiring OS
settings integration. Buttons automatically render native interactive button chrome
via the Genesis `control` command:

- **Interactive Chrome**: Buttons render with native corner radius, raised surface
  background, and dynamic state feedback (`idle`, `hovered`, `focused`, `pressed`, `disabled`).
- **Style-Driven Customization**: Standard style properties (`backgroundColor`,
  `borderRadius`, `borderColor`, `borderWidth`, `color`, `opacity`) are forwarded
  directly into the `control` command, enabling full visual styling while preserving
  native interaction physics.
- **Open Action Extension**: The `NativeControlAction` type is an open union:
  - System settings actions (`"theme"`, `"accent"`, `"taskbar-position"`, etc.)
    remain dedicated to Genesis shell preferences.
  - Third-party controls default to `action="custom"`.
  - Custom actions (`action="app.save"`, etc.) can be passed as arbitrary strings
    without colliding with desktop settings handlers.
- **Immediate State Feedback**: Pointer down, pointer up, hover, and focus events
  immediately commit frame snapshots to ensure zero-latency pressed and hovered visuals.

## Porting guidance

Start with applications whose business logic and interface use React Native core
components and JavaScript-only packages. Keep window management separate from
in-application navigation. Use `.sevynos.tsx` only for desktop layout or a native
dependency without a shared implementation. Packages containing Android, Apple
or legacy-bridge native code require an explicit SevynOS implementation.

The next platform milestones are a real Fabric renderer, AT-SPI semantics and
IME/text shaping, browser media, and Expo module adapters beyond the core bridge.
The current core surface is tested on the compatibility host and the Linux
Hermes host, but this matrix is not a claim of upstream RN or Expo 100% parity.
