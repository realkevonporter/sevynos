# M12 — Genesis: the GPU compositor

Status: scope + build in progress (2026-11-13, branch `v2/gpu-compositor`).
Ordered by Kevon 2026-11-13 ("Start the GPU compositor"). Build to PR, then stop — no merge.
Compositor name: **Genesis** (Kevon, 2026-11-13) — revives the v1 name. The old
tree called it "Genesis Compositor" / "Genesis Wayland Engine" (ADR-0006,
`docs/decisions/ADR-0006-genesis-compositor-strategy.md`); the v2 tree uses
the name nowhere yet, so there is no competing use to reconcile.

## The bar (locked)

60 fps on the GF65 (MSI GF65 Thin 9SD, GTX 16-series) once Genesis lands.
QEMU/TCG software rendering runs ~10–30 fps and CANNOT prove the bar — the
GF65 hardware retest is Kevon's gate. CI proves Genesis is active and the
desktop works; only the GF65 proves the frame rate.

Genesis lifts the whole desktop (shell, dock, system apps, Sevyn Code), not
just the browser. The native Chromium embed comes AFTER this milestone, not
in it. CDP screencast stays dead (15–30 fps, killed by the 60 fps bar).

## Where we are (2026-11-13, main 6e781906)

- Weston is the Wayland compositor (`drm-backend`, `v2/image/weston.ini`),
  launched with `--renderer=pixman` — the CPU renderer, explicitly.
- The RN host (`v2/rn/host/`) rasterizes every frame on the CPU: `Painter`
  (`painter.cc`) draws the JS draw-op list into a shared-memory ARGB8888
  buffer (FreeType glyph raster per present, cached), and `Wayland`
  (`wayland.cc`) attaches it as a `wl_shm` buffer. Double-buffered, frame
  callbacks pace presents.
- `v2/compositor/` holds only the M1 test client — no GPU compositor exists.
- The image already stages Mesa's DRI drivers and libgbm
  (`usr/lib/x86_64-linux-gnu/dri`, `.../gbm` in `build-m11-image.sh`), but
  nothing in the guest uses EGL: the only libEGL/libGLESv2 in the image are
  Chromium's ANGLE copies, invisible to everything else.
- The real bottleneck is the host's CPU raster, not Weston: every present
  re-rasterizes the scene in software at 1920x1080. Weston compositing
  SHM buffers through pixman is the second CPU cost.

## Design

Genesis is the GPU compositor: Weston running its GL renderer, plus the RN
host presenting through EGL/GLES2. Two halves, one milestone.

### Weston stays

Replacing Weston with a from-scratch compositor (the old ADR-0006 wlroots
plan) is a separate, much larger milestone: Weston owns the seat, the
outputs, and the input routing that M1–M11 prove. Rewriting it would void
those proofs and the whole input stack. M12 is stage 1 of the ADR-0006
staged strategy — GPU-accelerate the compositor we have. A native
compositor remains a possible later stage if Kevon wants it.

- The init script tries `--renderer=gl` first. If the Wayland socket does
  not appear within 15 s, it kills Weston and restarts with
  `--renderer=pixman`, logging the fallback to the console. A GPU failure
  can never brick the boot.
- The active renderer is logged to the console (`GENESIS weston
renderer=gl|pixman`) so the check can assert on it.

### Host: the Genesis present path

New `v2/rn/host/genesis-presenter.{h,cc}` — `GenesisPresenter`, one EGL
context per host process:

- Init (lazy, on first present): `eglGetDisplay` on the Wayland display,
  `eglInitialize`, config RGBA8 + `EGL_WINDOW_BIT`, `wl_egl_window` on the
  host's `wl_surface`, `eglCreateWindowSurface` + a GLES2 context,
  `eglSwapInterval(1)`. Logs `GENESIS EGL <renderer> <version>` once.
  Any failure → the presenter reports unavailable and the host keeps the
  CPU path for the life of the process. `SEVYN_GENESIS=0` (from the kernel
  cmdline `sevyn.genesis=0`) forces the CPU path.
- Frame: the same `DrawOp` list the CPU painter executes, rendered as GLES2:
  - Rects: one shader program, solid color, rounded corners via a
    signed-distance function in the fragment shader (radius from the op).
  - Text: FreeType still rasterizes glyphs — on the CPU, once, into the
    painter's glyph cache. The presenter uploads each glyph bitmap to a
    texture atlas (1024x1024, row-packed, cleared on overflow) and draws
    textured quads tinted with the text color. Font rendering stays
    pixel-identical to the CPU path; only the compositing moves to the GPU.
  - Images: the painter's decoded-RGBA cache, uploaded once per path to a
    GL texture, drawn as textured quads.
  - Clips: the op clip stack becomes `glScissor` rects, intersected the
    same way the CPU painter intersects them.
- Vsync: `eglSwapBuffers` with swap interval 1, on top of the existing
  `wl_surface.frame` pacing in `Wayland` (frame callbacks still gate the
  next present; nothing in the frame-callback protocol changes).
- Accounting: the presenter counts presents and logs a rolling
  `GENESIS fps <n>` line — the check asserts frames flow; the number is
  only meaningful on hardware.
- Resize/remap: `wl_egl_window_resize` + `glViewport` on resize; the EGL
  surface is destroyed and re-created when `Wayland::remap()` recreates
  the `wl_surface`.

The CPU `Painter` and the SHM present path are untouched and remain the
fallback: every `Wayland` still owns both painters, and text measurement
still uses the CPU painter. Headless mode (`--headless`, M6) never touches
EGL — ops go to the JSON dump exactly as today.

### What is NOT in M12

- No Chromium embed (next milestone). No change to the browser app.
- No change to input, seat, output, or window management.
- No new Wayland protocols; no wlroots; no Vulkan.
- No change to the update/A-B path; the compositor is not part of the
  updater's payload.

## Image + staging (build-m12-image.sh)

New builder, copied from `build-m11-image.sh` — the M11 builder is
untouched, so the M11 check keeps proving its own image.

- Host compile: `genesis-presenter.cc` joins the `sevyn-rn-host` link, with
  `-DSEVYN_HAVE_EGL=1` and `egl glesv2 wayland-egl` in the pkg-config
  cflags/libs. The build FAILS if the EGL dev packages are absent — a
  silent CPU-only M12 image is not acceptable. (CI gets `libegl-dev`
  `libgles-dev` in the M12 workflow; `wayland-egl.h` already ships with
  `libwayland-dev`.)
- Staging: `libEGL.so.1` / `libGLESv2.so.2` / `libwayland-egl.so.1` arrive
  through the host's copy-closure (ldd); the Mesa EGL platform plugin
  (`libEGL_mesa.so.0`, dlopened by libEGL) is copied explicitly, failing
  loudly if absent. The DRI drivers + libgbm copies from M11 stay.
  Drivers that must be present: `iris` (GF65 Intel iGPU), `virtio_gpu`
  (QEMU virgl), `kms_swrast` + `swrast` (QEMU without virgl — software GL,
  functional but slow; this is what CI runs on).
- The nightly (`public-build.yml`) switches to `build-m12-image.sh`, so
  Genesis ships in the nightly on merge. The M11 workflow keeps its own
  builder.

## Acceptance bar

- GF65: 60 fps sustained in the shell (dock, scrolling, window drags) —
  hardware proof only, Kevon's retest.
- CI (m12-check): Weston GL renderer active; host GPU present path active
  (`GENESIS EGL …` + `GENESIS present path=gpu`); shell READY and the home
  feed paints (the M7 ops proof); frames flow (`GENESIS fps` samples);
  fallback boot with `sevyn.genesis=0` reaches the shell on the CPU path.
- No regressions: M1–M11 + Repository quality green on the PR.

## Verification plan

1. Local: `pnpm format:check && pnpm typecheck && pnpm lint && pnpm
test && pnpm build` (turbo lint/test with `--concurrency=3` — full
   parallelism OOMs in the sandbox); `npx prettier --check` before
   pushing; host C++ compile-checked standalone (EGL headers installed
   in the sandbox).
2. CI: the PR runs all workflows (it touches `v2/`). M12's own workflow
   builds the M12 image and runs `m12-check.mjs` in QEMU.
3. KVM box (45.77.162.169) if time allows: `build-m12-image.sh` +
   `m12-check.mjs` under KVM — the fastest real QEMU proof.
4. GF65 (Kevon): flash the nightly, confirm 60 fps + no visual
   regressions. This is the only proof of the bar.

## Risks

- Mesa `kms_swrast` missing or broken on the CI runner's sysroot: the M12
  check would fail at the GL-renderer assertion. Mitigation: the check
  fails loudly (never silently passes on the pixman fallback); the
  fallback keeps the nightly bootable regardless.
- llvmpipe is slow at 1920x1080 under TCG: the check asserts frames flow,
  never a frame rate. The fps number is hardware-only.
- EGL init differences between Mesa versions (iris vs llvmpipe): the
  presenter logs the renderer string so a failure names the driver.
