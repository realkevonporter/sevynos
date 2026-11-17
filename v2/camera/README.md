# SevynOS camera stack — native V4L2 service

Kevon's call (2026-11-16): the Camera stack is **native** — a V4L2
capture service, not the Chromium `getUserMedia` bridge. The earlier
bridge PR (#125) is superseded and is not built on here.

## Pieces

| Piece                           | Where                                             | Status                                                         |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `camd` — V4L2 capture daemon    | `v2/camera/camd.c`                                | PR 1 (this stack)                                              |
| `sevyn camera` CLI verbs        | `v2/update/sevyn.c`                               | PR 1                                                           |
| RN camera module (host adapter) | `hosts/linux/src/linux-native-module-services.ts` | PR 2 |
| Camera app                      | `v2/apps/src/Camera.tsx`, `camera-main.tsx`       | PR 3                                                           |

## Why a daemon, and why C

- The image stages **no ffmpeg and no v4l2-ctl**. The old host camera
  service spawned both, so on real hardware every camera call failed
  at `spawn ENOENT` — the path was dead on the image even though it
  worked on a dev machine. `camd` talks V4L2 ioctls directly and
  links only libjpeg-turbo + libpng, whose closures the image build
  already knows how to stage.
- The daemon owns the device (one opener, one stream) so the RN host,
  the Camera app, and the Terminal all see the same camera state
  through one socket instead of racing `open()` on `/dev/video0`.
- C because the frame path is ioctls + `mmap` + pixel conversion:
  no Node runtime is staged for system services except commsd's
  (which exists for the Matrix SDK), and a 2.7 MB RGB frame plus a
  libjpeg encode is exactly what C is for.

## Protocol

One line in, one JSON line out over `/run/sevyn-camera.sock`
(aid-style, like commsd). `STATUS`, `LIST`, `PREVIEW [w h]`,
`CAPTURE [path]`, `DECODE <jpeg> <rgba> [maxPixels]`, `SHUTDOWN`.
Replies are `{"ok":true,...}` or `{"ok":false,"error":"..."}`.

- **Capture:** MJPEG straight from the device when it offers it
  (byte-for-byte, a real sensor JPEG); otherwise YUYV encoded here
  with libjpeg-turbo (quality 85).
- **Preview:** 640×360 by default, written as **both** an RGBA file
  (the RN host adapter reads raw pixels) **and** a PNG file (the
  v2/apps shell renderer decodes PNG only). Each preview gets a
  fresh sequence-numbered path because the painter caches images by
  path forever — a new path per frame is what makes the preview
  move. The previous pair is unlinked.
- **DECODE:** JPEG → RGBA (+ PNG sidecar) for the gallery viewer,
  capped at 1 MP like the old host path. This is what retires the
  last ffmpeg call in the camera path.
- **No device:** `STATUS`/`PREVIEW` answer `available:false`;
  `CAPTURE` fails with `ok:false`. A device without a camera never
  gets a faked photo.

## Synthetic source

`--synthetic` (init passes it when the kernel cmdline carries
`sevyn.syntheticcamera=1`) generates a test pattern — gradient,
colour bars, a moving bar, a frame counter — and runs the exact
same encode paths. QEMU has no camera, so `camd-check.mjs`
compiles the daemon, starts it synthetic, and proves the service
answers, preview frames flow and differ, shutter writes a valid
1280×720 JPEG, and DECODE round-trips it — with no hardware.

## What is deliberately NOT here

- **Video recording.** v1 is stills only. `recordStart`/`recordStop`
  stay unimplemented in the host adapter until a follow-up wires an
  encoder; nothing pretends otherwise.
- **libcamera.** UVC webcams (the GF65's) speak V4L2 directly.
  libcamera is the follow-up if a CSI/complex camera ever needs it.
- **Permissions UI.** The Camera app prompts the manifest `camera`
  permission on first use (PR 3); the daemon itself is root-only
  over a root-only socket, same as commsd.

## GF65 test (per PR)

1. Boot the nightly, open a Terminal: `sevyn camera status` →
   `available:true`, `source:v4l2`, device `/dev/video0`.
2. `sevyn camera preview` → PNG path; open it in Files — the
   preview frame is visible.
3. `sevyn camera capture` → JPEG under `/data/photos/`; Photos
   counts it; the file opens as a real photo of the room.
4. Camera app: live preview moves, shutter saves, gallery shows
   the shot (PR 3 steps).
