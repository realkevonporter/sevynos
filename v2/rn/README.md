# SevynOS v2 — React Native host (M2)

The shell is a real React Native app. It runs on a purpose-built native
host — no Electron, no web view, no Node in the image. One bridge, one
runtime contract (see REBUILD_PLAN.md §2): the host embeds Hermes, lays
out with Yoga, and paints to a Wayland surface through the Weston
compositor M1 proved.

## Pieces

| Piece                        | What it is                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host/sevyn-rn-host.cc`      | The host binary. Hermes embed + Yoga + Wayland client + painter + input + status bridge. One process, one app (the shell in M2; per-app sandboxed runtimes arrive with the M3 app runtime).    |
| `host/build-deps.sh`         | Fetches and builds the native deps into a prefix: Hermes 0.13.0 (source) + Yoga (pinned commit). CI caches the prefix.                                                                         |
| `renderer/sevyn-renderer.js` | The JS renderer: a `react-reconciler` host config. Host components `View`, `Text`, `Image`, `Pressable`, `ScrollView`. Layout is Yoga (via the host); paint is a flat draw-op list per commit. |
| `shell/`                     | The shell app itself (TypeScript + RN components): dock, launcher, status tray. Built with esbuild, compiled to Hermes bytecode with `hermesc`.                                                |

## Host ↔ JS contract

The host installs a `Sevyn` global before running the bundle:

- Yoga (flat functions, not a `Sevyn.Yoga` object):
  `yogaCreateNode()`, `yogaFreeNode(id)`, `yogaSetStyle(id, style)`,
  `yogaSetChildren(id, [ids])`, `yogaSetMeasureFunc(id, fn)` (the host
  calls the JS fn with `(width, widthMode, height, heightMode)` and
  expects `{width, height}` back; widthMode 0 undefined / 1 exactly /
  2 at-most), `yogaClearMeasureFunc(id)`,
  `yogaCalculateLayout(rootId, width, height)`, `yogaGetLayout(id)` →
  `{x, y, width, height}` (relative to the parent).
- `Sevyn.present(ops, backgroundColor)` — paint a frame. Ops:
  `{type:'rect', x, y, w, h, color, radius, nodeId}`,
  `{type:'text', x, y, w, h, text, fontSize, bold, color, align, nodeId}`,
  `{type:'image', x, y, w, h, asset, nodeId}`,
  `{type:'pushClip', x, y, w, h}` / `{type:'popClip'}`.
  `nodeId` is the Yoga id of a pressable (hit-test target); -1 for
  non-pressable ops. Paints to the SHM buffer and commits the surface.
- `Sevyn.measureText(text, size, bold, maxWidth)` → `{width, height}` —
  FreeType metrics; width is single-line, height wraps at maxWidth.
- `Sevyn.onPointer(fn)`, `Sevyn.onKey(fn)`, `Sevyn.onStatus(fn)` — the
  host calls these on Wayland pointer/keyboard events and statusd
  broadcasts. Pointer events: `{type:'move'|'button'|'axis', x, y,
button, pressed, nodeId?}` — `nodeId` is set on button-press only:
  the host hit-tests the last presented ops, topmost first. Key
  events: `{key: <linux evdev keycode>, pressed}`. Status events:
  `{key, value}`. There is exactly one handler of each kind, owned by
  the renderer — the shell must not register its own.
- `Sevyn.getStatus()` — last known `{battery, wifi, volume}` snapshot.
- `Sevyn.launchApp(appId)` — M2: logs `LAUNCH <appId>` and returns
  true. Real launching is M3 (app runtime); M2 proves click → shell
  handles it.
- `Sevyn.log(msg)` — to `/dev/console` and the host log.

The bundle's top-level code starts the app (the shell calls the
renderer's `render`). The host just runs the bundle and drives frames
off Wayland frame callbacks.

### Renderer notes (react-reconciler 0.34.0, verified against the bundle)

- The reconciler in 0.34 has **no `prepareUpdate` / updatePayload** —
  a host fiber is marked for update whenever `memoizedProps !==
newProps`, and `commitUpdate` is called as
  `(instance, type, oldProps, newProps, handle)` — five args, no
  payload. (The old 6-arg form read the Fiber as `nextProps` and wiped
  every style to `{}` on the first re-render.)
- The reconciler has no `flushSync` export; the sync entry points are
  `updateContainerSync` + `flushSyncWork()`. The shell requests every
  update at SyncLane (priority 2) and the renderer forces the flush
  after each event handler, so a press/key/status is visible on the
  very next present. Plain `updateContainer` schedules through a
  microtask and would not present in the same tick.
- `detachDeletedInstance` is only called for HostComponent fibers
  (tag 5), never for HostText (tag 6). The renderer therefore frees
  Yoga nodes in `removeChild`/`removeChildFromContainer`/
  `clearContainer` (deletions only — moves go through
  `insertBefore`/`appendChild`, which detach-then-insert), with
  `detachDeletedInstance` as an idempotent safety net.
- Status reaches the shell through the renderer's status store
  (`subscribeStatus` / `getStatusSnapshot`, consumed via
  `useSyncExternalStore`). Re-rendering the tree with the identical
  element is a React no-op (bailout), so the store is the only correct
  trigger. The snapshot object is replaced (new identity) only on a
  push.

## Pinned native deps

- **Hermes 0.13.0** (source tarball, sha256
  `40ecd782552335126fdb91f63f6822a7f4bef71ef3ec980fe34a263fbf447c93`).
  No prebuilt Linux `libhermes` exists — the npm `hermes-engine`
  package ships only `hermesc` for linux64 — so it is built from source
  and cached in CI. `hermesc` from the same build compiles bundles.
- **Yoga** at commit `41118bd3a86c637fdb43a90fd596e78375137d0f`
  (2026-11-02), tarball sha256
  `c108661ae6e4688ebfca00241dfb38cce19f6deac9cd12b3a7c4c72ae836d185`.
  The standalone `facebook/yoga` repo is the source; the npm
  `yoga-layout` package is only the WASM binding and does not carry the
  C++ sources. Built as `libyogacore.a` via its CMakeLists.
- **System libs** (apt, already in the M1 image deps where noted):
  `libwayland-client`, FreeType, libpng, fontconfig, DejaVu fonts.

## Rendering model

- One fullscreen `xdg_toplevel` surface (1024×768, the Weston output
  mode). The shell owns the whole screen; window management for apps
  arrives in M3+.
- Paint is CPU raster into a shared-memory buffer: solid rounded rects,
  FreeType text, PNG images (libpng). No GL — same as M1's pixman
  compositor. The painter is deliberately boring; a GPU path is a
  later milestone, not a correction to this one.
- Every commit repaints the full frame. M2's shell is small; per-frame
  cost is negligible at 1024×768. Dirty-rect optimisation is deferred
  until a profile says it matters.

## What M2 proves (m2-check.mjs)

1. The shell surface is on screen (screendump contains dock + top bar).
2. The dock never overflows: with 12 apps the dock stays within the
   screen width and scrolls to reach the far icons.
3. Click lands on the intended control: clicking a launcher icon logs
   `LAUNCH <appId>` and the shell shows its "Starting…" state.
4. Status is live: the tray shows battery/wifi/volume pushed from
   statusd, and a pushed change appears promptly.
5. Keys reach the focused control (launcher keyboard navigation).

## What M2 does NOT do

- Real app launching (M3), the Terminal/Settings/Files apps (M4),
  networking/browser (M5), Tokrah (M6).
- Per-app sandboxed runtimes — the host runs one app (the shell).
  Sandboxing is part of the M3 app runtime.
- A GPU renderer. CPU raster only, by design.
