# Tokrah on SevynOS — M6 bring-up

Tokrah (100% React Native) runs on SevynOS as a third-party app. This
directory holds everything SevynOS-side: the Metro config that bundles
Tokrah against the SevynOS compat shim, the shim itself, the mock
harness that proves a live session end to end, and the packager that
turns the bundle into a `.sevyn` bundle for the image.

Tokrah's own repo is **never touched and never copied in**: it is
consumed as-is from `TOKRAH_SRC` (a local checkout) or, in CI, from a
clone authenticated with the `TOKRAH_READ_TOKEN` secret (a read-only,
repo-scoped PAT on realkevonporter/tokrah — Sevyn cannot create repo
secrets; without it the M6 workflow fails loudly with instructions).
The built Tokrah bundle is **never committed** to this public repo:
it contains Tokrah's proprietary JS and Hermes bytecode is
decompilable.

## Layout

- `metro.config.js` — Metro + Expo config. Resolves against Tokrah's
  own node_modules plus the v2 renderer's React copies; aliases
  `react-native` to the shim and native modules to stubs. Nothing is
  hoisted into this monorepo's pnpm catalog.
- `build-tokrah.mjs` — `TOKRAH_SRC=… node build-tokrah.mjs
./entry-tokrah.js <out.js> [platform]` (platform `ios` — native
  packages ship only `.ios`/`.android` files, so a custom platform
  fails to resolve them; the shim is selected by module name, so
  `ios` changes nothing about the SevynOS surface).
- `entry-tokrah.js` — the host entry: env glue, expo-router, run the
  app. `entry-debug.js` — same, but wraps element creation to name
  the component behind a React #130 (production React gives no name).
  `entry-hello.js` — the smoke-test entry (renders one line).
- `shim/` — the React Native compat surface + native-module stubs:
  - `env.js` — globals glue: console → Sevyn.log, timers,
    TextEncoder/Decoder, crypto.getRandomValues, XHR + fetch over
    `sevyn net fetch` (host) or `__sevynHttpRequest` (Node harness).
    **WebSocket is deliberately absent** so engine.io-client falls
    back to XHR polling, which works over the exec bridge. A real
    WebSocket needs a host adapter (a later milestone, not M6).
  - `react-native.js` — host components as string tags (the v2
    renderer's surface) + StyleSheet/Platform/Dimensions/AppRegistry/
    Animated/FlatList/etc.
  - `stub-*.js` — one stub per native package. Two kinds:
    - **Dedicated** (the mount path calls these for real): reanimated
      (animations complete instantly), gesture-handler (inert),
      safe-area-context (real contexts, zero insets), expo-image,
      bottom-sheet, legend-list, secure-store (in-memory within a
      launch — the socket layer needs the access token back after
      login), expo-constants, expo-linking, expo-widgets,
      vision-camera (permissions granted, no camera), glass-effect,
      font, splash-screen, haptics, crypto, clipboard, device,
      location (null island), file-system (in-memory File store),
      media-library, image-picker, document-picker, notifications,
      blur, linear-gradient (first color solid), symbols, status-bar,
      video, audio, task-manager, sharing, background-task,
      tracking-transparency, iap, web-browser, screen-capture,
      keep-awake, vector-icons, expo-ui, livekit (fake room +
      local participant, state "disconnected" — no media publishes),
      callkeep (all methods resolve), toast-message, google-mobile-ads,
      expo, firebase-messaging.
    - **Generic** (`stub-generic.js`): packages the mount path only
      touches at load time — renders children, no-ops calls.
  - `stub-empty.js`, `stub-native-module.js`,
    `stub-turbo-module-registry.js`, `stub-renderer-proxy.js` — deep
    react-native machinery files (InitializeCore, TurboModuleRegistry,
    BatchedBridge, RendererProxy) substituted **after** resolution,
    because real packages import them by relative path.
- `harness/` — the Node verification harness (mock Sevyn global with
  a two-pass Yoga layout, mock Tokrah API + Socket.IO server on
  127.0.0.1:7070, UI driver, source-map query):
  - `node drive-live.js <bundle.js>` drives login → home feed →
    go-live → start live → socket `live:join` → host screen → end
    live, asserting each step against the mock server's events.
    Exit 0 = full pass.
- `make-tokrah-bundle.py` — packages the compiled hbc into
  `tokrah.sevyn` (unsigned third-party bundle, `cli.exec` permission)
  for the image build.

## Rules for adding a stub

1. If the mount path **calls** it (methods, hooks, components with
   props the app reads), write a dedicated stub that honours the
   real return shapes (promises stay promises — `setup().catch()`
   throws if `setup` returns undefined). If it is only **imported**,
   the generic stub is enough.
2. Stubs with a `default` export need a non-enumerable `__esModule`
   marker, or Babel wraps the stub as `{default: exports}` and
   `X.default` resolves to the exports object.
3. The generic stub's Proxy must return `undefined` for `prototype`
   and `isReactComponent` — otherwise React treats every stubbed
   component as a class and throws `context.render is not a function`.
4. `ListHeaderComponent`/`ListFooterComponent`/`ListEmptyComponent`
   may be elements, not component types — render an element as-is,
   never `createElement()` it (React #130: an element as a type).
5. Never throw at load. A stub that throws at import time kills the
   whole mount; a stub that returns an inert value lets the app run.

## What works / what doesn't (M6)

Works: full bundle loads, mounts, renders the login screen; login
via the UI; home feed; go-live; start live; socket `live:join`; host
screen; end live (all proven by `drive-live.js` against the mock API,
and in-guest by `m6-check.mjs` through `sevyn tokrah run` headless).
Doesn't: real camera/mic (vision-camera + LiveKit are stubbed — no
media publishes, the host screen shows "Waiting for your video");
push notifications; secure storage across launches (in-memory only);
https fetch (the `sevyn net fetch` bridge is http-only — the M6 proof
is http; a TLS transport is a follow-up); icon glyphs (the font isn't
loaded on the host — they render as text ops in the mock and as
missing-glyph boxes on the real host).

## Building the image

`v2/image/build-m6-image.sh` (extends the M5 script): bundles Tokrah
from `TOKRAH_SRC` (or a `TOKRAH_READ_TOKEN` clone), compiles to
Hermes bytecode, packages `tokrah.sevyn` into pristine, stages the
raw hbc at `/usr/share/sevyn/tokrah/tokrah.hbc` (what `sevyn tokrah
run` falls back to), and stages the mock API server for the check.

## Running it

- Headless (no window): `sevyn tokrah run [--seconds N]
[--input <events-file>] [--out <ops.json>]` — the bundle mounts
  and presents; `--out` gets the latest present's ops as JSON (rects
  - texts with coordinates, for the check to find buttons); the host
    also logs a compact ops line (`HOST headless ops {...}` — texts +
    pressable rects) to the console whenever the screen's text changes,
    so the check can read coordinates off the serial log. `--input` is
    a timed event file, events separated by `;` (one line — it is
    written through the Terminal): `<ms> pointer <down|up|move> <x>
<y>` / `<ms> key <evdev-code> <down|up> <shift 0|1>` / `<ms> type
<text>` (expands to key down/up pairs, 30 ms/char).
- Interactive: install `tokrah.sevyn` via the M3 loader — it appears
  in the dock (registry-driven) and opens in its own 800×500 window.
- Fetch bridge: `sevyn net fetch --method <m> <url> [--header
<Name:value>]... [--data <body>]` — one plain HTTP request, prints
  `<status>\n<headers-json>\n<body>`. Header values and the body are
  percent-encoded by the shim (the exec bridge splits on whitespace
  with no quoting).
