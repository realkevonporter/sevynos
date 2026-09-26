# @sevynos/genesis

The scene-graph, compositor, surface, and window-management library for the
**mobile shell** (`shell/mobile`).

## Why it exists alongside `@sevynos/graphics`

`@sevynos/graphics` (`graphics/core`) is the host graphics subsystem: it talks to the
Rust Wayland bridge, EGL/GLES, and DRM on the SevynOS desktop/Linux shell. The mobile
shell is an Expo app running on real React Native on iOS/Android hardware — it cannot
use the host graphics stack. `@sevynos/genesis` is the self-contained equivalent for
that target: window state, z-ordering, scene nodes, surfaces, and a compositor, with
zero native dependencies.

## Scope

- `src/windows` — window state and `GenesisWindowManager` (open/close/focus/z-order).
- `src/scene` — scene-graph nodes and bounds.
- `src/surfaces` — surface lifecycle management.
- `src/compositor` — composition of the scene into frames.

## Consumers

Only `shell/mobile` imports this package. The desktop/Linux shell uses
`@sevynos/graphics` instead. Do not import it from host code.

## Naming note

"Genesis" here is the scene-graph library. It is unrelated to the "Genesis" Node.js
host process that runs the desktop shell compositor — the shared name is historical.
