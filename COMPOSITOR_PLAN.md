# COMPOSITOR_PLAN.md — Genesis: the SevynOS compositor (custom wlroots, true browser embedding)

Status: plan (2026-11-19, branch `v2/compositor-plan`).
Ordered by Kevon 2026-11-19 ~06:35 EST ("Build the compositor route —
custom Genesis with foreign-toplevel"). Build to PR, then stop — no merge.
Model: **Genesis is the compositor.** The custom wlroots compositor is not
an experiment alongside Weston; it is the SevynOS compositor, and the
browser embed is its first proof: Chromium's surface placed by Genesis
inside the Browser app's content rect, as one window, at 60 fps.

## The split (locked, Kevon 2026-11-19 ~06:41 EST)

**Genesis gets its own public repo: `realkevonporter/genesis`,
GPL-3.0-or-later (same license as SevynOS), with its own README, LICENSE,
and CI. Its README must state plainly: Genesis is SevynOS's official
compositor, built for SevynOS only, open-source.**

Kevon is creating the repo himself (2026-11-19 ~06:42 EST) and will hand
it over. **No repo-creation attempt via API** — the seed waits for his
handover (repo URL + write access for the PAT). If the handover shows the
repo is private or the PAT cannot write to it, that is reported plainly
instead of worked around.

**The split comes FIRST, then Stage 2 in the new repo.** The boundary is
defined here, before any code moves. Nothing is seeded until the handover
is confirmed.

### What moves to `genesis` (decided from the code)

- **The C compositor itself** — the future `v2/compositor/` tree
  (ADR-0006 Phase 2 layout: `include/`, `src/` with `main`, `server`,
  `backend`, `output`, `seat`, `input`, `xdg-shell`, `surface-registry`,
  `runtime-bridge`, `logging`, `protocols/`, `tests/`, `meson.build`)
  lives in the genesis repo from the start. There is no C server code in
  sevynos today to move; Stage 2 is written there, not in sevynos.
- **`v2/compositor/test-client.c`** — the M1 test client (one
  xdg_toplevel window, two same-client subsurfaces, pointer/keyboard
  logging) becomes the genesis repo's first test client. It has no
  license header today — it is covered only by sevynos's root LICENSE —
  so the seed PR adds the `SPDX-License-Identifier: GPL-3.0-or-later`
  header on move.
- **`graphics/core/` (whole package) → genesis `model/`.** This is the
  pure-TypeScript, host-independent scene/display/surface/window/renderer
  model (`GenesisCompositor`, `GenesisScene` + scene nodes,
  `GenesisDisplay` + display manager/registry/render plans, surface and
  window registries, frame executor/render loop) with its vitest suite.
  It moves whole, not sliced: `compositor/` imports `../window/` and
  `display/` imports `../errors/`, so slicing it would break the package.
  Why it moves: it is the spec-as-code for exactly the concepts the C
  server must implement, it is GPL-3.0-or-later already
  (`graphics/core/package.json`), it is self-contained, and **nothing in
  the v2 rebuild imports it** — moving it costs sevynos nothing and gives
  the new repo day-one CI content (model tests) plus a tested policy
  model next to the implementation. In the genesis repo it stays
  TypeScript under `model/`; the C server is the implementation, the model
  is the executable spec and the tests — it is not shipped code in the
  image. (Exact npm package name in the new repo is a detail for the
  seed PR; no npm publishing is decided here.)

### What stays in `sevynos`

- **`v2/rn/host/` — all of it**, including `genesis-presenter.cc` and
  `wayland.cc`. These are Wayland _clients_: the presenter is the M12
  client-side EGL present path (the host drawing its own frames), not
  compositor server code. The name "genesis" there means "the
  Genesis-era present path" — it does not make it compositor code.
- **The Shell, the Runtime/appd, `sevyn.c`** (the CLI, including the
  browser verbs and the future `browser embed` verb), statusd, the image
  builders, the m-checks (m1/m12/m13), `weston.ini`, the nightly.
- **`graphics/genesis/` (`@sevynos/genesis`, mobile scene library) —
  stays, and is NOT the compositor.** Its README already says so: it is
  the self-contained scene-graph library for `shell/mobile`, "unrelated
  to the Genesis Node.js host process", "Do not import it from host
  code". The shared name is a historical collision the split must not
  deepen: the new public repo is the wlroots compositor, the mobile
  package keeps its name and scope. Renaming either one is a separate
  decision for Kevon, not part of the split.
- **Plan/history docs** (`BROWSER_PLAN.md`, `GPU_COMPOSITOR_PLAN.md`,
  this plan) stay in sevynos; the genesis repo gets its own README that
  states the SevynOS-only purpose.

### How sevynos consumes genesis (picked): pinned-commit fetch at image-build time

**Pick: the image builder fetches a pinned genesis commit — not a
submodule, not a vendored copy.** The pin lives in one file
(`v2/image/genesis-pin.txt`: commit sha + tarball sha256), and
`build-genesis-image.sh` fetches
`https://codeload.github.com/realkevonporter/genesis/tar.gz/<sha>`,
verifies the sha256, extracts it, and builds the compositor + test
client from the fetched tree. A builder env override
(`SEVYN_GENESIS_SRC=/path/to/local/genesis`, same shape as
`SEVYN_V2_SYSROOT`) lets a developer build against a local checkout
without bumping the pin.

Why this, and not the alternatives:

- **Precedent in this tree:** the builders already pin and fetch external
  artifacts at build time (the Chromium snapshot 1738523, staged by the
  M5/M13 builders). A pinned genesis tarball is the same shape, and the
  pin is bumped by a PR exactly like the Chromium pin.
- **Submodule — rejected:** there is no submodule precedent in the repo,
  and the push path (`gh-push.py`, git-database API) has no
  submodule/gitlink support — a gitlink entry could not be created or
  verified through this workflow, and CI would need `submodules: true`
  on every checkout. Revisit only if push tooling ever supports
  submodules.
- **Vendored copy checked into sevynos — rejected:** it duplicates the
  source of truth, drifts silently, and defeats the point of the split.
- **The m1 check's path matters:** today `build-m1-image.sh` compiles
  `v2/compositor/test-client.c` from the tree. After the split, the M1
  builder compiles the test client from the fetched genesis tree at the
  pinned commit; `m1-check.mjs` itself is unchanged (it only cares the
  binary exists and behaves). Until the split lands, M1 keeps building
  from the tree — the split PR flips the builder and the pin in one
  commit, so the nightly never has a gap.
- **CI ownership:** the genesis repo's CI owns the model tests (vitest),
  the C compositor build, the test-client build, and eventually the
  nested genesis-check. Sevynos CI owns the image + m-checks against the
  pinned commit.

### Order of work (split first, Stage 2 second)

1. **Handover** — Kevon confirms the repo URL + PAT write access
   (verified by `GET /repos/realkevonporter/genesis` and a write probe;
   private or unwritable is reported, not worked around).
2. **Seed PR (in `genesis`)** — README + LICENSE + CI + moved
   `graphics/core/` → `model/` + moved `v2/compositor/test-client.c` →
   `compositor/test-client.c` (with the SPDX header) + its build. No C
   server code yet — the seed is the boundary, the model, and the test
   client.
3. **Consumption PR (in `sevynos`)** — builder fetches the pinned genesis
   tarball; M1 builder compiles the test client from the fetched tree;
   pin file added; `v2/compositor/test-client.c` and `graphics/core/`
   removed from sevynos in the same PR. One commit, no gap; the nightly
   keeps working throughout because the pin points at the seeded genesis
   commit.
4. **Stage 2** (minimal nested compositor) lands in the genesis repo,
   consumed by sevynos at a new pin.

### Where this plan lives

This plan PR (#135) is open in sevynos. After the handover, Kevon
decides whether the plan moves to the genesis repo — the PR stays in
sevynos until he says so; it is not moved unilaterally.

## The decision (locked, Kevon 2026-11-19 ~06:38 EST)

**Genesis is SevynOS-only and the official compositor — the one and only
shipping compositor.**

Weston is development infrastructure only: the Stage 2 nested compositor
runs inside it during development, and it stays a reference and test
environment. Weston is NOT a shipping configuration and NOT a product
fallback. The product ships Genesis, period. There is no flag that selects
Weston at runtime in the shipping image, and no Weston binary staged into
it. The staged path is unchanged (Stage 2 nested → Stage 3 standalone),
but the destination is now explicit.

The failure case the old fallback used to cover is handled differently:
if Genesis fails, the product does not fall back to Weston — it fails safe
to a terminal/recovery environment (see "Failure without fallback"
below). "Never a bricked desktop" means a Genesis failure always lands on
a usable console with the `sevyn` CLI, never a hung black screen.

## The bar (locked)

60 fps on the GF65 (MSI GF65 Thin 9SD, GTX 16-series) once the embed
lands, with Chromium's buffers reaching the screen zero-copy. QEMU/TCG
software rendering runs ~10–30 fps and CANNOT prove the bar — the GF65
hardware retest is Kevon's gate. CI proves adoption is live and the
desktop works; only the GF65 proves the frame rate.

The embed lifts the Browser app, not the whole desktop — Genesis (M12)
already did the desktop. CDP screencast stays dead (15–30 fps, killed
by the 60 fps bar): the page is proven by pixels in Chromium's own
buffers, presented by Genesis, never by a screencast frame.

## Where we are (2026-11-19, main f3ce6739)

- The compositor is Weston (ADR-0006 Stage 1). `v2/compositor/` holds only
  `test-client.c` (an M1 subsurface test client). No custom wlroots
  compositor exists yet.
- M12 Genesis is merged: Weston runs its GL renderer and the RN host
  presents through EGL/GLES2, with the CPU painter as fallback.
- M13 is in progress (PR #121 is the coordination fix, not embedding):
  Chromium runs as a chromeless app-mode window **paired with** the
  Browser app window, sized to the content rect (800x348 under the
  Browser window's 152 px of chrome), lifecycle by pidfile/state file
  (`/data/chromium.state`, `sevyn browser quit`). The two windows are
  not contained — Weston cascades the Chromium toplevel wherever it
  chooses, which is why the detached window and drag drift exist.
- `sevyn browser` already drives Chromium over CDP (M5/M13): `open`
  (launch if needed), `tabs`, `activate`, `close`, `status` (running +
  CDP + tab count + `gpu:` line), `quit`. The Browser app
  (`v2/apps/src/Browser.tsx`) already has tabs + an address bar and
  drives Chromium over the same CDP channel (127.0.0.1:9222, HTTP only).
- The RN host (`v2/rn/host/wayland.cc`) connects as a plain Wayland
  client (`wl_display_connect`, `WAYLAND_DISPLAY=wayland-0`), creates one
  xdg_toplevel per app window with an app_id, and presents through EGL or
  the SHM CPU painter.

## Locked constraints

- **60 fps bar, GF65 is the proof.** QEMU proves adoption works; only
  Kevon's GF65 retest proves the frame rate and the zero-copy path.
- **CDP screencast is dead.** Killed by the 60 fps bar (M12); this plan
  does not revive it. CDP stays the control plane, not the frame
  transport.
- **No Linux shell access.** The Browser is a SevynOS app; the Terminal
  exposes only the `sevyn` CLI, never bash. (The recovery console below
  is a platform recovery shell, not user shell access — see "Failure
  without fallback".)
- **`.sevyn` bundles.** The Browser app ships as a stock bundle like
  every system app; it is deletable and reinstalls offline from pristine.
- **Browser multi-instance.** The embed must not assume a single Browser
  window: the app launches per-window like every stock app (M3), so the
  Chromium adoption and lifecycle are per Browser window, never a global
  singleton.
- **Genesis-only shipping.** No Weston fallback, no runtime compositor
  selection in the shipping image (see "The decision" above).
- **ADR-0006 stands.** wlroots is the foundation; no Weston fork, no
  libweston, no from-scratch compositor. Language: C. The compositor
  stays independent from the Runtime; the two communicate through a
  narrow, versioned interface. Public platform APIs use SevynOS-owned
  terminology, never `wlr_*` types.

## The decisive Wayland facts

True in-window embedding — Chromium's pixels inside the Browser app's own
window — is impossible on the Weston stack, and this plan is the fix:

- A separate-process Chromium surface **cannot be a subsurface** of the
  host window: `wl_subcompositor` is same-client-only. Chromium is a
  different client; the protocol forbids attaching its surface under
  ours. (`v2/compositor/test-client.c` proves the same-client case only:
  its two subsurfaces belong to the test client itself.)
- `xdg-shell` gives the client **no positioning**: a toplevel cannot
  place itself at an offset inside another window. Weston
  (desktop-shell) cascades new toplevels wherever it chooses.
- Frame transport is CDP screencast by another name — dead on the
  60 fps bar (measured 15–30 fps).

### The foreign-toplevel fact (verified from upstream, not theory)

`wlr_foreign_toplevel_management_v1` (`zwlr_foreign_toplevel_manager_v1`,
protocol version 2 in wlroots) does NOT move or position a foreign surface
inside another window. Verified against the upstream protocol XML
(`wlr-foreign-toplevel-management-unstable-v1.xml`) and the wlroots
implementation (`types/wlr_foreign_toplevel_management_v1.c`): its stated
purpose is taskbars and docks. After a client binds the manager, each
opened toplevel is sent via the `toplevel` event, and the manager client
may request maximize, minimize, fullscreen, activate, and close — plus
`set_rectangle`, which is only a hint for minimizing (the rectangle where
the requesting app represents the toplevel). There is no request to move,
resize, reparent, or embed a surface, and no guarantee any request is
honoured ("There is no guarantee the toplevel will be actually activated").

So, stated plainly: **adoption is compositor-internal scene placement,
NOT a protocol feature.** Genesis owns the `wlr_scene` graph
(`wlr_scene_create`, `wlr_scene_tree_create`,
`wlr_scene_surface_create`, `wlr_scene_subsurface_tree_set_clip`) and
places any surface's node anywhere in the scene. The foreign-toplevel
protocol's role is listing, control, and association — the Shell binds
the manager to know which toplevels exist, to activate/close them, and
to tell adopted surfaces apart from standalone windows. It is not the
embedding mechanism, and no client request through it can place a surface.

## Design

### Foundation and pins

- **wlroots 0.17.1**, pinned. Verified 2026-11-19: `libwlroots-dev`
  apt candidate on Ubuntu noble is 0.17.1-2.1build1; wayland-client/server
  1.22.0, wayland-protocols 1.45, weston 13.0.0 (Weston only as the
  development host compositor for Stage 2 — it is not staged into the
  standalone shipping image). The pin is recorded in the builder and the
  workflow; a wlroots upgrade is a deliberate change, not a drift.
- **Language: C** (ADR-0006). The Shell stays TypeScript/React Native;
  the boundary is a typed native interface / IPC, never raw wlroots
  pointers in Shell code.
- **Layout** (ADR-0006 Phase 2, in the genesis repo — see "The split"):
  `compositor/` with `include/`, `src/` (`main`, `server`, `backend`,
  `output`, `seat`, `input`, `xdg-shell`, `surface-registry`,
  `runtime-bridge`, `logging`), `protocols/`, `tests/`, `meson.build`,
  `README.md`.
- **Protocols in v1:** core Wayland compositor, wl_shm, wl_output, wl_seat
  (pointer + keyboard), xdg-shell, `zwlr_foreign_toplevel_manager_v1`
  (Shell only — see below), `zwp_linux_dmabuf_v1` (the zero-copy path).
  Nothing else is advertised. No Xwayland, no screen capture, no global
  shortcuts, no virtual keyboard, no tablet protocols, no remote desktop,
  no session locking, no idle inhibition, no color management, no
  fractional scaling, no output management UI, no drag and drop.
- **Renderer:** wlroots GLES2 renderer. Chromium's dmabuf buffers are
  imported as textures; the RN host keeps presenting through EGL/GLES2
  exactly as under M12, so the M12 texture path is the model, not a new
  invention. SHM buffers remain a correctness fallback for clients that
  submit them (the nested CI check runs on them) — a SHM Chromium is a
  failed bar, not a pass: the GF65 proof requires the dmabuf path.

### Stage 2 — Minimal nested wlroots compositor (ADR-0006)

Genesis runs nested inside a Weston session (Weston is the outer
compositor here — development infrastructure, the same role it plays
today). Complete when (ADR-0006's nested milestone, verbatim):

1. It launches inside an existing Wayland session.
2. It creates one nested output window.
3. The Sevyn Shell renders inside that output.
4. A React Native application connects to it.
5. The application creates an XDG surface.
6. The compositor associates that surface with a Runtime session.
7. Pointer input reaches the correct surface.
8. Keyboard focus is visible and predictable.
9. The application can be closed from the Shell.
10. The Runtime records the stopped state.
11. The compositor exits without leaving application processes behind.

The nested compositor is also where Stages 4–5 are first proven (fast
iteration, restartable without logging out), before they are re-proven
standalone.

### Stage 3 — Standalone Genesis compositor (ADR-0006)

Genesis runs without a parent compositor: DRM/KMS output (virtio-gpu in
QEMU, the GF65 panel on hardware), libinput device input, session
management, hardware-backed rendering. Complete when (ADR-0006's
standalone milestone, verbatim):

1. It starts without a parent graphical compositor.
2. It controls one documented output.
3. It receives keyboard and pointer input.
4. It launches the Sevyn Shell.
5. It launches one React Native application.
6. It displays both Shell and application surfaces.
7. Focus and close operations work.
8. It returns safely to a terminal or recovery environment after exit.
9. Startup and shutdown are documented.
10. Major crashes produce useful logs.

Item 8 is the recovery guarantee — see "Failure without fallback". One
output only in v1; multi-output is explicitly out of scope.

### Stage 4 — Adoption: the mechanism

The adoption mechanism is the new platform capability. It is built and
proven in the nested compositor first, then re-proven standalone.

#### The request channel (picked): Runtime → compositor IPC over a Unix socket

**Pick: a Unix socket, `/run/sevyn-compositor.sock`, speaking a narrow
versioned IPC protocol (v1: `adopt`, `move`, `resize`, `release`).**
The Runtime is the only client; the compositor authenticates the peer
with `SO_PEERCRED` (the peer must be the Runtime's pid, which init passes
to Genesis at launch) and the socket is mode 0600, owned by the platform
user.

Why this channel, and not a SevynOS-owned Wayland protocol:

- Adoption is a **privileged** operation: it lets one app place another
  app's pixels inside its own window. A Wayland protocol global is
  discoverable and bindable by every client; gating it to one client is
  possible but the auth story is ad-hoc, and the protocol would be
  SevynOS-specific surface area exposed to every client on the system.
- The Runtime already owns **both sides** of the pairing: it owns the
  Browser app session, and it owns the Chromium pid (via
  `/data/chromium.state`, written by `sevyn browser` at launch). The
  adopt request is three fields the Runtime already holds: the Browser
  session id, the Chromium pid, and the content rect. No new identity
  system is needed.
- The pattern already exists in the tree: `sevyn.c` speaks AF_UNIX
  `SOCK_STREAM` to `/run/sevyn-update.sock`, `/run/sevyn-status.sock`,
  `/run/sevyn-ai.sock`, `/run/sevyn-comms.sock`; `statusd.c` is the model
  for a small daemon on a `/run/sevyn-*.sock` path. The compositor socket
  follows that shape, and the messages are versioned (first field is the
  protocol version), per ADR-0006's "narrow, versioned interface".
- The rejected alternative — a `sevyn_adoption_v1` Wayland protocol —
  stays rejected for v1. Revisit only if a future need requires
  client-initiated adoption (e.g. a third-party app embedding a surface
  it launched itself); even then the Runtime mediates, because only the
  Runtime knows which pid belongs to which session.

#### How Genesis identifies the Chromium toplevel

By **pid, not by app_id**. When a client connects, the compositor reads
its pid with `wl_client_get_credentials`. The Runtime's adopt request
names the Chromium pid for that Browser session; Genesis matches new
xdg_toplevels by pid. The toplevel's app_id (`chromium` — to be confirmed
from the live surface at the Stage 4 spike, against Chromium 159 as
launched by `sevyn browser`) is a sanity check only. A client that claims
app_id `chromium` but whose pid is not the Runtime-declared one is never
adopted — ADR-0006's rule stands: the compositor must not trust
client-provided application identity. The Runtime is the source of truth
for session↔pid association; the compositor enforces it.

#### Placement, clipping, move/resize

- Genesis keeps a per-Browser-window **adoption record**: the Browser
  window's `wlr_scene_tree`, the adopted Chromium surface's
  `wlr_scene_surface` node as a child of that tree, and the content rect
  (window-local coordinates).
- The adopted node is positioned at the window's output position plus the
  rect origin, and **clipped** to the rect with
  `wlr_scene_subsurface_tree_set_clip` on the Chromium surface's subtree,
  so Chromium pixels can never paint outside the content area — not over
  the tab bar, not over the address bar, not over neighbouring windows.
- **Move:** when the Browser window moves, Genesis repositions the
  adopted node by the same delta in the same frame — the two can never
  drift apart, because there is only one scene graph and one output
  position. This is the fix for M13's drag drift: the pairing is structural,
  not two windows that happen to sit near each other.
- **Resize:** when the Browser window resizes, Genesis sends
  `xdg_toplevel.configure` to Chromium with the new content size, and
  Chromium resizes its own surface. This is also the fix for M13's
  missing live resize sync — and it needs no CDP WebSocket client in the
  C CLI, because the resize is a compositor configure, not a CDP call.
- The adopted Chromium toplevel is **never activated as a standalone
  window** and never appears as a separate dock/taskbar entry: the Shell,
  which binds `zwlr_foreign_toplevel_manager_v1`, hides adopted surfaces
  from the window list (the manager tells it the toplevel exists; the
  Runtime tells it the toplevel is adopted into a Browser window).

#### Input routing and focus policy

- **Pointer:** hit-testing is the scene graph's own
  (`wlr_scene_node_at`): a pointer position inside the content rect
  hits the adopted Chromium surface; anywhere else in the window it hits
  the Browser chrome surfaces. No coordinate translation layer, no pixel
  geometry in the harness — the compositor routes to the surface actually
  under the cursor, the same property `test-client.c` proves for
  subsurfaces in M1.
- **Keyboard focus:** clicking the content rect focuses the Chromium
  surface (keys go to the page); clicking the chrome focuses the Browser
  app (keys go to the address bar). When the Browser window is focused
  and the pointer is over the content rect, keys go to the page. Chromium
  can never steal focus on its own: the adopted toplevel is never
  activated except through the Browser window's focus, and Genesis
  ignores activation requests for adopted surfaces that did not come via
  the Browser window.
- **Scroll / wheel / touch:** pointer axis events follow the same
  hit-test as clicks. Touch, when it arrives, follows the same rule;
  touch is not a v1 deliverable beyond not breaking.

#### Lifecycle (who kills whom)

- **Chromium dies:** Genesis removes the adopted node, notifies the
  Runtime over the IPC socket, and the Browser app shows its empty state
  ("No tab open yet") — the same state it shows today when `browser tabs`
  reports n=0. The Browser window itself stays open. The compositor never
  kills a process; it only manages surfaces.
- **Browser closes:** the existing path stands — the in-app close runs
  `sevyn browser quit`, and appd CLOSE of the Browser app SIGTERMs
  Chromium from `/data/chromium.state`. Genesis then sees the surface
  vanish and drops the adoption record. No new kill path is introduced.
- **Compositor dies:** everything on screen dies with it — it is the
  display server, same as Weston today. That is the recovery case below,
  not a fallback case.
- **Runtime dies:** Genesis keeps presenting the last scene but refuses
  new adoptions until the Runtime reconnects and re-registers; this is a
  degraded state the recovery console can inspect, not a silent hang.

### Stage 5 — Browser embedding: the contract

Stage 5 wires the real Browser app and the real Chromium through the
Stage 4 mechanism, and proves the bar.

#### What the Browser app and `sevyn browser` must do differently

- **`sevyn browser open` stops guessing geometry.** Today it launches
  Chromium with `--window-size=800,348` and hopes Weston cascades it
  beside the Browser window. Under Genesis it launches Chromium with no
  window-size placement at all (Chromium's initial size is whatever the
  compositor configures on first map); Genesis places and sizes the
  surface from the adoption record. `--app=<url>`,
  `--ozone-platform=wayland`, `--no-sandbox`, the GPU-first launch with
  the `--disable-gpu` fallback, the CDP port, the profile dir, and the
  pidfile/state file are all unchanged.
- **New CLI verb: `sevyn browser embed <x> <y> <w> <h>`.** The Browser
  app reports its content rect in **window-local** coordinates (today:
  origin (0,152), size 800x348 under the 152 px of chrome) on mount and
  on every move/resize. The CLI forwards the rect to the Runtime, which
  issues the adopt/move/resize over the compositor socket. The app never
  talks to the compositor directly and never learns output coordinates —
  the compositor owns output placement.
- **`browser status` gains an `embedded:` line** (`embedded: yes
<x>,<y>,<w>x<h>` / `embedded: no`), alongside the existing `gpu:` line,
  so the adopted state is observable from the Terminal and assertable by
  the check — the same observability rule that made the `gpu:` line exist.
- **Browser.tsx renders a placeholder until adoption confirms.** The
  content area shows a loading state until the Runtime confirms the adopt;
  if adoption fails, the app shows the failure (not a blank area) and the
  page stays drivable over CDP. The "page renders in the paired Chromium
  content window" copy is updated to the adopted window.
- **Close still runs `sevyn browser quit`.** The in-app close button and
  appd CLOSE both still kill Chromium; nothing about the kill path
  changes.

#### What stays the same

- **The CDP control plane is unchanged.** `open` / `tabs` / `activate` /
  `close` / `status` / `quit` keep their exact verbs and output shapes;
  `Browser.tsx` keeps driving Chromium over CDP; the Terminal keeps
  driving it the same way. M13's single-tab-by-design contract stands:
  each `browser open` replaces the current tab, and the pairing stays
  per Browser window, never a global singleton.
- **The Browser app's chrome is unchanged.** Tabs, address bar, and the
  152 px chrome layout are the same; only the content area's backing
  changes from "a window Weston happened to cascade nearby" to "a surface
  Genesis placed and clipped".
- **No CDP WebSocket client in the C CLI.** Resize, raise, and focus all
  go through the compositor now; the CLI's HTTP-only CDP boundary (the
  known M13 limit) is no longer the thing standing between the app and a
  working browser.

#### Complete when

1. The Browser app launches and its content rect is adopted on first
   map — Chromium's pixels appear inside the Browser window, clipped to
   the rect, with no second window visible.
2. Dragging the Browser window moves Chromium's content with it, same
   frame, zero drift (proven by screendump before/after).
3. Resizing the Browser window resizes Chromium's surface via compositor
   configure (proven by screendump + CDP viewport size).
4. Clicking the page focuses Chromium (keys reach the page); clicking the
   address bar focuses the app (keys reach the TextInput); pointer
   position alone decides, with no pixel-geometry hacks in the app.
5. Closing the Browser window kills Chromium (pidfile gone, no orphan);
   killing Chromium empties the Browser content area without killing the
   app.
6. `browser status` reports `embedded: yes` with the live rect and
   `gpu: yes` on the GF65.
7. **GF65: 60 fps sustained** (scrolling, navigation) with the dmabuf
   path active — the only proof of the bar.

## Failure without fallback

Weston is not the fallback, so the plan must say what happens when
Genesis fails — and guarantee the machine is never bricked. The guarantee
is a **recovery environment**, and it is a Stage 3 deliverable, proven
before the standalone compositor becomes the shipping default:

- **Supervision:** init starts Genesis as a supervised process and waits
  for the Wayland socket (`/run/wayland-0`) with a bounded timeout, the
  same shape as the M1 init's socket wait — except the timeout branch
  does not power off. On timeout, or on Genesis exiting, init starts the
  recovery console.
- **The recovery console:** a busybox `sh` on `/dev/console` (and the
  serial console, which is how the harness and Kevon read the machine),
  with the `sevyn` CLI on PATH, the logs preserved (`/tmp/genesis.log`,
  the compositor's structured logs), and `poweroff` / `reboot` available.
  It is a platform recovery shell for diagnosing and restarting — it is
  not user shell access and it is not a desktop. Genesis releases DRM
  master on clean exit, and on crash the kernel VT switch hands the
  console back, so the recovery console always has a display to write to.
- **Direct entry:** the kernel cmdline `sevyn.recovery=1` boots straight
  to the recovery console without starting Genesis — the entry point for
  a machine whose compositor is known-bad, and the way the recovery path
  itself is proven in CI.
- **"Never a bricked desktop" means:** every Genesis failure mode lands
  on a usable console with the CLI and the logs, within the socket-wait
  bound, with a working poweroff/reboot. It does not mean the desktop
  keeps working without its compositor — that is impossible by definition
  (the compositor _is_ the display server), and any plan that promises it
  is promising a second compositor under another name.
- **What is NOT staged for recovery:** Weston. The recovery environment
  needs a shell, a CLI, and logs — not a second graphical stack. Staging
  Weston "just in case" would reintroduce the exact thing the decision
  removed: a shipping Weston configuration.

## What is NOT in this work

- No frame transport, no CDP screencast revival, no CEF, no Chromium
  Embedded Framework of any kind.
- No Weston fork, no libweston, no from-scratch compositor.
- No multi-output, no Xwayland, no screen capture, no global shortcuts,
  no virtual keyboard, no tablet protocols, no remote desktop, no session
  locking, no idle inhibition, no color management, no fractional scaling,
  no output management UI, no drag and drop.
- No multi-tab. Real multi-tab is the principled follow-up, not this
  work: it needs a WebSocket client in the C CLI driving Page.navigate /
  minimize-restore windows — CDP over HTTP only cannot drive a live tab
  switch across windows. (Adoption is per Browser window; multi-tab
  reuses it, one adopted surface per tab's window.)
- No change to the CDP control plane, no CDP WebSocket client in the C
  CLI, no change to commsd, Sevyn Code, or any WebView.
- No change to the queue's PRs (#134, #132, #133, #121, camera
  #126→#128→#130, audio #127→#129→#131). This plan is docs-only; it
  touches no code and no queue branch.
- No Weston in the shipping image, no Weston fallback, no runtime
  compositor selection (see "The decision").

## Image + staging

- **New builder, copied from `build-m13-image.sh`** — the M13 builder is
  untouched, so the M13 check keeps proving its own image. The new
  `build-genesis-image.sh` fetches the genesis repo at the pinned commit
  (see "The split" — `v2/image/genesis-pin.txt`, tarball sha256-verified,
  `SEVYN_GENESIS_SRC` local override) and builds the compositor + test
  client from the fetched tree; it adds `libwlroots-dev` 0.17.1 (pinned)
  and its build deps, stages `sevyn-compositor` + the
  `sevyn-compositor.sock` path, and carries the init change (supervise
  Genesis; socket-wait timeout → recovery console;
  `sevyn.recovery=1` → recovery console directly). Weston is staged
  only into the _nested-check_ image variant (Stage 2, where it is the
  outer compositor); the standalone image stages no Weston.
- **New workflow `v2-genesis.yml`, modeled on `v2-m1.yml`** (same
  shape: install deps → build image → run the QMP harness in QEMU →
  upload artifacts). The check, `genesis-check.mjs`, boots the nested
  image and proves: Genesis socket up, Shell + one RN app inside it,
  adoption of a test surface pair into a host rect (geometry by
  screendump, clipping by pixel probe), pointer/keyboard routing to the
  adopted surface, close behavior, clean exit with no orphaned processes;
  then boots the standalone image and proves the same plus the recovery
  console (`sevyn.recovery=1` → prompt + `sevyn` CLI answers). The m12
  regression runs on the same image. QEMU proves adoption, geometry,
  input, and recovery — never the frame rate.
- **The nightly switches only when Stage 3 + Stage 5 are proven** — the
  nightly keeps shipping the M13 image until the standalone Genesis image
  passes its check and the GF65 proves 60 fps. There is no half-migrated
  nightly.

## Acceptance bar

- GF65: 60 fps sustained in the Browser (scrolling, navigation) with the
  dmabuf path active + real-hardware rendering — hardware proof only,
  Kevon's retest.
- CI (`genesis-check.mjs`, forked from the m1/m13 check pattern):
  Genesis-live set (socket up, Shell + app inside, frames flowing);
  adoption geometry (adopted surface inside the host rect, clipped, no
  second window); pointer/keyboard routing to the adopted surface;
  move/resize follow; close kills Chromium (pidfile gone, no orphan);
  Chromium death empties the content area without killing the app;
  recovery console boot (`sevyn.recovery=1`) + `sevyn` CLI answers;
  the m12 regression on the same image; clean poweroff.
- No regressions: M1–M13 + Repository quality green on every PR in the
  chain.

## Verification plan

1. Local: `npx prettier --check` on the plan document before pushing
   (docs-only PR; no full-tree lint/test — turbo OOMs in the sandbox).
2. CI: the PR runs the quality workflow (docs-only path). The build PRs
   in the chain each run `v2-genesis.yml`.
3. KVM box (45.77.162.169) if time allows: `build-genesis-image.sh` +
   `genesis-check.mjs` under KVM — the fastest real QEMU proof.
4. GF65 (Kevon): flash the nightly once Stage 3 + Stage 5 are proven,
   confirm 60 fps + no visual regressions. This is the only proof of the
   bar.

## Risks

- **Nested vs standalone divergence:** behaviour proven nested may differ
  on DRM/KMS (modes, page flips, input devices). Mitigation: every Stage
  4/5 proof is re-run standalone; the nested check is a development
  accelerator, never the acceptance proof.
- **wlroots API churn:** the scene and foreign-toplevel APIs are
  `WLR_USE_UNSTABLE`. Mitigation: the 0.17.1 pin, SevynOS-owned types
  wrapping every wlroots call, and ADR-0006's rule that no public API
  names a `wlr_*` type.
- **Chromium identification assumptions:** the app_id string and the
  dmabuf path are verified at the Stage 4 spike against Chromium 159 as
  launched by `sevyn browser` — if Chromium submits SHM only, the
  zero-copy bar fails and the spike must say so before Stage 5 is built.
- **Focus edge cases:** an adopted surface that grabs keyboard focus at
  the wrong time is a security-relevant bug (input going to the wrong
  app). Mitigation: the focus policy is a Stage 4 acceptance item with
  its own protocol tests (malformed adopt requests, adopt for a dead pid,
  adopt rect outside the window, focus after Chromium death).
- **Recovery unproven is no recovery:** the recovery console must be
  proven by its own check boot before the standalone image becomes the
  shipping default — a recovery path that has never booted is a promise,
  not a guarantee.
- **The old fallback's comfort is gone on purpose:** a Genesis bug that
  used to be maskable by "just boot Weston" is now a visible failure
  that lands on the recovery console. That visibility is the point — it
  forces the compositor to be right — but it means Stage 3 must be
  genuinely solid before the nightly flips, and the flip itself is
  Kevon's call.

## Sources

- `docs/decisions/ADR-0006-genesis-compositor-strategy.md` (stages,
  milestones, C, wlroots, Runtime↔compositor boundary — read in full).
- `BROWSER_PLAN.md` (decisive Wayland facts, M13 pairing, CDP control
  plane, single-tab by design).
- `v2/compositor/test-client.c` (same-client subsurface proof, M1).
- `v2/image/build-m1-image.sh` (Weston launch + init, socket-wait
  pattern) and `build-m12-image.sh` / `build-m13-image.sh`
  (`sevyn.genesis=0` CPU-fallback pattern — the shape the recovery
  entry point follows, not a compositor fallback).
- `v2/rn/host/wayland.cc` (RN host as Wayland client), `v2/apps/src/
Browser.tsx` (Browser app, CDP driving, 152 px chrome, content rect),
  `v2/update/sevyn.c` browser verbs (launch flags, CDP over HTTP on
  127.0.0.1:9222, pidfile `/data/chromium.state`, `/run/sevyn-*.sock`
  IPC pattern).
- Upstream: `wlr-foreign-toplevel-management-unstable-v1.xml` (protocol
  purpose: taskbars/docks; requests: maximize/minimize/fullscreen/
  activate/close + `set_rectangle` minimize hint; version 2 in wlroots)
  and `wlr/types/wlr_scene.h` (`wlr_scene_create`,
  `wlr_scene_tree_create`, `wlr_scene_surface_create`,
  `wlr_scene_subsurface_tree_set_clip`).
- Environment (verified 2026-11-19): `libwlroots-dev` apt candidate
  0.17.1-2.1build1 on Ubuntu noble; wayland 1.22.0, wayland-protocols
  1.45, weston 13.0.0.
