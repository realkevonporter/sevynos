# SevynOS v2 — React Native host (M3)

The shell is a real React Native app. It runs on a purpose-built native
host — no Electron, no web view, no Node in the image. One bridge, one
runtime contract (see REBUILD_PLAN.md §2): the host embeds Hermes, lays
out with Yoga, and paints to a Wayland surface through the Weston
compositor M1 proved. M3 adds the app runtime: one host process per app
(the shell is one, each launched app is another), so a crashing app
never takes down the shell.

## Pieces

| Piece                        | What it is                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host/sevyn-rn-host.cc`      | The host binary. Hermes embed + Yoga + Wayland client + painter + input + status bridge. One process, one app: the shell in M2; since M3 every launched app is its own host process too (sandboxed — a crashing app never takes down the shell).                               |
| `host/appclient.{h,cc}`      | M3: the appd client (mirrors `status.{h,cc}`) — subscribes to appd's `/run/sevyn-apps.sock` for EVENT lines, `listApps()` / `launchApp()` over the socket.                                                                                                                     |
| `host/wayland.{h,cc}`        | M3: windowed mode — apps get an 800×500 `xdg_toplevel` with title + app_id and a close handler; the shell stays fullscreen and is not closable.                                                                                                                                |
| `host/build-deps.sh`         | Fetches and builds the native deps into a prefix: Hermes 0.13.0 (source) + Yoga (pinned commit). CI caches the prefix.                                                                                                                                                         |
| `renderer/sevyn-renderer.js` | The JS renderer: a `react-reconciler` host config. Host components `View`, `Text`, `Image`, `Pressable`, `ScrollView`. Layout is Yoga (via the host); paint is a flat draw-op list per commit.                                                                                 |
| `shell/`                     | The shell app itself (TypeScript + RN components): dock, launcher, status tray. Built with esbuild, compiled to Hermes bytecode with `hermesc`. Since M3 the dock renders from appd's registry (`Sevyn.listApps()`), falling back to the built-in 12 when appd is unreachable. |
| `../loader/`                 | M3: the `.sevyn` loader + app daemon (C, outside `rn/` — see `v2/loader/`).                                                                                                                                                                                                    |
| `../apps/`                   | M3: the stock-app template (one RN screen, packaged per app by `make-bundles.py`).                                                                                                                                                                                             |

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
  M3: gated by the `status.read` permission — an app without it gets
  `{}` and its status subscriber never starts (the shell always has it).
- `Sevyn.appId` / `appName` / `appColor` / `appGlyph` — the app's
  identity from its manifest, passed by appd at launch (the shell
  reads `"shell"` / `"SevynOS"` / `"#111827"` / `"S"`).
- `Sevyn.hasPermission(name)` — true when the manifest grants it (the
  shell always returns true).
- `Sevyn.listApps()` — M3: the registry over appd's socket, as
  `[{id, name, version, color, glyph, system, protected, permissions,
signatureKeyId}]`. Returns `[]` when appd is unreachable.
- `Sevyn.launchApp(appId)` — M3: real launching through appd (the
  shell's dock click). Returns true iff appd accepted the launch; the
  app then runs in its own host process and window. M2 only logged
  `LAUNCH <appId>`.
- `Sevyn.onAppEvent(fn)` — M3: appd's `EVENT LAUNCHED / STOPPED /
CRASHED / INSTALLED / UNINSTALLED <id>` lines. The renderer keeps an
  app store (`subscribeApps` / `getAppsSnapshot`, mirroring the status
  store) so the dock shows running dots and clears "Starting…" on
  STOPPED/CRASHED, and re-lists on INSTALLED/UNINSTALLED.
- `Sevyn.closeApp()` — M3: apps only; the host exits 0 (appd reports
  STOPPED). The shell returns false (it is not closable; the
  compositor's close button does the same thing for apps).
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
  `afddb3b7c273642223d4237f82a41a5bfe1ad865fff1317ef6c38eaf7c9026a4`
  (verified against the codeload URL 2026-11-07; the earlier pinned
  hash did not match what codeload serves and failed CI).
  The standalone `facebook/yoga` repo is the source; the npm
  `yoga-layout` package is only the WASM binding and does not carry the
  C++ sources. Built as `libyogacore.a` via its CMakeLists.
- **System libs** (apt, already in the M1 image deps where noted):
  `libwayland-client`, FreeType, libpng, fontconfig, DejaVu fonts.

## Rendering model

- One fullscreen `xdg_toplevel` surface (1024×768, the Weston output
  mode) for the shell. Apps get a windowed 800×500 `xdg_toplevel`
  (title = app name, app_id = app id); closing it exits the app's host
  process cleanly. The shell ignores close requests (it is not
  closable).
- Paint is CPU raster into a shared-memory buffer: solid rounded rects,
  FreeType text, PNG images (libpng). No GL — same as M1's pixman
  compositor. The painter is deliberately boring; a GPU path is a
  later milestone, not a correction to this one.
- Every commit repaints the full frame. M2's shell is small; per-frame
  cost is negligible at 1024×768. Dirty-rect optimisation is deferred
  until a profile says it matters.

## What M3 proves (m3-check.mjs)

1. Boot: the shell mounts and appd is ready with its control serial,
   after seeding all 12 stock bundles from pristine.
2. The dock is registry-driven: the first tile is Browser (alphabetical
   seed order) and the dock still never overflows.
3. Keys reach the shell: Tab + Enter launches the first app into its
   own window (its own host reports `SEVYNOS_M3_APP_READY`).
4. Input reaches the app: the app window's close X stops it (clean
   exit 0) and the window disappears.
5. Status is live inside a permitted app window (Files, `status.read`):
   a volume push repaints its window body.
6. Permissions are enforced: Notes (no `status.read`) does NOT repaint
   on a status push, while the shell tray does.
7. A crashing app never takes down the shell (`APP CRASHED crash 1`,
   shell still on screen).
8. The loader refuses bad bundles (tampered hash; untrusted system
   signature) and refuses to uninstall the protected terminal.
9. The done-when, end to end: a bundle installs, runs sandboxed, is
   deleted (LIST no longer shows it), and reinstalls offline from
   pristine (LIST shows it again) and relaunches.

## What M3 does NOT do

- The Terminal/Settings/Files apps (M4), networking/browser (M5),
  Tokrah (M6). The stock apps are one shared template screen — real
  app content arrives with M4.
- A GPU renderer. CPU raster only, by design.
