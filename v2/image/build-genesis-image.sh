#!/bin/sh
# Build the standalone Genesis image: everything in the M13 image,
# except the compositor is Genesis (sevyn-compositor, standalone
# DRM/KMS) instead of Weston — Stage 3 of COMPOSITOR_PLAN.md.
# This is a FORK of build-m13-image.sh (same disk-assembly path,
# same daemons, same apps, same Mesa staging); the deltas are only:
# Genesis fetch + build + staging, no Weston staged or launched,
# and the sevyn.recovery=1 recovery console in init.
#
# Genesis changes over M13:
# - Genesis is fetched at the CURRENT pin (v2/image/genesis-pin.txt,
#   via fetch-genesis.sh — tarball sha256 verified; SEVYN_GENESIS_SRC
#   overrides with a local checkout) and built with
#   `cargo build --release --locked` in the fetched tree
#   (compositor/Cargo.toml; Cargo.lock committed). The built
#   sevyn-compositor binary is staged at /usr/local/bin with its
#   .so closure via copy-closure.py, exactly the pattern the plan
#   prescribes — and the build FAILS LOUDLY if the binary is
#   missing, if any closure library is unresolved, or if a
#   system -dev package the build needs is absent (see the Genesis
#   section below for the list).
# - NO Weston anywhere in this image: no weston binary, no
#   drm-backend/desktop-shell, no weston.ini, no libweston, no
#   gl-renderer. Init launches `sevyn-compositor --standalone
#   --socket wayland-0` as the one and only compositor; a Genesis
#   failure never falls back to Weston — it lands on the recovery
#   console (RECOVERY.md).
# - sevyn.pixman=1 on the kernel cmdline forces the Pixman renderer
#   (Genesis --no-gles; the READY marker then reports
#   renderer=pixman). Init also prints a periodic `GENESIS RSS
#   <kib>` console line (VmRSS of the compositor, every 5 s) for the
#   check's memory step (Stage 3 budget: RSS <= 200 MB).
# - Recovery console (sevyn.recovery=1): the kernel cmdline flag
#   enters the recovery console directly, skipping the compositor
#   entirely. The same console is the landing place when the
#   compositor fails to start (3 attempts, log preserved between
#   them) or exits after starting (crash or clean shutdown — Stage 3
#   milestone 8). The console is busybox sh + the `sevyn` CLI on
#   /dev/console, with /tmp/genesis.log preserved to /data/logs/.
#   Marker on the console: SEVYN RECOVERY READY.
# - The nightly still ships the M13 image. This builder does NOT
#   switch it — that is a separate decision, gated on Stage 3 +
#   Stage 5 proof (COMPOSITOR_PLAN.md, acceptance bar). Its output
#   is sevynos-genesis.img, never sevynos.img, so the two images
#   cannot be confused.
# - genesis-check.mjs (forked from m13-check) proves this image in
#   QEMU: Genesis-live set, adoption geometry, pointer/keyboard
#   routing, move/resize, close killing Chromium, Chromium death,
#   recovery console boot (sevyn.recovery=1) + `sevyn` CLI answers,
#   the m12 regression, and a clean poweroff.
# - Image size budget: GitHub caps release assets at 2 GiB
#   (2,147,483,648 bytes) and the publish guard fails at >= cap — the
#   M13 nightly on main d479fdb7 failed exactly this way after sample
#   media grew the data disk ~32 MiB. This builder stages no sample
#   media and no Weston; the build fails loudly if
#   sevynos-genesis.img reaches the cap, and warns within 47 MiB of
#   it, so growth is visible before the next addition pushes it over.
#
# M12 changes over M11:
# - Genesis: Weston runs its GL renderer (was --renderer=pixman) with
#   a pixman fallback in init if the GL renderer cannot start, and
#   the RN host presents through EGL/GLES2 (genesis-presenter.cc)
#   instead of CPU-rasterizing into SHM buffers. Any EGL failure
#   falls back to the CPU painter, so a GPU failure can never brick
#   the desktop. sevyn.genesis=0 on the kernel cmdline forces the
#   CPU path (the fallback boot the M12 check proves).
# - Mesa staging: the EGL platform plugin (libEGL_mesa.so.0, dlopened
#   by libEGL) is copied explicitly and required; the DRI drivers +
#   libgbm copies from M11 stay (iris on the GF65, virtio_gpu for
#   dumb scanout). The DRI drivers link libgallium-*.so from the lib
#   dir (not dri/), which the copy-closure misses — stage it
#   explicitly or Mesa's loader cannot open any driver. libgallium
#   in turn links libLLVM.so.20.1 (+ libffi/libedit/libzstd/libxml2/
#   libicu*...), also missed — instead of staging one .so per
#   failure, an ldd pass over every staged Mesa lib closes the whole
#   dependency set at build time and fails loudly on anything
#   unresolved. CPU-only: the init forces llvmpipe with
#   LIBGL_ALWAYS_SOFTWARE, so swrast_dri.so is required at build
#   time — the virgl route is dead in CI (egl-headless needs a host
#   DRM render node runners don't have).
# - Host compile: genesis-presenter.cc joins sevyn-rn-host with
#   -DSEVYN_HAVE_EGL=1 (fails loudly without libegl-dev/libgles-dev).
#
# M11 changes over M9:
# - Dual-boot installer: `sevyn install` (probe/plan/install/status)
#   in v2/update/sevyn.c + the Installer system app. Installs into
#   free space or replaces an old SevynOS install, creates its OWN
#   SevynOS ESP (the Windows ESP is too small for kernel +
#   initramfs), writes a GRUB menu with SevynOS + Windows 11
#   (chainloads the Windows Boot Manager), registers the UEFI boot
#   entry with efibootmgr (best-effort; the fallback BOOTX64.EFI
#   still boots). The installer NEVER wipes a disk by default,
#   NEVER touches a Windows partition's bytes (edge-hashed before
#   and after), NEVER installs onto the boot disk, and needs an
#   explicit --yes after the plan is shown.
# - Installer tooling staged in the live image: sgdisk, mkfs.vfat,
#   mkfs.ext4, blkid, efibootmgr, mtools (mcopy/mdir/mmd), debugfs,
#   plus the bootloader files under /usr/share/sevyn/install/
#   (shim, GRUB, MokManager, fbx64, BOOTX64.CSV, GRUB modules,
#   unicode.pf2) — the installer stages them onto the new ESP.
# - Updater (M11): the SevynOS ESP is found by its filesystem label
#   (SEVYNESP) instead of assuming partition 1 (on dual-boot the
#   Windows ESP is p1); the ESP sync preserves a Windows 11 GRUB
#   entry verbatim and pins sevyn.data=PARTUUID=... on the SevynOS
#   entries.
# - Init: honors sevyn.data=<dev|PARTUUID=uuid> from the kernel
#   cmdline (tried first, before /dev/vda and the SEVYN_DATA label
#   lookup) — the installed GRUB entry carries it so init mounts
#   the right data partition when another SevynOS install's
#   SEVYN_DATA label is also present. Also the wifi PATH fix: init's
#   PATH gains /usr/sbin (the GF65 "cannot start wpa_supplicant"
#   bug — the daemon spawns wpa_supplicant by bare name).
#
# M9 changes over M7:
# - Full screen: weston.ini no longer pins Virtual-1 to 1024x768, so
#   Weston uses the output's preferred mode; the RN host sizes the
#   shell to the output mode (wl_output) and honors toplevel
#   configures, and the shell/app roots lay out to Sevyn.width/height.
# - Move + resize: the host starts interactive move/resize drags
#   (xdg_toplevel_move/resize) from the title bar / edge strips and
#   re-lays out JS on the configure's new size (Painter resize,
#   Sevyn.onWindowResize).
# - Wi-Fi: wpasupplicant (wpa_supplicant + wpa_cli) + iw staged;
#   init starts wpa_supplicant when a wlan interface exists, and
#   `sevyn net wifi` (scan/status/connect/disconnect/forget) drives
#   it from Settings. Credentials live only in
#   /data/wifi/wpa_supplicant.conf (0600).
# - Real app content: the template apps get real first screens
#   (working calculator, real calendar, notes in /data/notes, the
#   store listing installed apps).
# - Installer / in-place updates on bare metal: the M8 updater now
#   syncs the ESP after a slot install (sevyn-updated.c: new slot
#   kernel + initramfs to /vmlinuz, old kernel preserved as
#   /vmlinuz.prev, grub.cfg rewritten with a default + a previous
#   entry) and restores the ESP from the good slot when a slot fails
#   to boot twice. No image-build change — the mechanism lives in
#   the daemon — but the check proves it end to end on a UEFI boot.
# - Real-hardware kernel modules (stage-modules.py): i915 (Intel UHD
#   630 drives the GF65's internal panel — Optimus, the panel runs
#   off the iGPU), iwlwifi + iwlmvm (Intel Wireless-AC 9560),
#   nvme (NVMe SSD), alx (QCA8171 wired LAN), snd-hda-intel +
#   codecs (Realtek ALC233), i2c-hid-acpi + i2c-hid +
#   hid-multitouch + intel-lpss-pci (I2C touchpad). The 7 QEMU
#   modules stay (virtio-gpu, virtio-net, virtio-blk, usbhid,
#   hid-generic, xhci-pci, ext4) so the QEMU path keeps working.
# - Firmware (stage-firmware.py): iwlwifi-9000-pu-b0-jf-b0-*.ucode
#   (wifi does NOT work without it — the build fails if it is
#   missing) + i915 GuC/HuC/DMC (optional for modesetting — the
#   build warns, does not fail, if they are absent). All firmware
#   is decompressed at stage time so the guest never depends on
#   the kernel's zstd firmware support.
# - Network: DHCP via busybox udhcpc on the first non-lo interface
#   that gets a lease (ethernet-named first, wifi last). The
#   hardcoded slirp resolv.conf stays as a fallback for the
#   no-DHCP case. In QEMU slirp's DHCP serves the same 10.0.2.15
#   the static config used, so the QEMU path is unchanged.
# - Data disk: mount by LABEL (SEVYN_DATA) via /dev/disk/by-label
#   (udev creates it; the init starts udevd before the mount),
#   trying /dev/vda first for backwards compat with the M6 data
#   disk. The GPT disk image's data partition carries the label.
# - Disk image (make-disk-image.py): a GPT USB-boot image
#   (sevynos.img) — 512 MiB ESP (FAT32, GRUB behind the
#   Microsoft-signed shim so it boots with Secure Boot ON) +
#   1 GiB ext4 data partition (LABEL=SEVYN_DATA, A/B slots +
#   slot-state, same layout as make-data-disk.py). Built rootless
#   (no loop mounts): mkfs.vfat + mtools for the ESP, mkfs.ext4 +
#   debugfs for the data partition, sgdisk for the GPT. `dd` it to
#   a stick and boot the GF65 from USB. It does NOT touch the
#   internal NVMe/Windows install — M7 is "boot", not "install".
#   The A/B updater's ESP sync (copying the active slot's kernel
#   onto the ESP after an update) is a follow-up, not M7: on bare
#   metal the bootloader loads the ESP kernel, so an update that
#   only lands in a slot would never boot. M7 proves the boot path.
#
# Tokrah is TEMPORARILY OUT of the build (Kevon, 2026-11-25 — to cut
# CI time while SevynOS and Tokrah move in parallel; it comes back
# when Hermes + Yoga are fine-tuned and the RN libraries are built).
# v2/tokrah/ stays in the tree, dormant; re-inclusion restores the
# Metro bundle + Hermes compile + pristine staging + mock API staging
# (the "Tokrah (M6)" section below) and the check steps that drive it.
#
# Structure mirrors build-m6-image.sh; the M6 image is untouched.
# Networking: the guest uses QEMU user networking (virtio-net,
# 10.0.2.15, gateway 10.0.2.2, slirp DNS 10.0.2.3 — see
# /etc/resolv.conf staged below) when DHCP finds no lease; with DHCP
# the resolver comes from the offer instead. The old build's
# "wifi connected, browser dead" failure is the named acceptance test:
# the harness proves a real page actually renders, not just that the
# interface is up.
#
# Browser: Chromium — LOCKED (Kevon, 2026-11-07). A from-source build
# is infeasible in CI (hours, tens of GB), so the image ships a
# prebuilt Chromium snapshot (pinned 1738523, Chromium 159.0.8150.0,
# from the Chromium continuous-builds bucket — a real Chromium build,
# not Chrome-branded). It runs as a real Wayland client
# (--ozone-platform=wayland) with CDP on 127.0.0.1:9222; the RN
# Browser app (tabs + address bar) drives it through `sevyn browser`
# over CDP HTTP, and Sevyn Code renders through the same path (the
# IDE finally paints in a window — M4 only proved it serves).
# The snapshot zip is ~260 MB; the staged tree is stripped (the chrome
# binary alone drops 546 MB -> 365 MB) and trimmed to en-US locales,
# so the image grows by ~500 MB uncompressed. Boot with -m 4096.
#
# Chromium download: CHROMIUM_TARBALL overrides the download with a
# local zip (used for local builds so the 260 MB download is not
# repeated).
#
# OS version: SEVYN_V2_VERSION, or the git short sha. Written to
# $OUT/os-version (so the nightly feed step can read it) and staged
# into the image at /usr/share/sevyn/os-version (what the updater
# compares the feed version against).
#
# Requirements (on top of the M6 list): sgdisk, mkfs.vfat, mcopy,
# mkfs.ext4, debugfs (the disk image), zstd (firmware decompression).
# Outputs (SEVYN_V2_BUILD_DIR, default v2/image/build/):
#   vmlinuz, initramfs.cpio.gz, kernel-version.txt, os-version,
#   sevynos-genesis.img, update-signing-key.json (test mode only)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="${SEVYN_V2_SYSROOT:-/}"
OUT="${SEVYN_V2_BUILD_DIR:-$ROOT/image/build}"
DEPS_DIR="${SEVYN_V2_DEPS_DIR:-$ROOT/rn/host/deps}"
PREFIX="$DEPS_DIR/prefix"

if [ "$SYSROOT" != "/" ]; then
  PATH="$SYSROOT/usr/bin:$SYSROOT/bin:$SYSROOT/usr/sbin:$SYSROOT/sbin:$PATH"
  export PATH
fi

if [ -n "${SEVYN_V2_KERNEL:-}" ]; then
  kernel="$SEVYN_V2_KERNEL"
else
  # Pick the newest *-generic kernel explicitly: the workflow installs
  # linux-modules-extra only for the generic kernel, and cloud kernels
  # (azure, aws, ...) omit the desktop drivers stage-modules.py needs
  # (snd-hda-intel). An exclusion list keeps growing — a generic-only
  # match cannot pick a cloud kernel. (The nightly failed 2026-11-24
  # on an AWS kernel the old azure-only exclusion let through.)
  kernel="$(find /boot -maxdepth 1 -type f -name 'vmlinuz-*-generic' -readable 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [ -z "$kernel" ]; then
  echo "error: no readable kernel found in /boot (install linux-image-generic; sudo may be needed to read it)" >&2
  exit 1
fi
kernel_version="$(basename "$kernel" | sed 's/^vmlinuz-//')"

# Rust (Phase 2, relay agent): the relay is the first Rust binary
# built into an image. build-deps.sh installs rustup into the
# RUNNER's home ($HOME/.cargo), but this script runs under sudo,
# where $HOME is /root and cargo is not on PATH — so resolve cargo
# from the invoking user's home and put it on PATH here. A missing
# toolchain fails loudly now, never as a silent relay-less image
# later (the tools loop below then also sees `cargo`).
CARGO_BIN="$(command -v cargo 2>/dev/null || true)"
if [ -z "$CARGO_BIN" ] && [ -n "${SUDO_USER:-}" ]; then
  _sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)"
  [ -z "$_sudo_home" ] && _sudo_home="/home/$SUDO_USER"
  [ -x "$_sudo_home/.cargo/bin/cargo" ] && CARGO_BIN="$_sudo_home/.cargo/bin/cargo"
fi
if [ -z "$CARGO_BIN" ] && [ -x "$HOME/.cargo/bin/cargo" ]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
[ -n "$CARGO_BIN" ] || { echo "error: cargo not found (run v2/rn/host/build-deps.sh as the runner user first — it installs rustup 1.100.0 into the runner's \$HOME/.cargo)" >&2; exit 1; }
PATH="$(dirname "$CARGO_BIN"):$PATH"
export PATH
# Under sudo rustup also loses its toolchain: it looks in
# $HOME/.rustup (i.e. /root/.rustup — no default there), so point it
# at the invoking user's rustup home, where build-deps.sh installed
# 1.100.0. Only when that dir exists — a system cargo install has no
# rustup home and must not be disturbed.
_cargo_home="$(dirname "$(dirname "$CARGO_BIN")")"
_rustup_home="$(dirname "$_cargo_home")/.rustup"
[ -d "$_rustup_home" ] && export RUSTUP_HOME="$_rustup_home"

for tool in busybox cpio curl gcc g++ pkg-config wayland-scanner python3 zstd modinfo cmake node npm openssl unzip strip sgdisk mkfs.vfat mcopy mdir mmd mkfs.ext4 debugfs blkid efibootmgr cargo; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool not found" >&2
    exit 1
  }
done
for f in "$SYSROOT/usr/sbin/wpa_supplicant" "$SYSROOT/usr/sbin/wpa_cli" \
         "$SYSROOT/usr/sbin/iw"; do
  if [ ! -f "$f" ]; then
    echo "error: missing $f (install wpasupplicant, iw)" >&2
    exit 1
  fi
done
# M11: the bootloader files the installer stages onto the new ESP
# (same paths as make-disk-image.py).
for f in "$SYSROOT/usr/lib/shim/shimx64.efi.signed.latest" \
         "$SYSROOT/usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed" \
         "$SYSROOT/usr/lib/shim/mmx64.efi" \
         "$SYSROOT/usr/lib/shim/fbx64.efi" \
         "$SYSROOT/usr/lib/shim/BOOTX64.CSV" \
         "$SYSROOT/usr/share/grub/unicode.pf2"; do
  if [ ! -f "$f" ]; then
    echo "error: missing $f (install shim-signed + grub-efi-amd64-signed)" >&2
    exit 1
  fi
done
[ -d "$SYSROOT/usr/lib/grub/x86_64-efi" ] || {
  echo "error: missing $SYSROOT/usr/lib/grub/x86_64-efi (install grub-efi-amd64)" >&2
  exit 1
}
# Genesis image: NO Weston is staged or launched (Stage 3 — the
# one and only shipping compositor is sevyn-compositor). seatd stays:
# Genesis opens DRM + input devices through the libseat session it
# provides. The wayland-protocols XMLs are the host's build inputs
# (genesis-presenter.cc), not Weston's.
for f in "$SYSROOT/usr/sbin/seatd" \
         "$SYSROOT/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml" \
         "$SYSROOT/usr/share/wayland-protocols/stable/presentation-time/presentation-time.xml"; do
  if [ ! -f "$f" ]; then
    echo "error: missing $f (install seatd, wayland-protocols)" >&2
    exit 1
  fi
done
# wlr-layer-shell is a wlroots extension, not part of upstream
# wayland-protocols: the XML is vendored in the repo.
[ -f "$ROOT/rn/host/wlr-layer-shell-unstable-v1.xml" ] || {
  echo "error: missing $ROOT/rn/host/wlr-layer-shell-unstable-v1.xml (vendored protocol — the checkout is incomplete)" >&2
  exit 1
}

mkdir -p "$OUT"
cp "$kernel" "$OUT/vmlinuz"
chmod 644 "$OUT/vmlinuz"
printf '%s\n' "$kernel_version" >"$OUT/kernel-version.txt"

if [ -n "${SEVYN_V2_VERSION:-}" ]; then
  os_version="$SEVYN_V2_VERSION"
else
  os_version="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
fi
printf '%s\n' "$os_version" >"$OUT/os-version"
echo "OS version: $os_version"

BUILD_TMP="$(mktemp -d)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$BUILD_TMP" "$STAGE"' EXIT INT TERM

# --- native deps (Hermes + Yoga) ------------------------------------------
if [ ! -f "$DEPS_DIR/.sevyn-deps" ]; then
  echo "building native deps (Hermes + Yoga) — first run takes a while"
  sh "$ROOT/rn/host/build-deps.sh"
fi
[ -x "$PREFIX/bin/hermesc" ] || { echo "error: $PREFIX/bin/hermesc missing" >&2; exit 1; }
[ -f "$PREFIX/lib/libyogacore.a" ] || { echo "error: libyogacore.a missing" >&2; exit 1; }

# --- compile the SevynOS programs -----------------------------------------
# (The RN host's Wayland protocols + compile are in v2/rn/host/build-host.sh,
# shared with the quality.yml host-compile gate — see below.)

gcc -O2 -Wall -o "$BUILD_TMP/sevyn-statusd" "$ROOT/services/statusd.c"
gcc -O2 -Wall -o "$BUILD_TMP/sevyn-status-client" "$ROOT/services/status-client.c"

# The loader + app daemon (M3): install/verify/uninstall .sevyn
# bundles, own the registry, seed it from pristine at first boot, and
# spawn one sandboxed host per running app. The loader links OpenSSL
# for Ed25519 signature verification (libssl-dev).
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn-loader" \
  "$ROOT/loader/sevyn-loader.c" "$ROOT/loader/json.c" \
  "$ROOT/loader/verify.c" -lcrypto
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn-appd" \
  "$ROOT/loader/sevyn-appd.c" "$ROOT/loader/json.c"
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/ed25519-sign" \
  "$ROOT/loader/ed25519-sign.c" -lcrypto

# The AI daemon (M4.5): sevyn-aid owns /run/sevyn-ai.sock, spawns
# the selected backend per ASK, checks every proposed action against
# the grant, and executes the allowed ones through appd (apps) and
# statusd (system values). The grant is parsed with the M3 JSON
# parser; a missing or unparseable grant is fatal (fail-closed).
gcc -O2 -Wall -Wextra -I"$ROOT/loader" -o "$BUILD_TMP/sevyn-aid" \
  "$ROOT/ai/sevyn-aid.c" "$ROOT/loader/json.c"

# The muse-ai backend (P0): the local bridge to the Muse API. C, so
# it can do TLS (OpenSSL) + JSON + the agent loop. Links -lssl
# -lcrypto; the copy-closure below stages libssl.so.3 + libcrypto.so.3
# (muse-ai is the first binary to need libssl — libcrypto was already
# staged via sevyn-loader/sevyn-updated). No API key is ever in the
# image: the key lives in /data/ai/muse-key, entered per device.
gcc -O2 -Wall -Wextra -I"$ROOT/loader" -o "$BUILD_TMP/muse-ai" \
  "$ROOT/ai/muse-ai.c" "$ROOT/loader/json.c" -lssl -lcrypto

# The relay agent (Phase 2): the Rust TCP agent that takes tasks
# from the cloud agent and drives them through the daemon's SESSION
# verb. Release + --locked (the workspace lockfile must cover the
# crate's deps — a stale lock fails loudly here). The build runs from
# the workspace dir so rust-toolchain.toml pins 1.100.0 (the script
# runs from the repo root, where no toolchain file applies and rustup
# would fall back to whatever default the runner has). It uses a
# scratch target dir under $BUILD_TMP, not the workspace target/:
# this script runs under sudo, so a shared target dir would come
# back root-owned and break the next runner-user cargo build.
(
  cd "$ROOT/rn/host-rs" || { echo "error: cannot cd to $ROOT/rn/host-rs" >&2; exit 1; }
  CARGO_TARGET_DIR="$BUILD_TMP/cargo-target" \
    cargo build --release --locked -p sevyn-relay \
    || { echo "error: sevyn-relay cargo build failed" >&2; exit 1; }
)
cp "$BUILD_TMP/cargo-target/release/sevyn-relay" "$BUILD_TMP/sevyn-relay"
[ -x "$BUILD_TMP/sevyn-relay" ] || { echo "error: sevyn-relay binary not built" >&2; exit 1; }

# --- Genesis compositor (Stage 3) ---------------------------------------
# Fetch the pinned Genesis tree (fetch-genesis.sh verifies the
# tarball sha256 from v2/image/genesis-pin.txt before extracting;
# SEVYN_GENESIS_SRC overrides with a local checkout, validated the
# same way) and build sevyn-compositor from it — the documented
# build is `cargo build --release --locked` in compositor/
# (compositor/README.md; the plan's "Cargo in the image build + CI"
# section prescribes exactly this, plus staging the binary with its
# .so closure via copy-closure.py). The pin is NOT bumped here.
GENESIS_TREE="$(sh "$ROOT/image/fetch-genesis.sh" tree "$BUILD_TMP/genesis")" \
  || { echo "error: Genesis fetch failed (see fetch-genesis.sh)" >&2; exit 1; }
[ -f "$GENESIS_TREE/compositor/Cargo.toml" ] || { echo "error: fetched Genesis tree has no compositor/Cargo.toml ($GENESIS_TREE)" >&2; exit 1; }
[ -f "$GENESIS_TREE/compositor/Cargo.lock" ] || { echo "error: fetched Genesis tree has no compositor/Cargo.lock ($GENESIS_TREE)" >&2; exit 1; }
GENESIS_PIN="$(grep -v '^[[:space:]]*#' "$ROOT/image/genesis-pin.txt" | grep -v '^[[:space:]]*$' | head -n 1)"
echo "Genesis pin: $GENESIS_PIN"
# System -dev packages the compositor build needs (plan's list +
# libdrm-dev + libpixman-1-dev, from the standalone check's guest
# list): libseat-sys probes pkg-config libseat, drm-sys probes
# libdrm, gbm/input/udev/xkbcommon/wayland link their unversioned
# .so symlinks, pixman-sys links -lpixman-1. The m13 CI apt list
# carries only libwayland-dev + libegl-dev of these, so check every
# one here and fail loudly with the exact apt line — a missing
# -dev package must never surface as a cryptic cargo/rustc error.
# (The workflow owns installing them; this script only verifies.)
GENESIS_DEPS_MISSING=""
for _pc in wayland-server wayland-client wayland-egl xkbcommon libudev libinput gbm libseat libdrm; do
  if ! PKG_CONFIG_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$SYSROOT/usr/lib/pkgconfig:$SYSROOT/usr/share/pkgconfig" pkg-config --exists "$_pc" 2>/dev/null; then
    GENESIS_DEPS_MISSING="$GENESIS_DEPS_MISSING $_pc"
  fi
done
[ -e "$SYSROOT/usr/lib/x86_64-linux-gnu/libpixman-1.so" ] || GENESIS_DEPS_MISSING="$GENESIS_DEPS_MISSING libpixman-1.so"
if [ -n "$GENESIS_DEPS_MISSING" ]; then
  echo "error: Genesis build needs system dev packages not present in $SYSROOT (missing:$GENESIS_DEPS_MISSING)" >&2
  echo "  install: sudo apt-get install -y libwayland-dev libxkbcommon-dev libudev-dev libinput-dev libgbm-dev libseat-dev libdrm-dev libpixman-1-dev" >&2
  exit 1
fi
# Toolchain: the fetched tree's rust-toolchain.toml pins channel
# "stable", but this image's Rust toolchain is 1.100.0
# (build-deps.sh installs ONLY 1.100.0 — no `stable` toolchain is
# present, so an unpinned build would make rustup download one
# mid-build). Pin the build to the same toolchain the relay build
# above used, read from the sevynos pin file; the plan says "the
# image builder ensures the same toolchain", and this is that.
GENESIS_TOOLCHAIN="$(sed -n 's/^channel *= *"\([^"]*\)".*/\1/p' "$ROOT/rn/host-rs/rust-toolchain.toml" 2>/dev/null | head -n 1)"
if [ -n "$GENESIS_TOOLCHAIN" ] && command -v rustup >/dev/null 2>&1; then
  if ! rustup toolchain list 2>/dev/null | grep -q "^$GENESIS_TOOLCHAIN"; then
    echo "error: Rust toolchain $GENESIS_TOOLCHAIN not installed (run v2/rn/host/build-deps.sh as the runner user first — it installs rustup $GENESIS_TOOLCHAIN)" >&2
    exit 1
  fi
  echo "Genesis build toolchain: $GENESIS_TOOLCHAIN (sevynos pin; genesis repo pins stable, not installed)"
elif [ -n "$GENESIS_TOOLCHAIN" ]; then
  echo "warning: rustup not on PATH — cannot pin the Genesis build to $GENESIS_TOOLCHAIN; cargo's own toolchain applies" >&2
else
  echo "warning: $ROOT/rn/host-rs/rust-toolchain.toml not found — Genesis build uses the fetched tree's own toolchain file" >&2
fi
# Scratch target dir under $BUILD_TMP, not the fetched tree's
# target/: this script runs under sudo, so a shared target dir
# would come back root-owned and break the next runner-user cargo
# build (same reason as the relay build above). RUSTUP_TOOLCHAIN is
# exported only inside this subshell, so no later step inherits it.
(
  [ -n "${GENESIS_TOOLCHAIN:-}" ] && command -v rustup >/dev/null 2>&1 && export RUSTUP_TOOLCHAIN="$GENESIS_TOOLCHAIN"
  cd "$GENESIS_TREE/compositor" || { echo "error: cannot cd to $GENESIS_TREE/compositor" >&2; exit 1; }
  CARGO_TARGET_DIR="$BUILD_TMP/cargo-target-genesis" \
    cargo build --release --locked \
    || { echo "error: sevyn-compositor cargo build failed" >&2; exit 1; }
)
cp "$BUILD_TMP/cargo-target-genesis/release/sevyn-compositor" "$BUILD_TMP/sevyn-compositor"
[ -x "$BUILD_TMP/sevyn-compositor" ] || { echo "error: sevyn-compositor binary not built" >&2; exit 1; }
# Fail loudly on an INCOMPLETE closure: the sysroot loader's
# --list reports a missing library as "=> not found" but still
# exits 0, and copy-closure.py silently skips those lines — so
# check explicitly here, before anything is staged. A missing .so
# must fail this build, never ship as a compositor that dies at
# first exec on the device.
_GENESIS_LOADER=""
for _l in "$SYSROOT/lib64/ld-linux-x86-64.so.2" "$SYSROOT/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" /lib64/ld-linux-x86-64.so.2; do
  if [ -x "$_l" ]; then _GENESIS_LOADER="$_l"; break; fi
done
[ -n "$_GENESIS_LOADER" ] || { echo "error: no dynamic loader found for sysroot $SYSROOT" >&2; exit 1; }
_GENESIS_MISSING="$("$_GENESIS_LOADER" --list --library-path "$SYSROOT/lib/x86_64-linux-gnu:$SYSROOT/usr/lib/x86_64-linux-gnu:$SYSROOT/lib:$SYSROOT/usr/lib" "$BUILD_TMP/sevyn-compositor" 2>&1 | grep '=> not found' || true)"
if [ -n "$_GENESIS_MISSING" ]; then
  echo "error: sevyn-compositor has unresolved libraries (incomplete .so closure):" >&2
  echo "$_GENESIS_MISSING" >&2
  exit 1
fi
echo "Genesis compositor built: $(ls -l "$BUILD_TMP/sevyn-compositor" | awk '{print $5}') bytes, closure complete"

# The update daemon + CLI (M8): sevyn-updated owns the A/B slots and
# the feed check/download/apply flow; `sevyn` is the CLI (M4: update
# + shell + files + code verbs, REPL mode). The daemon links OpenSSL
# for Ed25519 feed verification; the CLI links it too (Phase 2:
# Ed25519 relay keypair generation).
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn-updated" \
  "$ROOT/update/sevyn-updated.c" "$ROOT/update/canonical.c" \
  "$ROOT/loader/json.c" "$ROOT/loader/verify.c" -lssl -lcrypto
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn" \
  "$ROOT/update/sevyn.c" -lcrypto

# The camera daemon (camd): native V4L2 capture, no Chromium, no
# ffmpeg. Links libjpeg-turbo (YUYV/MJPEG encode + decode) and
# libpng (preview PNGs for the shell renderer, which decodes PNG
# only). The -dev packages come from the workflow apt installs
# (libjpeg-turbo8-dev, libpng-dev); a missing header fails the
# build loudly here, never silently at runtime. The copy-closure
# below stages camd's library closure (libjpeg.so.8, libpng16)
# into the image with the binary.
gcc -O2 -Wall -Wextra -Werror -o "$BUILD_TMP/sevyn-camd" \
  "$ROOT/camera/camd.c" -ljpeg -lpng -lz
# --- audiod (native audio service) --------------------------------------
# The audio daemon (v2/audio): C + libasound, decodes local audio
# files in-process (vendored minimp3/dr_flac/stb_vorbis + own WAV
# parser) and plays PCM straight to the HDA device — no sound
# server, no Chromium, no media-player subprocess. It owns
# /run/sevyn-audio.sock; `sevyn music` (sevyn.c above) and the host
# media adapter speak its line protocol. Needs libasound2-dev on the
# build host (the CI apt lists carry it); the header check fails
# loudly with an actionable message instead of a bare gcc error.
# Staged below via copy-closure (binary + libasound.so.2 closure,
# ~1 MB) and started by init after commsd.
[ -f "$SYSROOT/usr/include/alsa/asoundlib.h" ] || { echo "error: missing $SYSROOT/usr/include/alsa/asoundlib.h (install libasound2-dev)" >&2; exit 1; }
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn-audiod" \
  "$ROOT/audio/audiod.c" "$ROOT/audio/audio-decode.c" \
  "$ROOT/audio/third_party/stb_vorbis.c" -lasound -lm -lpthread

# Update trust anchor (see the header): committed release anchor, or a
# fresh per-image test keypair.
mkdir -p "$BUILD_TMP/trusted-update-keys"
if [ -f "$ROOT/update/trusted-update-keys.json" ]; then
  python3 -c "import json,sys; d=json.load(open('$ROOT/update/trusted-update-keys.json')); assert isinstance(d.get('keys'), list) and len(d['keys']) > 0" \
    || { echo "error: v2/update/trusted-update-keys.json is not a valid anchor (needs a non-empty keys array)" >&2; exit 1; }
  cp "$ROOT/update/trusted-update-keys.json" "$BUILD_TMP/trusted-update-keys/trusted-update-keys.json"
  echo "update trust anchor: committed release anchor staged"
else
  node "$ROOT/../tools/update-signing/generate-key.mjs" --key-id nightly-test --out "$OUT/update-signing-key.json" \
    >"$BUILD_TMP/trusted-update-keys/trusted-update-keys.json" 2>"$BUILD_TMP/gen-key.log" \
    || { echo "error: failed to generate the test update keypair" >&2; cat "$BUILD_TMP/gen-key.log" >&2; exit 1; }
  echo "update trust anchor: fresh TEST keypair (nightly-test); private key at $OUT/update-signing-key.json"
fi

# The RN host, built by the shared script (v2/rn/host/build-host.sh) —
# the same script the quality.yml host-compile gate runs, so the gate
# and the image can never drift apart (PR #158's `namespace` issue).
sh "$ROOT/rn/host/build-host.sh" "$DEPS_DIR" \
  "$SYSROOT/usr/share/wayland-protocols" \
  "$BUILD_TMP/sevyn-rn-host" "$BUILD_TMP"

# --- build the shell bundle ------------------------------------------------
# npm ci (frozen lockfile) + esbuild bundle + hermesc bytecode. The
# bundle is the only JS in the image; there is no Node at runtime.
SHELL_DIR="$ROOT/shell"
if [ ! -d "$SHELL_DIR/node_modules" ]; then
  (cd "$SHELL_DIR" && npm ci --no-audit --no-fund)
fi
(cd "$SHELL_DIR" && node build-shell.mjs --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/shell-dist")
[ -f "$BUILD_TMP/shell-dist/shell.hbc" ] || { echo "error: shell.hbc not built" >&2; exit 1; }

# --- build the app bundles (M4 + M5) --------------------------------------
# Terminal, Settings, Files are real apps with their own .hbc (M4);
# Browser is a real app with its own .hbc (M5); Camera is a real app
# with its own .hbc (native camd); Music is a real app with its own
# .hbc (native audiod); the other five stock apps share the one
# template .hbc (identity comes from the host at runtime); the crash
# .hbc is the harness's crash fixture.
# make-bundles.py signs terminal with a fresh per-image Ed25519
# keypair and writes the public key into the trusted-keys dir; the
# private key stays in the build temp dir and is never staged.
APPS_DIR="$ROOT/apps"
if [ ! -d "$APPS_DIR/node_modules" ]; then
  (cd "$APPS_DIR" && npm ci --no-audit --no-fund)
fi
(cd "$APPS_DIR" && node build-app.mjs --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry crash --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry terminal --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry settings --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry files --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry browser --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry installer --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry camera --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
(cd "$APPS_DIR" && node build-app.mjs --entry music --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/app-dist")
[ -f "$BUILD_TMP/app-dist/app.hbc" ] || { echo "error: app.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/crash.hbc" ] || { echo "error: crash.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/terminal.hbc" ] || { echo "error: terminal.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/settings.hbc" ] || { echo "error: settings.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/files.hbc" ] || { echo "error: files.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/browser.hbc" ] || { echo "error: browser.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/installer.hbc" ] || { echo "error: installer.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/camera.hbc" ] || { echo "error: camera.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/music.hbc" ] || { echo "error: music.hbc not built" >&2; exit 1; }
python3 "$APPS_DIR/make-bundles.py" \
  --hbc "$BUILD_TMP/app-dist/app.hbc" \
  --crash-hbc "$BUILD_TMP/app-dist/crash.hbc" \
  --terminal-hbc "$BUILD_TMP/app-dist/terminal.hbc" \
  --settings-hbc "$BUILD_TMP/app-dist/settings.hbc" \
  --files-hbc "$BUILD_TMP/app-dist/files.hbc" \
  --browser-hbc "$BUILD_TMP/app-dist/browser.hbc" \
  --installer-hbc "$BUILD_TMP/app-dist/installer.hbc" \
  --camera-hbc "$BUILD_TMP/app-dist/camera.hbc" \
  --music-hbc "$BUILD_TMP/app-dist/music.hbc" \
  --out "$BUILD_TMP/pristine" \
  --trusted-keys-dir "$BUILD_TMP/trusted-keys" \
  --test-bundles-dir "$BUILD_TMP/test-bundles"

# Tokrah staging lived here (Metro bundle + Hermes compile + pristine
# .sevyn packaging + mock API staging). Removed while Tokrah is out of
# the build (Kevon, 2026-11-25); v2/tokrah/ stays in the tree, dormant.
# --- Sevyn Code (code-server) ---------------------------------------------
# code-server 4.105.0, linux-amd64. CI downloads the release tarball;
# CODE_SERVER_TARBALL points at a local copy instead (used for local
# builds so the 120 MB download is not repeated). Extracted into the
# stage at /usr/share/sevyn/code-server/ (452 MB installed).
CODE_SERVER_VERSION="4.105.0"
CODE_SERVER_TARBALL="${CODE_SERVER_TARBALL:-}"
if [ -z "$CODE_SERVER_TARBALL" ]; then
  CODE_SERVER_TARBALL="$BUILD_TMP/code-server.tar.gz"
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 -o "$CODE_SERVER_TARBALL" \
    "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
    || { echo "error: code-server download failed" >&2; exit 1; }
fi
[ -f "$CODE_SERVER_TARBALL" ] || { echo "error: code-server tarball not found: $CODE_SERVER_TARBALL" >&2; exit 1; }
mkdir -p "$BUILD_TMP/code-server"
tar xzf "$CODE_SERVER_TARBALL" -C "$BUILD_TMP/code-server"
CODE_SERVER_DIR="$BUILD_TMP/code-server/code-server-${CODE_SERVER_VERSION}-linux-amd64"
[ -x "$CODE_SERVER_DIR/bin/code-server" ] || { echo "error: code-server tarball has no bin/code-server" >&2; exit 1; }
echo "code-server $CODE_SERVER_VERSION staged ($(du -sh "$CODE_SERVER_DIR" | cut -f1))"

# --- Chromium (M5) ---------------------------------------------------------
# Prebuilt Chromium snapshot (pinned 1738523 = Chromium 159.0.8150.0,
# Linux_x64, from the Chromium continuous-builds bucket). CI downloads
# the 260 MB zip; CHROMIUM_TARBALL points at a local copy instead
# (used for local builds so the download is not repeated).
# Trim before staging: strip the chrome binary (546 MB -> 365 MB),
# keep only en-US locales (123 MB -> ~1 MB), drop the crash handler,
# the setuid sandbox helper and the crashpad preload lib (crash
# reporting is disabled by the launch flags anyway).
CHROMIUM_SNAPSHOT="1738523"
CHROMIUM_VERSION="159.0.8150.0"
CHROMIUM_TARBALL="${CHROMIUM_TARBALL:-}"
if [ -z "$CHROMIUM_TARBALL" ]; then
  CHROMIUM_TARBALL="$BUILD_TMP/chrome-linux.zip"
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 -o "$CHROMIUM_TARBALL" \
    "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${CHROMIUM_SNAPSHOT}/chrome-linux.zip" \
    || { echo "error: Chromium download failed" >&2; exit 1; }
fi
[ -f "$CHROMIUM_TARBALL" ] || { echo "error: Chromium zip not found: $CHROMIUM_TARBALL" >&2; exit 1; }
mkdir -p "$BUILD_TMP/chromium"
unzip -q -o "$CHROMIUM_TARBALL" -d "$BUILD_TMP/chromium"
CHROMIUM_DIR="$BUILD_TMP/chromium/chrome-linux"
[ -x "$CHROMIUM_DIR/chrome" ] || { echo "error: Chromium zip has no chrome binary" >&2; exit 1; }
strip --strip-all "$CHROMIUM_DIR/chrome" 2>/dev/null || true
find "$CHROMIUM_DIR" -name '*.so' -exec strip --strip-all {} + 2>/dev/null || true
find "$CHROMIUM_DIR/locales" -type f ! -name 'en-US.pak' ! -name 'en-US.pak.info' -delete 2>/dev/null || true
# MEIPreload is a stray directory (a Python onefile artifact), not a
# Chromium file — remove it. chrome_crashpad_handler MUST STAY:
# Chromium FATAL-crashes at startup when it cannot spawn the
# handler (posix_spawn .../chrome_crashpad_handler: No such file),
# even with --disable-crash-reporter — proven 2026-11-07 by a
# headless run of the staged closure (exit 2, stack trace in
# crashpad/util/posix/spawn_subprocess.cc). chrome_sandbox stays
# too (53 KB; --no-sandbox means it is unused, but removing it
# risks the same class of surprise).
rm -rf "$CHROMIUM_DIR/MEIPreload"
echo "Chromium $CHROMIUM_VERSION staged ($(du -sh "$CHROMIUM_DIR" | cut -f1))"

# --- Tailscale (AI relay 1a) ----------------------------------------------
# Prebuilt official static release (Kevon, 2026-11-25: prebuilt pinned
# + sha256-verified, Chromium/code-server precedent; build from
# source is a follow-up, NOT now — no Go toolchain is added, and
# apt's Go 1.22 cannot build current Tailscale anyway, it needs
# Go 1.27). The tarball holds the `tailscale` CLI + the `tailscaled`
# daemon + a systemd/ dir the image does not use (no systemd).
# Static Go binaries have no .so closure, so copy-closure.py buys
# nothing — they are staged below by plain `cp`.
# Version + hash verified 2026-11-25: 1.104.7 is the current stable
# (GitHub release v1.104.7, tagged Latest, 12 Nov 2026; Tailscale
# changelog; includes the Tailworm fixes, >= 1.104.4, and Go 1.27.4).
# The amd64 tarball sha256 is LibreELEC.tv's pin for the same file
# (commit 3fdac14283, "tailscale: update to 1.104.7 and addon (15)",
# merged PR #12024: PKG_SHA256 for x86_64/amd64 =
# e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c).
# The per-arch case statement there (amd64/arm/arm64, one hash each)
# is what identifies the hashed artifact as the static tarball
# tailscale_1.104.7_amd64.tgz — a source tarball would have one
# hash, not one per arch. The sandbox could not fetch
# pkgs.tailscale.com directly (403), so the sha256sum check below
# is the final verification: a mismatch fails this build loudly,
# before anything ships. TAILSCALE_TARBALL points at a local copy
# instead (same pattern as Chromium / code-server).
TAILSCALE_VERSION="1.104.7"
TAILSCALE_SHA256="e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c"
TAILSCALE_TARBALL="${TAILSCALE_TARBALL:-}"
if [ -z "$TAILSCALE_TARBALL" ]; then
  TAILSCALE_TARBALL="$BUILD_TMP/tailscale.tar.gz"
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 -o "$TAILSCALE_TARBALL" \
    "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
    || { echo "error: Tailscale download failed" >&2; exit 1; }
fi
[ -f "$TAILSCALE_TARBALL" ] || { echo "error: Tailscale tarball not found: $TAILSCALE_TARBALL" >&2; exit 1; }
echo "$TAILSCALE_SHA256  $TAILSCALE_TARBALL" | sha256sum -c - \
  || { echo "error: Tailscale tarball sha256 mismatch" >&2; exit 1; }
mkdir -p "$BUILD_TMP/tailscale"
tar xzf "$TAILSCALE_TARBALL" -C "$BUILD_TMP/tailscale"
TAILSCALE_DIR="$BUILD_TMP/tailscale/tailscale_${TAILSCALE_VERSION}_amd64"
[ -x "$TAILSCALE_DIR/tailscaled" ] || { echo "error: Tailscale tarball has no tailscaled" >&2; exit 1; }
[ -x "$TAILSCALE_DIR/tailscale" ] || { echo "error: Tailscale tarball has no tailscale CLI" >&2; exit 1; }
# Strip if the release ships debug symbols, then prove the binaries
# still run — a strip that breaks `tailscaled --version` fails the
# build here, not silently on the device.
strip --strip-all "$TAILSCALE_DIR/tailscaled" "$TAILSCALE_DIR/tailscale" 2>/dev/null || true
"$TAILSCALE_DIR/tailscaled" --version >/dev/null 2>&1 \
  || { echo "error: stripped tailscaled does not run --version" >&2; exit 1; }
echo "Tailscale $TAILSCALE_VERSION staged ($(du -sh "$TAILSCALE_DIR" | cut -f1))"

# --- stage the rootfs ------------------------------------------------------
mkdir -p "$STAGE/bin" "$STAGE/proc" "$STAGE/sys" "$STAGE/dev" "$STAGE/run" \
         "$STAGE/tmp" "$STAGE/data" "$STAGE/root/.local/share/code-server/User" \
         "$STAGE/usr/local/bin" \
         "$STAGE/usr/share/sevyn/shell" "$STAGE/usr/share/sevyn/pristine" \
         "$STAGE/usr/share/sevyn/code-server" \
         "$STAGE/usr/share/sevyn/chromium" \
         "$STAGE/usr/share/sevyn/ai/backends" \
         "$STAGE/usr/share/sevyn/test-bundles" \
         "$STAGE/usr/share/sevyn/comms" "$STAGE/usr/share/sevyn/comms-mock" \
         "$STAGE/usr/share/sevyn/trusted-keys" "$STAGE/var/lib/sevyn/apps" \
         "$STAGE/usr/share/sevyn/install"

if [ -x "$SYSROOT/bin/busybox" ]; then
  busybox_bin="$SYSROOT/bin/busybox"
elif [ -x "$SYSROOT/usr/bin/busybox" ]; then
  busybox_bin="$SYSROOT/usr/bin/busybox"
else
  busybox_bin="$(command -v busybox)"
fi
cp "$busybox_bin" "$STAGE/bin/busybox"
ln -s busybox "$STAGE/bin/sh"
ln -s busybox "$STAGE/bin/poweroff"
ln -s busybox "$STAGE/bin/reboot"
ln -s busybox "$STAGE/bin/wget"

# efibootmgr lives in /usr/sbin on some systems and /usr/bin on
# usr-merged Ubuntu 24.04 — resolve it like busybox above.
if [ -x "$SYSROOT/usr/sbin/efibootmgr" ]; then
  efibootmgr_bin="$SYSROOT/usr/sbin/efibootmgr"
elif [ -x "$SYSROOT/usr/bin/efibootmgr" ]; then
  efibootmgr_bin="$SYSROOT/usr/bin/efibootmgr"
else
  efibootmgr_bin="$(command -v efibootmgr)"
fi

# Binaries + their shared-library closure (from the sysroot). The host
# binary is included so its runtime libs (wayland-client, freetype,
# libpng) are staged with it. code-server's bundled node is included
# too, so its runtime libs (libstdc++ et al.) are staged with it.
# Genesis: sevyn-compositor joins the closure (its libseat/libinput/
# libgbm/libdrm/libudev/libxkbcommon/libwayland-server/libpixman
# libs come along); Weston is NOT staged — no weston binary, no
# drm-backend, no desktop-shell, no weston-keyboard.
python3 "$ROOT/image/copy-closure.py" "$SYSROOT" "$STAGE" \
  "$SYSROOT/usr/sbin/seatd:/usr/sbin/seatd" \
  "$SYSROOT/usr/lib/systemd/systemd-udevd:/usr/lib/systemd/systemd-udevd" \
  "$SYSROOT/usr/bin/udevadm:/usr/bin/udevadm" \
  "$SYSROOT/usr/sbin/wpa_supplicant:/usr/sbin/wpa_supplicant" \
  "$SYSROOT/usr/sbin/wpa_cli:/usr/sbin/wpa_cli" \
  "$SYSROOT/usr/sbin/iw:/usr/sbin/iw" \
  "$SYSROOT/usr/sbin/sgdisk:/usr/sbin/sgdisk" \
  "$SYSROOT/usr/sbin/mkfs.vfat:/usr/sbin/mkfs.vfat" \
  "$SYSROOT/usr/sbin/mkfs.ext4:/usr/sbin/mkfs.ext4" \
  "$SYSROOT/usr/sbin/blkid:/usr/sbin/blkid" \
  "$efibootmgr_bin:/usr/sbin/efibootmgr" \
  "$SYSROOT/usr/bin/mcopy:/usr/bin/mcopy" \
  "$SYSROOT/usr/bin/mdir:/usr/bin/mdir" \
  "$SYSROOT/usr/bin/mmd:/usr/bin/mmd" \
  "$SYSROOT/usr/sbin/debugfs:/usr/sbin/debugfs" \
  "$BUILD_TMP/sevyn-compositor:/usr/local/bin/sevyn-compositor" \
  "$BUILD_TMP/sevyn-statusd:/usr/local/bin/sevyn-statusd" \
  "$BUILD_TMP/sevyn-status-client:/usr/local/bin/sevyn-status-client" \
  "$BUILD_TMP/sevyn-loader:/usr/local/bin/sevyn-loader" \
  "$BUILD_TMP/sevyn-appd:/usr/local/bin/sevyn-appd" \
  "$BUILD_TMP/sevyn-aid:/usr/local/bin/sevyn-aid" \
  "$BUILD_TMP/muse-ai:/usr/share/sevyn/ai/backends/muse-ai" \
  "$BUILD_TMP/sevyn-updated:/usr/local/bin/sevyn-updated" \
  "$BUILD_TMP/sevyn:/usr/local/bin/sevyn" \
  "$BUILD_TMP/sevyn-camd:/usr/local/bin/sevyn-camd" \
  "$BUILD_TMP/sevyn-audiod:/usr/local/bin/sevyn-audiod" \
  "$BUILD_TMP/sevyn-relay:/usr/local/bin/sevyn-relay" \
  "$BUILD_TMP/sevyn-rn-host:/usr/local/bin/sevyn-rn-host" \
  "$CODE_SERVER_DIR/lib/node:/usr/share/sevyn/code-server/lib/node" \
  "$CHROMIUM_DIR/chrome:/usr/share/sevyn/chromium/chrome"

# M11: the bootloader files the installer stages onto the new ESP.
# (The .signed names are the signed binaries; the installer expects
# the plain names.)
cp "$SYSROOT/usr/lib/shim/shimx64.efi.signed.latest" "$STAGE/usr/share/sevyn/install/shimx64.efi"
cp "$SYSROOT/usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed" "$STAGE/usr/share/sevyn/install/grubx64.efi"
cp "$SYSROOT/usr/lib/shim/mmx64.efi" "$STAGE/usr/share/sevyn/install/mmx64.efi"
cp "$SYSROOT/usr/lib/shim/fbx64.efi" "$STAGE/usr/share/sevyn/install/fbx64.efi"
cp "$SYSROOT/usr/lib/shim/BOOTX64.CSV" "$STAGE/usr/share/sevyn/install/BOOTX64.CSV"
cp "$SYSROOT/usr/share/grub/unicode.pf2" "$STAGE/usr/share/sevyn/install/unicode.pf2"
cp "$SYSROOT/usr/lib/grub/x86_64-efi/"*.mod "$SYSROOT/usr/lib/grub/x86_64-efi/"*.lst "$STAGE/usr/share/sevyn/install/" 2>/dev/null || true
cp "$SYSROOT/usr/lib/grub/x86_64-efi/moddep.lst" "$STAGE/usr/share/sevyn/install/moddep.lst" 2>/dev/null || true

cp "$BUILD_TMP/shell-dist/shell.hbc" "$STAGE/usr/share/sevyn/shell/shell.hbc"
# App icons (direction C, v2/shell/icons/build_icons.py): the dock,
# the Store, and the title bars reference them by absolute path, so
# they are staged with the shell. All 16 dock icons must exist or
# the build fails — a missing icon would silently fall back to the
# monogram in the dock and hide a broken asset.
for f in files terminal browser settings music photos calendar notes calculator camera messages store video-calls voice-calls installer; do
  if [ ! -f "$ROOT/shell/icons/$f.png" ]; then
    echo "error: missing app icon $ROOT/shell/icons/$f.png (run v2/shell/icons/build_icons.py)" >&2
    exit 1
  fi
done
mkdir -p "$STAGE/usr/share/sevyn/shell/icons/large" \
         "$STAGE/usr/share/sevyn/shell/icons/hero" \
         "$STAGE/usr/share/sevyn/shell/icons/small" \
         "$STAGE/usr/share/sevyn/shell/icons/title" \
         "$STAGE/usr/share/sevyn/shell/icons/symbols"
cp "$ROOT/shell/icons/"*.png "$STAGE/usr/share/sevyn/shell/icons/"
cp "$ROOT/shell/icons/large/"*.png "$STAGE/usr/share/sevyn/shell/icons/large/"
cp "$ROOT/shell/icons/hero/"*.png "$STAGE/usr/share/sevyn/shell/icons/hero/"
cp "$ROOT/shell/icons/small/"*.png "$STAGE/usr/share/sevyn/shell/icons/small/"
cp "$ROOT/shell/icons/title/"*.png "$STAGE/usr/share/sevyn/shell/icons/title/"
cp "$ROOT/shell/icons/symbols/"*.png "$STAGE/usr/share/sevyn/shell/icons/symbols/"
# --- commsd (M10) ---------------------------------------------------------
# The Matrix daemon + its node_modules (npm ci --omit=dev; the SDK
# has no runtime dev deps), the Chromium media-bridge page, and the
# mock homeserver + mock ACS/IMS (dependency-free, no install).
# Node >= 22 is required (matrix-js-sdk 45 engines). Prefer
# code-server's bundled node when it is >= 22 — it is already staged
# by the copy-closure above, so comms/node becomes a symlink to it.
# Otherwise download a pinned standalone Node 24.22.2 tarball
# (sha256-verified) and stage that binary as comms/node instead.
# Either way init runs ONE fixed path: /usr/share/sevyn/comms/node.
# The build FAILS LOUDLY if neither node is >= 22.
COMMS_DIR="$ROOT/comms"
if [ ! -d "$COMMS_DIR/node_modules" ]; then
  (cd "$COMMS_DIR" && npm ci --omit=dev --no-audit --no-fund) \
    || { echo "error: commsd npm ci failed" >&2; exit 1; }
fi
mkdir -p "$BUILD_TMP/comms" "$BUILD_TMP/comms-mock"
cp "$COMMS_DIR/commsd.mjs" "$COMMS_DIR/bridge.mjs" "$COMMS_DIR/bridge.html" \
   "$COMMS_DIR/rcs.mjs" "$BUILD_TMP/comms/"
cp -r "$COMMS_DIR/node_modules" "$BUILD_TMP/comms/node_modules"
cp "$COMMS_DIR/harness/mock-matrix.js" "$COMMS_DIR/harness/mock-acs.js" \
   "$BUILD_TMP/comms-mock/"
COMMS_NODE_SRC=""
CS_NODE_VERSION="$("$CODE_SERVER_DIR/lib/node" --version 2>/dev/null | sed 's/^v//')"
CS_NODE_MAJOR="$(echo "$CS_NODE_VERSION" | cut -d. -f1)"
if [ -n "$CS_NODE_MAJOR" ] && [ "$CS_NODE_MAJOR" -ge 22 ] 2>/dev/null; then
  echo "commsd node: code-server bundled node $CS_NODE_VERSION (>= 22)"
else
  NODE_VERSION="24.22.2"
  NODE_SHA256="48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75"
  NODE_TARBALL="${NODE_TARBALL:-}"
  if [ -z "$NODE_TARBALL" ]; then
    NODE_TARBALL="$BUILD_TMP/node.tar.xz"
    curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 -o "$NODE_TARBALL" \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      || { echo "error: Node $NODE_VERSION download failed" >&2; exit 1; }
  fi
  echo "$NODE_SHA256  $NODE_TARBALL" | sha256sum -c - \
    || { echo "error: Node tarball sha256 mismatch" >&2; exit 1; }
  mkdir -p "$BUILD_TMP/node24"
  tar xf "$NODE_TARBALL" -C "$BUILD_TMP/node24"
  COMMS_NODE_SRC="$BUILD_TMP/node24/node-v${NODE_VERSION}-linux-x64/bin/node"
  [ -x "$COMMS_NODE_SRC" ] || { echo "error: Node tarball has no bin/node" >&2; exit 1; }
  NODE24_VERSION="$("$COMMS_NODE_SRC" --version)"
  echo "commsd node: standalone Node $NODE24_VERSION (code-server node was ${CS_NODE_VERSION:-missing}, < 22)"
fi

# commsd (M10): daemon + bridge + RCS skeleton + its node_modules, and
# the mock homeserver + mock ACS (started by init only with
# sevyn.mockcomms=1). The node binary: a symlink to code-server's
# node when it is >= 22, else the pinned standalone Node 24 binary
# (with its library closure).
cp "$BUILD_TMP/comms/commsd.mjs" "$BUILD_TMP/comms/bridge.mjs" \
   "$BUILD_TMP/comms/bridge.html" "$BUILD_TMP/comms/rcs.mjs" \
   "$STAGE/usr/share/sevyn/comms/"
cp -r "$BUILD_TMP/comms/node_modules" "$STAGE/usr/share/sevyn/comms/node_modules"
cp "$BUILD_TMP/comms-mock/mock-matrix.js" "$BUILD_TMP/comms-mock/mock-acs.js" \
   "$STAGE/usr/share/sevyn/comms-mock/"
if [ -n "$COMMS_NODE_SRC" ]; then
  python3 "$ROOT/image/copy-closure.py" "$SYSROOT" "$STAGE" \
    "$COMMS_NODE_SRC:/usr/share/sevyn/comms/node" \
    || { echo "error: commsd node closure failed" >&2; exit 1; }
else
  ln -s ../code-server/lib/node "$STAGE/usr/share/sevyn/comms/node"
fi
cp "$BUILD_TMP/pristine/"*.sevyn "$STAGE/usr/share/sevyn/pristine/"
cp "$BUILD_TMP/test-bundles/"*.sevyn "$STAGE/usr/share/sevyn/test-bundles/"
cp "$BUILD_TMP/trusted-keys/"*.pub "$STAGE/usr/share/sevyn/trusted-keys/"
cp "$BUILD_TMP/trusted-update-keys/trusted-update-keys.json" "$STAGE/usr/share/sevyn/trusted-update-keys.json"
cp "$OUT/os-version" "$STAGE/usr/share/sevyn/os-version"

# The AI connector (M4.5): the grant + the stub backends. The
# backends are plain executables; their ids are their filenames.
# (cp -a keeps the +x bit the daemon's scan requires.)
cp -a "$ROOT/ai/backends/"* "$STAGE/usr/share/sevyn/ai/backends/"

# Tailscale (AI relay 1a): the daemon + the CLI, by plain `cp` —
# static Go binaries, no .so closure for copy-closure.py to
# resolve. /usr/local/bin is on init's PATH, so `sevyn tailscale
# status` finds the CLI by bare name. (The tarball's systemd/ dir
# is not staged: the image has no systemd.)
cp "$TAILSCALE_DIR/tailscaled" "$STAGE/usr/local/bin/tailscaled"
cp "$TAILSCALE_DIR/tailscale" "$STAGE/usr/local/bin/tailscale"
cp "$ROOT/ai/grant.json" "$STAGE/usr/share/sevyn/ai/grant.json"
cp "$ROOT/ai/grant-god.json" "$STAGE/usr/share/sevyn/ai/grant-god.json"

# Sevyn Code: the extracted code-server tree, plus the terminal
# default (the integrated terminal spawns `sevyn` with no args, so
# the REPL mode is what it gets). The settings file is the config the
# M4 harness reads back through `sevyn files cat`.
cp -a "$CODE_SERVER_DIR/." "$STAGE/usr/share/sevyn/code-server/"
# Source maps are devtools-only (517 files, ~36 MB gzipped in the
# initramfs, ~72 MB on the disk image) and code-server never reads
# them at runtime. Dropping them is what keeps the M12 image under
# GitHub's 2 GiB release-asset cap — the initramfs grew 366.5 -> 437.2
# MiB with Genesis and the raw image hit 2,190,475,264 bytes.
MAP_COUNT=$(find "$STAGE/usr/share/sevyn/code-server" -name '*.map' -type f | wc -l)
find "$STAGE/usr/share/sevyn/code-server" -name '*.map' -type f -delete
echo "code-server: dropped $MAP_COUNT *.map files (devtools-only)"
cat >"$STAGE/root/.local/share/code-server/User/settings.json" <<'EOF'
{
  "terminal.integrated.defaultProfile.linux": "sevyn",
  "terminal.integrated.profiles.linux": {
    "sevyn": { "path": "/usr/local/bin/sevyn" }
  }
}
EOF

# The browser (M5): the trimmed Chromium tree. The chrome binary
# itself came in through the copy-closure above (with its system
# libs); this copies the support files — pak files, icudtl.dat, the
# $ORIGIN libs (libEGL, libGLESv2, libvk_swiftshader — dlopened, so
# ldd never sees them), resources, en-US locale. cp -r, not cp -a:
# the sandbox cannot chown the extracted tree's directories, and
# ownership is irrelevant inside the initramfs.
cp -r "$CHROMIUM_DIR/." "$STAGE/usr/share/sevyn/chromium/"

# TLS + fonts for Chromium. The CA bundle (libnss3 verifies against
# /etc/ssl/certs) and the fontconfig tree (so Chromium finds DejaVu)
# come from the sysroot; libnssckbi.so is the NSS built-in-roots
# module, dlopened by libnss3, so ldd never sees it either.
# libsoftokn3.so is the NSS softoken (the crypto token behind the
# sql: NSS database) — also dlopened by libnss3, also invisible to
# ldd. Without it, NSS init fails with -5925 and Chromium FATAL-aborts
# (SIGABRT) the first time it does any TLS — which is why the CI guest
# (which has internet, so Chromium does background HTTPS fetches)
# crashed while the sandbox guest (no internet, no TLS) never did.
# libsqlite3.so.0 is softokn's SQL backend; libplc4/libplds4/libnspr4
# are already in the closure via chrome's own deps.
# libfreebl3.so / libfreeblpriv3.so are the NSS crypto primitives,
# dlopened by softokn — without them NSS init fails with -8023 even
# though softokn itself loads. libnssdbm3.so is the legacy DBM backend
# (same dlopen class). All three are invisible to ldd.
[ -f "$SYSROOT/etc/ssl/certs/ca-certificates.crt" ] || { echo "error: sysroot has no CA bundle (install ca-certificates)" >&2; exit 1; }
# The NSS copies below are the first write to
# $STAGE/usr/lib/x86_64-linux-gnu: the M13 builder gets that directory
# for free from its Weston closure pairs, but this builder stages no
# Weston, so create it explicitly or the first cp dies with
# "No such file or directory".
mkdir -p "$STAGE/etc/ssl" "$STAGE/etc/fonts" "$STAGE/usr/lib/x86_64-linux-gnu"
cp -r "$SYSROOT/etc/ssl/certs" "$STAGE/etc/ssl/certs"
cp -r "$SYSROOT/etc/fonts/." "$STAGE/etc/fonts/"
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libnssckbi.so" ] && cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libnssckbi.so" "$STAGE/usr/lib/x86_64-linux-gnu/libnssckbi.so"
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libsoftokn3.so" ] && cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libsoftokn3.so" "$STAGE/usr/lib/x86_64-linux-gnu/libsoftokn3.so"
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libsqlite3.so.0" ] && cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libsqlite3.so.0" "$STAGE/usr/lib/x86_64-linux-gnu/libsqlite3.so.0"
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libfreebl3.so" ] && cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libfreebl3.so" "$STAGE/usr/lib/x86_64-linux-gnu/libfreebl3.so"
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libfreeblpriv3.so" ] && cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libfreeblpriv3.so" "$STAGE/usr/lib/x86_64-linux-gnu/libfreeblpriv3.so"
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libnssdbm3.so" ] && cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libnssdbm3.so" "$STAGE/usr/lib/x86_64-linux-gnu/libnssdbm3.so"

# DHCP script for busybox udhcpc (M7): on `bound` (and `renew`)
# configure the address + route + resolv.conf from the offer.
# busybox udhcpc passes $interface, $ip, $subnet, $router, $dns
# (space-separated) as environment variables.
cat >"$STAGE/etc/udhcpc.script" <<'UDHCPC_EOF'
#!/bin/busybox sh
case "$1" in
  bound|renew)
    /bin/busybox ifconfig "$interface" "$ip" netmask "$subnet" up
    for r in $router; do /bin/busybox route add default gw "$r" 2>/dev/null; done
    : > /etc/resolv.conf
    for d in $dns; do printf 'nameserver %s\n' "$d" >> /etc/resolv.conf; done
    # Fallback public resolvers (GF65, 2026-11-24: the ISP DNS
    # stopped answering mid-session and every lookup died — the
    # updater's download failed with it. The DHCP servers stay
    # first and are always consulted first; these are only reached
    # after they time out. glibc consults at most three
    # nameservers, so only fill up to three total.)
    n=$(grep -c '^nameserver ' /etc/resolv.conf 2>/dev/null || true)
    n=${n:-0}
    for fb in 1.1.1.1 8.8.8.8; do
      if [ "$n" -lt 3 ] && ! grep -qx "nameserver $fb" /etc/resolv.conf 2>/dev/null; then
        printf 'nameserver %s\n' "$fb" >> /etc/resolv.conf
        n=$((n + 1))
      fi
    done
    ;;
  deconfig)
    /bin/busybox ifconfig "$interface" 0.0.0.0
    ;;
esac
UDHCPC_EOF
chmod +x "$STAGE/etc/udhcpc.script"
# localhost resolves via /etc/hosts (files first in nsswitch), never
# over the network — without this, `sevyn net dns localhost` (and any
# loopback client) asks the slirp DNS, which is slow to answer and
# unreachable where the guest has no internet.
printf '127.0.0.1 localhost\n::1 localhost\n' >"$STAGE/etc/hosts"
# Resolver for the no-DHCP case: slirp DNS first (QEMU), then the
# same public fallbacks the udhcpc script appends. The m7–m12
# scripts claimed a staged resolv.conf but never wrote one — a
# guest that got no lease had no resolver at all (glibc falls back
# to 127.0.0.1 and every lookup fails). Overwritten by the udhcpc
# script whenever a lease arrives.
printf 'nameserver 10.0.2.3\nnameserver 1.1.1.1\nnameserver 8.8.8.8\n' >"$STAGE/etc/resolv.conf"

# Data Genesis and its stack load with dlopen / by path (not via ldd):
# the DRI drivers + libgbm (the GLES renderer's GBM/EGL path), the
# udev rules (device nodes + permissions for DRM/input), the libinput
# quirks, the xkb keymaps, and the fonts. No Weston data dirs: the
# weston lib dir and usr/share/weston belong to the removed
# compositor.
for d in \
  "usr/lib/x86_64-linux-gnu/gbm" \
  "usr/lib/x86_64-linux-gnu/dri" \
  "usr/lib/udev/rules.d" \
  "usr/share/libinput" \
  "usr/share/X11/xkb" \
  "usr/share/fonts/truetype/dejavu" ; do
  if [ -d "$SYSROOT/$d" ]; then
    mkdir -p "$STAGE/$(dirname "$d")"
    cp -a "$SYSROOT/$d" "$STAGE/$d"
  else
    echo "warning: $SYSROOT/$d not found, skipping" >&2
  fi
done
# M12 Genesis: the Mesa EGL platform plugin (libEGL_mesa.so.0) is
# dlopened by libEGL, so ldd never sees it and the copy-closure
# misses it — copy it explicitly and fail loudly without it. The
# DRI drivers (dri/, copied above) are equally required: without a
# DRI driver the GL renderer cannot start at all. libEGL.so.1 /
# libGLESv2.so.2 / libwayland-egl.so.1 arrive through the host's
# copy-closure (the host binary links them when SEVYN_HAVE_EGL).
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0" ] || { echo "error: missing libEGL_mesa.so.0 (install libgl1-mesa-dri)" >&2; exit 1; }
cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0" "$STAGE/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0"
# M12 root cause #7 (PROVEN 2026-11-14 from the 58f8538d boot log's
# LD_DEBUG trace): libEGL.so.1 is libglvnd's dispatch library — it
# finds vendor EGL implementations ONLY through
# /usr/share/glvnd/egl_vendor.d/*.json. The image staged the Mesa
# plugin (libEGL_mesa.so.0, above) but never the vendor JSON, so
# glvnd found zero vendors and eglGetDisplay returned EGL_NO_DISPLAY
# without ever loading Mesa — which is why the kms_swrast override,
# EGL_PLATFORM=gbm, and the EGL/Mesa debug knobs changed NOTHING
# across eight heads, and why LD_DEBUG shows libEGL loading but no
# libEGL_mesa dlopen at all. Stage the vendor dir and fail loudly
# without the Mesa entry.
[ -f "$SYSROOT/usr/share/glvnd/egl_vendor.d/50_mesa.json" ] || { echo "error: missing glvnd EGL vendor config 50_mesa.json (install libegl-mesa0)" >&2; exit 1; }
mkdir -p "$STAGE/usr/share/glvnd"
cp -a "$SYSROOT/usr/share/glvnd/egl_vendor.d" "$STAGE/usr/share/glvnd/"
# The DRI drivers link libgallium-*.so, which lives in the lib dir
# (not dri/) and is likewise invisible to ldd on the host binary —
# the copy-closure misses it, and without it Mesa's loader cannot
# open ANY driver ("failed to open dri: libgallium-*.so: cannot
# open shared object file"), so EGL never inits and Weston falls
# back to pixman. Proven by the 624b0318 guest boot log. Stage it
# (versioned name — glob) and fail loudly without it.
GALLIUM_LIB="$(ls "$SYSROOT"/usr/lib/x86_64-linux-gnu/libgallium-*.so 2>/dev/null | head -n 1)"
[ -n "$GALLIUM_LIB" ] || { echo "error: no libgallium staged (install libgl1-mesa-dri)" >&2; exit 1; }
cp "$GALLIUM_LIB" "$STAGE/usr/lib/x86_64-linux-gnu/$(basename "$GALLIUM_LIB")"
# libgallium links libLLVM.so.20.1, which the copy-closure misses the
# same way — proven by the e0cc1537 guest boot log ("failed to open
# dri: libLLVM.so.20.1: cannot open shared object file"). Staging one
# .so per failure never ends (libLLVM alone pulls libffi, libedit,
# libzstd, libxml2, libicu*, ...), so close the whole Mesa dependency
# set at build time instead: run ldd over every staged Mesa lib and
# copy each resolved dependency out of the sysroot (ldd reports the
# full transitive closure), then fail loudly if anything is still
# unresolved. The staged libs all live in the lib dir the loader
# already searches, so the soname basename is the right target.
MESA_MISSING=""
for _mesa_lib in "$STAGE/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0" \
    "$STAGE/usr/lib/x86_64-linux-gnu"/libgallium-*.so \
    "$STAGE/usr/lib/x86_64-linux-gnu/dri"/*.so; do
  [ -f "$_mesa_lib" ] || continue
  for _dep in $(ldd "$_mesa_lib" 2>/dev/null | awk '/=> not found/ {print "MISSING:"$1} /=> \// {print $3}'); do
    case "$_dep" in
      MISSING:*) MESA_MISSING="$MESA_MISSING ${_dep#MISSING:}" ;;
      *) _target="$STAGE/usr/lib/x86_64-linux-gnu/$(basename "$_dep")"
         [ -f "$_target" ] || cp "$_dep" "$_target" || { echo "error: cannot stage Mesa dep $_dep" >&2; exit 1; } ;;
    esac
  done
done
[ -z "$MESA_MISSING" ] || { echo "error: Mesa deps not found in sysroot:$MESA_MISSING" >&2; exit 1; }
[ -d "$STAGE/usr/lib/x86_64-linux-gnu/dri" ] && [ -n "$(ls -A "$STAGE/usr/lib/x86_64-linux-gnu/dri" 2>/dev/null)" ] || { echo "error: no DRI drivers staged (install libgl1-mesa-dri)" >&2; exit 1; }
# CPU-only software GL: the init forces llvmpipe with
# LIBGL_ALWAYS_SOFTWARE, so swrast_dri.so must be staged — without it
# no GL renderer can start in this image at all.
[ -f "$STAGE/usr/lib/x86_64-linux-gnu/dri/swrast_dri.so" ] || { echo "error: no swrast DRI driver staged (CPU-only software GL needs llvmpipe; install libgl1-mesa-dri)" >&2; exit 1; }
[ -d "$STAGE/usr/lib/x86_64-linux-gnu/gbm" ] || { echo "error: no libgbm staged (install libgbm1)" >&2; exit 1; }
# Genesis image: no libweston-* dir copy, no gl-renderer.so — those
# are Weston's loadable modules. Genesis renders with its own GLES
# renderer (Smithay) or the Pixman fallback, both linked into the
# sevyn-compositor binary; its only loadable graphics deps are the
# Mesa DRI drivers + libgbm, staged above. No Adwaita cursor theme
# either: Genesis draws its own built-in default arrow (no cursor
# theme system — compositor/README.md, "Cursor").

# M7: the 7 QEMU modules stay, plus the real-hardware drivers for
# the GF65 Thin 9SD (stage-modules.py resolves each module's dep
# closure via modinfo, so snd-hda-intel pulls snd-hda-core/snd-pcm/
# snd, i915 pulls drm/drm_kms_helper/i2c-algo-bit, iwlwifi pulls
# cfg80211, iwlmvm pulls mac80211, nvme pulls nvme-core).
# M9: nls_iso8859-1 + nls_utf8 — vfat is built into the kernel
# (CONFIG_VFAT_FS=y) so there is no vfat.ko to stage, but the FAT
# driver needs the NLS charset modules at mount time (its default
# iocharset is iso8859-1); without them the ESP mount fails with
# EINVAL ("FAT-fs: IO charset iso8859-1 not found") and the
# in-place update cannot sync the ESP.
# Camera (camd): uvcvideo + videodev + videobuf2-* — the UVC webcam
# stack for the GF65's camera. Without them there is no /dev/video0
# at all and camd can only report available:false. QEMU has no
# camera either way; the modules are harmless there (nothing probes
# them) and the dep closure resolves via modinfo.
# NOTE: no videobuf2-core — Linux 6.8 folded it into videobuf2-v4l2
# (CONFIG_VIDEOBUF2_CORE=m builds no .ko; nothing depends on it —
# verified via modinfo on the 6.8.0-151-generic tree), so requesting
# it makes the build fail with "module videobuf2-core not found".
# Installer v2: usb-storage + uas + sd_mod — the USB storage stack.
# Without them the live system cannot see a USB disk at all (no
# /dev/sd*, no /sys/block/sda): the portable install target is
# unprovable in QEMU and unusable on real hardware. xhci-hcd is
# built into the kernel; xhci-pci was already staged. The dep
# closure (scsi_mod) resolves via modinfo.
# AI relay 1a: wireguard — the in-kernel WireGuard module the
# Tailscale mesh runs on. It lives in the BASE linux-modules
# package (not -extra), CONFIG_WIREGUARD=m, so no new apt install
# is needed to obtain it; the dep closure (libcurve25519-generic,
# udp_tunnel, ip6_udp_tunnel, libchacha20poly1305,
# curve25519-x86_64) resolves via modinfo. The build fails loudly
# if the module is absent — that is the verification.
python3 "$ROOT/image/stage-modules.py" "$SYSROOT" "$kernel_version" "$STAGE" \
  virtio-gpu usbhid hid-generic xhci-pci virtio-blk virtio-net ext4 \
  i915 iwlwifi iwlmvm mac80211 cfg80211 nvme alx \
  snd-hda-intel snd-hda-codec-realtek snd-hda-codec-generic snd-hda-codec-hdmi \
  uvcvideo videodev videobuf2-common videobuf2-memops videobuf2-v4l2 \
  i2c-hid-acpi i2c-hid hid-multitouch intel-lpss-pci \
  nls_iso8859-1 nls_utf8 \
  usb-storage uas sd_mod \
  wireguard

# M7: firmware for the real hardware (stage-firmware.py decompresses
# the sysroot's .zst firmware into the stage). iwlwifi firmware is
# REQUIRED (wifi does not work without its .ucode — the build fails
# if it is missing); i915 GuC/HuC/DMC is optional for modesetting
# (warn, don't fail).
python3 "$ROOT/image/stage-firmware.py" "$SYSROOT" "$STAGE" \
  || { echo "error: firmware staging failed" >&2; exit 1; }

mkdir -p "$STAGE/etc/ld.so.conf.d"
cp -a "$SYSROOT/etc/ld.so.conf" "$STAGE/etc/" 2>/dev/null || true
cp -a "$SYSROOT/etc/ld.so.conf.d/"*.conf "$STAGE/etc/ld.so.conf.d/" 2>/dev/null || true
# Dedupe the stage libraries once ALL staging is done: the explicit
# Mesa steps above copy libraries to /usr/lib/... that the
# closure already staged under /lib/... (libicudata.so.74 alone is
# ~29 MB raw), plus nested copies from the explicit staging steps.
# The copy-closure runs dedupe too, but only over what they staged.
python3 "$ROOT/image/copy-closure.py" --dedupe-only "$STAGE"
ldconfig -r "$STAGE" 2>/dev/null || echo "warning: ldconfig -r failed (continuing)" >&2

# --- Genesis stage verification (fail loudly, before assembly) -------
# The build must never produce an image that only fails on the
# device. Each check is a hard failure with a clear message:
#  1. the compositor binary is staged and executable;
#  2. NO Weston binary is staged (this image ships Genesis only);
#  3. the staged compositor's .so closure resolves INSIDE the stage
#     (the staged loader + the stage lib dirs — the copy-closure
#     silently skips "not found" libs, so re-prove it here after the
#     dedupe pass above, which rewrites lib paths into symlinks).
# Check 4 (the recovery entry exists in the staged init) runs after
# the init is written below, right before the cpio step.
[ -x "$STAGE/usr/local/bin/sevyn-compositor" ] || { echo "error: sevyn-compositor not staged at /usr/local/bin/sevyn-compositor" >&2; exit 1; }
[ ! -e "$STAGE/usr/bin/weston" ] || { echo "error: Weston binary staged in the Genesis image ($STAGE/usr/bin/weston) — this image ships Genesis only" >&2; exit 1; }
_GENESIS_STAGED_LIST="$("$STAGE/lib64/ld-linux-x86-64.so.2" --list --library-path "$STAGE/usr/lib/x86_64-linux-gnu:$STAGE/lib/x86_64-linux-gnu" "$STAGE/usr/local/bin/sevyn-compositor" 2>&1)"
_GENESIS_STAGED_MISSING="$(printf '%s\n' "$_GENESIS_STAGED_LIST" | grep '=> not found' || true)"
if [ -n "$_GENESIS_STAGED_MISSING" ]; then
  echo "error: staged sevyn-compositor has unresolved libraries inside the stage (incomplete closure):" >&2
  echo "$_GENESIS_STAGED_MISSING" >&2
  exit 1
fi
# Strict: every resolved library must live INSIDE the stage. The
# loader also consults the host's ld.so.cache / default dirs, so a
# library the closure missed could still resolve — to a host path
# that does not exist on the device. Any such line fails the build.
_GENESIS_STAGED_OUTSIDE="$(printf '%s\n' "$_GENESIS_STAGED_LIST" | grep '=>' | grep -v "=> $STAGE/" || true)"
if [ -n "$_GENESIS_STAGED_OUTSIDE" ]; then
  echo "error: staged sevyn-compositor resolves libraries outside the stage (closure incomplete):" >&2
  echo "$_GENESIS_STAGED_OUTSIDE" >&2
  exit 1
fi
echo "Genesis stage verified: sevyn-compositor staged, closure resolves in-stage, no Weston"

cat >"$STAGE/init" <<'EOF'
#!/bin/busybox sh
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox mount -t tmpfs tmpfs /run
# M11: efivarfs, so the installer's efibootmgr can register the
# SevynOS boot entry (inst_register_boot_entry needs
# /sys/firmware/efi/efivars). Without it the entry is never created
# and only the BOOTX64.EFI fallback boots the new ESP. Best-effort:
# a non-UEFI boot has no efivars directory at all.
if [ -d /sys/firmware/efi/efivars ]; then
  /bin/busybox mount -t efivarfs efivarfs /sys/firmware/efi/efivars 2>/dev/null || echo "M11 init: efivarfs mount failed"
fi
mkdir -p /run /tmp
# Chromium uses /dev/shm for shared memory (even with
# --disable-dev-shm-usage the renderer maps small shm files).
mkdir -p /dev/shm
/bin/busybox mount -t tmpfs -o size=256M tmpfs /dev/shm 2>/dev/null || echo "M5 init: /dev/shm mount failed"
echo "SevynOS v2 - Genesis image (sevyn-compositor standalone + RN shell + app runtime + system updates + system apps + Sevyn Code + AI connector + connectivity + Chromium browser + bare-metal boot + desktop polish + dual-boot installer + browser embed; no Weston)"
# M11: /usr/sbin (the wifi PATH fix — the daemon spawns
# wpa_supplicant/wpa_cli by bare name, and they live in /usr/sbin).
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin
export XDG_RUNTIME_DIR=/run
export WAYLAND_DISPLAY=wayland-0
# --- Genesis recovery console (RECOVERY.md) ------------------------------
# A usable console with the `sevyn` CLI: busybox sh + sevyn on PATH.
# Reached three ways: directly (sevyn.recovery=1 on the kernel
# cmdline, skipping the compositor entirely), when the compositor
# fails to start, and when it exits after starting. The compositor
# never restarts itself and never falls back to another compositor —
# a failure lands here, never on a hung black screen. /tmp/genesis.log
# is preserved to /data/logs/ first, so the crash record survives
# (the next compositor start truncates it).
# The VT init started on, recorded before the compositor takes the
# display: after a crash mid-modeset the VT may still sit on the
# compositor's output, and the console needs it back. Best-effort —
# on a serial console (QEMU) there is no VT to switch and chvt is a
# harmless no-op.
CONSOLE_VT="$(cat /sys/class/tty/tty0/active 2>/dev/null || true)"
preserve_genesis_log() {
  # $1 = tag for the filename. Best-effort: /data may not be mounted.
  _tag="${1:-recovery}"
  if [ -f /tmp/genesis.log ]; then
    mkdir -p /data/logs 2>/dev/null
    if [ -d /data/logs ]; then
      cp /tmp/genesis.log "/data/logs/genesis-${_tag}.log" 2>/dev/null && echo "GENESIS log preserved to /data/logs/genesis-${_tag}.log"
    else
      cp /tmp/genesis.log "/tmp/genesis-${_tag}.log" 2>/dev/null && echo "GENESIS log preserved to /tmp/genesis-${_tag}.log (no /data)"
    fi
  fi
}
recovery_console() {
  # $1 = reason string for the console banner. Never returns: the
  # shell is re-spawned if the operator exits it, because PID 1
  # exiting is a kernel panic — init stays alive as the supervisor.
  echo "SEVYN RECOVERY: ${1:-recovery console}"
  preserve_genesis_log recovery
  if [ -n "${CONSOLE_VT:-}" ]; then
    /bin/busybox chvt "$CONSOLE_VT" 2>/dev/null || true
  fi
  echo "SEVYN RECOVERY READY (sevyn CLI available; /tmp/genesis.log preserved to /data/logs/ when possible)"
  while true; do
    /bin/busybox setsid /bin/busybox cttyhack /bin/busybox sh
    echo "SEVYN RECOVERY: shell exited, restarting console"
    sleep 1
  done
}
echo "M4 init: modules start @ $(cut -d" " -f1 /proc/uptime)s"
for mod in $(cat "/lib/modules/$(uname -r)/sevyn-modules.txt" 2>/dev/null); do
  /bin/busybox insmod "$mod" || echo "M4 init: insmod $mod failed"
done
echo "M4 init: modules done @ $(cut -d" " -f1 /proc/uptime)s"
# The check asserts the real-hardware drivers loaded (i915, iwlwifi,
# nvme) from this line — /proc/modules lists loadable modules only,
# so built-ins (virtio-net etc.) never appear here.
echo "M7 init: loaded modules: $(cut -d' ' -f1 /proc/modules 2>/dev/null | tr '\n' ' ')"
ls /dev/dri/ 2>/dev/null || echo "M4 init: no /dev/dri (virtio-gpu module missing?)"
# A/B slots live on the persistent data disk (ext4, LABEL=SEVYN_DATA).
# udevd starts here — before the mount — because the /dev/disk/by-label
# symlink it creates is how the disk is found on bare metal, where the
# device name varies by bus (NVMe p2, USB sdX2). /dev/vda is tried
# first for backwards compat with the M6 data disk (no partition
# table, no label). No disk is fine on a first boot without one (the
# updater degrades to STATUS-only); the image still boots.
SLOT=""
for a in $(cat /proc/cmdline); do case "$a" in sevyn.slot=*) SLOT=${a#sevyn.slot=};; esac; done
VERSION=$(cat /usr/share/sevyn/os-version 2>/dev/null || echo unknown)
echo "M4 init: boot slot=${SLOT:-?} version=$VERSION"
# M9 ESP-sync proof: a test feed's marker initramfs carries
# /m9-esp-marker; print it to the console (serial) so the harness
# can prove the NEW initramfs booted (the Terminal's `files cat`
# output never reaches the serial log — it renders to the screen).
if [ -f /m9-esp-marker ]; then cat /m9-esp-marker; fi
/usr/lib/systemd/systemd-udevd &
echo "M7 init: udevd started @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm trigger --action=add --subsystem-match=block 2>/dev/null || echo "M7 init: block trigger failed"
DATA_DEV=""
# M11: the installed GRUB entry carries sevyn.data=PARTUUID=<uuid>
# (or a device path) so init mounts the right data partition when
# another SevynOS install's SEVYN_DATA label is also present.
# Tried FIRST, before /dev/vda and the label lookup.
for a in $(cat /proc/cmdline); do case "$a" in sevyn.data=*) DATA_ARG=${a#sevyn.data=};; esac; done
if [ -n "${DATA_ARG:-}" ]; then
  case "$DATA_ARG" in
    PARTUUID=*)
      # Resolve with blkid (reads the partition table directly),
      # NOT /dev/disk/by-partuuid/<uuid>: that udev symlink may not
      # exist yet when init runs (udevadm trigger is async), and a
      # mount of a nonexistent path fails outright. blkid is in the
      # image at /usr/sbin/blkid. Poll up to 10s: blkid scans /dev,
      # and the NVMe device nodes may not exist yet when init first
      # runs (the udev trigger is async). Fall back to the symlink
      # path if neither appears.
      # CASE: the pin carries the UUID in UPPERCASE (sgdisk), but
      # blkid matches PARTUUID case-sensitively against its
      # lowercase form, and udev's by-partuuid symlinks are
      # lowercase too — so lowercase the UUID first, or BOTH the
      # blkid query and the symlink path miss.
      _uuid=${DATA_ARG#PARTUUID=}
      _uuid=$(printf '%s' "$_uuid" | /bin/busybox tr 'A-Z' 'a-z')
      _i=0
      while [ -z "$DATA_DEV" ] && [ "$_i" -lt 100 ]; do
        DATA_DEV=$(/usr/sbin/blkid -t "PARTUUID=$_uuid" -o device 2>/dev/null)
        if [ -z "$DATA_DEV" ] && [ -e "/dev/disk/by-partuuid/$_uuid" ]; then
          DATA_DEV=/dev/disk/by-partuuid/$_uuid
        fi
        [ -z "$DATA_DEV" ] && sleep 0.1
        _i=$((_i + 1))
      done
      [ -z "$DATA_DEV" ] && DATA_DEV=/dev/disk/by-partuuid/$_uuid
      ;;
    *) DATA_DEV=$DATA_ARG ;;
  esac
  echo "M11 init: sevyn.data=$DATA_ARG -> $DATA_DEV"
fi
i=0
while [ -z "$DATA_DEV" ] && [ "$i" -lt 100 ]; do
  if [ -e /dev/vda ]; then DATA_DEV=/dev/vda; break; fi
  if [ -e /dev/disk/by-label/SEVYN_DATA ]; then DATA_DEV=/dev/disk/by-label/SEVYN_DATA; break; fi
  sleep 0.1
  i=$((i + 1))
done
if [ -n "$DATA_DEV" ]; then
  /bin/busybox mount -t ext4 "$DATA_DEV" /data 2>/dev/null && echo "M7 init: data disk mounted ($DATA_DEV)" || echo "M7 init: data disk mount failed ($DATA_DEV, continuing without it)"
else
  echo "M7 init: no data disk (no /dev/vda, no SEVYN_DATA label)"
fi
# Wi-Fi (M9): start wpa_supplicant when a wireless interface
# exists, so a saved network associates and the DHCP loop below can
# lease on it. The config lives on the data partition
# (/data/wifi/wpa_supplicant.conf, 0600); without a saved network
# the supplicant idles and the loop falls through to ethernet.
for iface in $(ls /sys/class/net/ 2>/dev/null | grep -v '^lo$'); do
  case "$iface" in wlan*|wlp*)
    mkdir -p /data/wifi /run/wpa_supplicant
    if [ ! -f /data/wifi/wpa_supplicant.conf ]; then
      printf 'ctrl_interface=/run/wpa_supplicant\nupdate_config=1\n' > /data/wifi/wpa_supplicant.conf
      chmod 0600 /data/wifi/wpa_supplicant.conf
    fi
    /usr/sbin/wpa_supplicant -B -i "$iface" -c /data/wifi/wpa_supplicant.conf -Dnl80211 2>/dev/null && echo "M9 init: wpa_supplicant started on $iface" || echo "M9 init: wpa_supplicant failed on $iface (continuing)"
    ;;
  esac
done
# Network for the updater + the browser: DHCP (M7). udhcpc runs on
# the first non-lo interface that gets a lease — ethernet-named
# interfaces first (eth0 in QEMU, enp* on the GF65's wired LAN),
# wifi last (an unassociated wifi interface never answers DHCP),
# anything else after that. In QEMU slirp's DHCP serves the same
# 10.0.2.15 the old static config used, so the QEMU path is
# unchanged. If no interface gets a lease the staged resolv.conf
# (slirp DNS) stays as the fallback and the boot continues without
# a network (the updater degrades). Loopback first: code-server
# serves on 127.0.0.1 and the serving checks connect to it — without
# `lo` up, 127.0.0.1 is unreachable even though the server is
# listening (the M4 local-run failure mode).
/bin/busybox ifconfig lo 127.0.0.1 up 2>/dev/null && echo "M4 init: lo up" || echo "M4 init: lo up failed (code-server checks will fail)"
IFACES=""
for iface in $(ls /sys/class/net/ 2>/dev/null | grep -v '^lo$'); do
  case "$iface" in eth*|enp*|eno*|enx*) IFACES="$IFACES $iface";; esac
done
for iface in $(ls /sys/class/net/ 2>/dev/null | grep -v '^lo$'); do
  case "$iface" in wlan*|wlp*) IFACES="$IFACES $iface";; esac
done
for iface in $(ls /sys/class/net/ 2>/dev/null | grep -v '^lo$'); do
  case "$iface" in eth*|enp*|eno*|enx*|wlan*|wlp*) ;; *) IFACES="$IFACES $iface";; esac
done
DHCP_OK=""
for iface in $IFACES; do
  if /bin/busybox udhcpc -i "$iface" -s /etc/udhcpc.script -q -t 3 -T 2 -n >/tmp/udhcpc.log 2>&1; then
    # The leased address is not on the console anywhere else (`sevyn
    # net status` prints it to the Terminal window, not the serial
    # log), so echo it here — the check asserts it, and a human
    # reading the boot log on the GF65 sees the address.
    DHCP_ADDR=$(/bin/busybox ifconfig "$iface" 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p')
    echo "M7 init: DHCP lease on $iface (${DHCP_ADDR:-unknown})"
    DHCP_OK="$iface"
    break
  fi
done
[ -n "$DHCP_OK" ] || echo "M7 init: no DHCP lease (continuing without a network)"
# Update daemon first among the services: it records the boot attempt
# for the booted slot before Genesis or the shell can fail, and marks
# the slot good once the shell reaches READY.
# (The update URL comes from the kernel cmdline sevyn.update_url= when
# set; otherwise the daemon uses its config file / the nightly feed.)
/usr/local/bin/sevyn-updated &
# udevd started before the data-disk mount (M7); it stays running.
# The event2 wait + trigger + settle below still run here.
echo "M7 init: udevd running @ $(cut -d" " -f1 /proc/uptime)s"
i=0
while [ ! -e /dev/input/event2 ] && [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
echo "M4 init: event2 seen @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm trigger --action=add 2>/dev/null || echo "M4 init: udevadm trigger failed"
echo "M4 init: trigger done @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm settle --timeout=10 2>/dev/null || echo "M4 init: udevadm settle timed out"
echo "M4 init: settle done @ $(cut -d" " -f1 /proc/uptime)s"
ls -la /dev/input/ 2>/dev/null || echo "M4 init: no /dev/input (no input devices?)"
# Status service first: the shell subscribes to it.
/usr/local/bin/sevyn-statusd &
# Tell statusd the link state (M5): `net announce` reads eth0's
# operstate and SETs wifi on/off, so the shell's tray shows Wi-Fi
# when the link is up. It runs AFTER statusd starts — the earlier
# position (before the daemons) could not reach statusd at all, so
# the SET was lost and the tray stayed on the "unknown" default. A
# failure here does NOT fail the boot — the M5 check asserts
# `sevyn net status` separately.
sleep 1
WIFI=$(/usr/local/bin/sevyn net announce 2>/dev/null || echo "wifi: off")
echo "M5 init: $WIFI"
# System clock (GF65: CMOS RTC reads 2010-01-03): NTP-sync now that
# the network is up (DHCP ran above) and statusd is running — the
# clock must be right before Genesis starts, or Chromium fails
# every HTTPS page with ERR_CERT_DATE_INVALID. Backgrounded +
# best-effort: a failed sync never fails the boot (the shell
# re-syncs hourly via its own timer, and `sevyn time sync`
# covers it by hand).
( /usr/local/bin/sevyn time sync >/tmp/sevyn-time-sync.log 2>&1 && echo "SEVYN_TIME_SYNCED $(head -n 1 /tmp/sevyn-time-sync.log)" || echo "SEVYN_TIME_SYNC_FAILED" ) &
# App daemon next: seeds the registry from pristine on first boot and
# owns /run/sevyn-apps.sock. The shell connects to it for its dock
# list and launches; the harness drives it over /dev/ttyS2.
/usr/local/bin/sevyn-appd &
# AI daemon (M4.5): owns /run/sevyn-ai.sock. Starts after appd +
# statusd so its first ASK can reach both. The harness drives it over
# /dev/ttyS4; the Terminal and Settings drive it through `sevyn ai`.
/usr/local/bin/sevyn-aid &
# commsd (M10): owns /run/sevyn-comms.sock (Matrix account, E2EE,
# call signaling). Starts after appd + statusd so its first STATUS
# can reach both; the apps drive it through `sevyn comms`. The
# Chromium media bridge runs per call from
# /usr/share/sevyn/chromium/chrome with the bridge page at
# /usr/share/sevyn/comms/bridge.html. Account + crypto store under
# /data/comms/ (0600, root-only). Its log goes to /data/logs/
# commsd.log — /data is the persistent data disk, so the log survives
# a reboot/poweroff (a /tmp log would be destroyed with the guest);
# the console only gets a one-line start marker.
# comms mocks (M10): test doubles, never system services — they
# start ONLY when the kernel cmdline carries sevyn.mockcomms=1
# (the M10 check boots with it). The mock Matrix homeserver on
# 127.0.0.1:7071 + the mock ACS/IMS (SIP 5060, MSRP 5061) let the
# check prove messaging, E2EE, calls, and the RCS skeleton with no
# network and no real accounts. Fake media follows the same flag:
# the check has no camera/mic, so the bridge uses the synthetic
# device; real hardware uses the real camera/mic.
for a in $(cat /proc/cmdline); do case "$a" in sevyn.mockcomms=*) MOCKCOMMS=${a#sevyn.mockcomms=};; esac; done
mkdir -p /data/comms /data/logs
/usr/share/sevyn/comms/node /usr/share/sevyn/comms/commsd.mjs \
  --bridge chromium --chrome /usr/share/sevyn/chromium/chrome \
  --bridge-page /usr/share/sevyn/comms/bridge.html \
  --fake-media "${MOCKCOMMS:-0}" >/data/logs/commsd.log 2>&1 &
echo "M10 init: commsd started @ $(cut -d" " -f1 /proc/uptime)s"
if [ "${MOCKCOMMS:-0}" = "1" ]; then
  /usr/share/sevyn/comms/node /usr/share/sevyn/comms-mock/mock-matrix.js >/dev/console 2>&1 &
  /usr/share/sevyn/comms/node /usr/share/sevyn/comms-mock/mock-acs.js >/dev/console 2>&1 &
  # Second commsd for the peer user (bob): the check logs bob in
  # against it with `sevyn comms --socket /tmp/commsd-bob.sock ...`
  # (the Terminal has no shell env assignment, so the socket rides
  # on the command line). Same Chromium bridge + fake media as the
  # system daemon; its log goes to /data/logs/commsd-bob.log.
  mkdir -p /tmp/comms-bob
  /usr/share/sevyn/comms/node /usr/share/sevyn/comms/commsd.mjs \
    --socket /tmp/commsd-bob.sock --data /tmp/comms-bob \
    --bridge chromium --chrome /usr/share/sevyn/chromium/chrome \
    --bridge-page /usr/share/sevyn/comms/bridge.html \
    --fake-media 1 >/data/logs/commsd-bob.log 2>&1 &
  echo "M10 init: comms mocks started (sevyn.mockcomms=1)"
fi
# camd (native camera): owns /run/sevyn-camera.sock (V4L2 capture,
# MJPEG passthrough or YUYV->JPEG). Starts after commsd; the apps
# drive it through `sevyn camera` and the RN host camera adapter
# talks to its socket directly. No Chromium, no ffmpeg — the daemon
# is the whole capture path. The synthetic source starts ONLY when
# the kernel cmdline carries sevyn.syntheticcamera=1 (the camera
# check boots with it — QEMU has no camera); real hardware runs
# the real device, and a device without one reports
# available:false. Its log goes to /data/logs/camd.log.
for a in $(cat /proc/cmdline); do case "$a" in sevyn.syntheticcamera=*) SYNTHCAM=${a#sevyn.syntheticcamera=};; esac; done
mkdir -p /data/camera /data/photos /data/logs
if [ "${SYNTHCAM:-0}" = "1" ]; then
  /usr/local/bin/sevyn-camd --synthetic >/data/logs/camd.log 2>&1 &
  echo "camd init: synthetic camera started (sevyn.syntheticcamera=1)"
else
  /usr/local/bin/sevyn-camd >/data/logs/camd.log 2>&1 &
  echo "camd init: camd started @ $(cut -d" " -f1 /proc/uptime)s"
fi
# audiod (native audio service): owns /run/sevyn-audio.sock (decodes
# local audio files in-process, plays PCM to the HDA device through
# ALSA). Starts after commsd so its first STATUS can answer while
# the shell comes up; the apps drive it through `sevyn music` and
# the host media adapter. Its log goes to /data/logs/audiod.log —
# /data is the persistent data disk, so the log survives a reboot
# (a /tmp log would be destroyed with the guest); the console only
# gets a one-line start marker. (/data/logs already exists — the
# commsd block above creates it.)
/usr/local/bin/sevyn-audiod >/data/logs/audiod.log 2>&1 &
echo "audiod started @ $(cut -d" " -f1 /proc/uptime)s"
# tailscaled (AI relay 1a): the Tailscale daemon for the mesh the
# cloud agent reaches the device over. Starts after DHCP (it needs
# the network to reach the control plane) and after sevyn-updated /
# sevyn-statusd, in the same style as commsd/camd/audiod.
# --statedir /data/tailscale: state MUST live on /data — the node
# key + control-plane state must survive a reboot (R6), and
# tailscaled's default /var/lib/tailscale sits in the initramfs
# root, which does not persist. The socket stays on /run (tmpfs,
# recreated at boot). Log to /data/logs/tailscaled.log, same as
# the other daemons. No join happens here unless the user already
# joined: 1b re-joins from the /data/ai/relay.json marker below,
# and until a first join `tailscale status` reports "Logged out.".
# NO RESTART (known gap): init has no supervisor — if tailscaled
# dies it stays dead until reboot. A watchdog is a follow-up; the
# daemon's death is at least visible in its log + the missing
# socket, and `sevyn tailscale status` reports it as unreachable.
# DNS note: tailscaled with DNS acceptance on would rewrite
# /etc/resolv.conf to its MagicDNS resolver and fight udhcpc's
# rewrites on every DHCP renewal — there is no DNS manager in the
# image to arbitrate. The 1b join therefore defaults to
# `tailscale up --accept-dns=false` (keep DHCP DNS, address the
# device by its 100.x tailnet IP, give up MagicDNS names).
mkdir -p /data/tailscale /data/logs
TAILSCALED_VERSION=$(/usr/local/bin/tailscaled --version 2>/dev/null | head -n 1)
echo "TAILSCALE tailscaled ${TAILSCALED_VERSION:-unknown}"
/usr/local/bin/tailscaled --statedir /data/tailscale >/data/logs/tailscaled.log 2>&1 &
echo "tailscaled started @ $(cut -d" " -f1 /proc/uptime)s"
# AI relay 1b: re-join on boot (R6) — the /data/ai/relay.json marker
# written by `sevyn tailscale up` is the user's persisted intent to
# stay on the tailnet. If it exists, re-run `tailscale up` with the
# stored login server (no auth key needed — the node key in
# /data/tailscale re-authenticates) and --accept-dns=false (keep DHCP
# DNS; see the DNS note above). Backgrounded with a retry loop, so a
# slow daemon or a failing control plane cannot stall boot; the
# result lands on the console (TAILSCALE re-join rc=) and in
# tailscaled.log. A `sevyn tailscale down` removes the marker, so a
# left tailnet stays left. The login server is pulled out of the
# marker JSON with sed — the CLI writes it in a fixed format, so the
# single-line pattern is stable.
if [ -f /data/ai/relay.json ]; then
  (
    LOGIN_SERVER=$(sed -n 's/.*"login_server": *"\([^"]*\)".*/\1/p' /data/ai/relay.json)
    if [ -n "$LOGIN_SERVER" ]; then
      echo "TAILSCALE re-joining $LOGIN_SERVER"
      RC=1
      I=0
      while [ "$I" -lt 5 ]; do
        /usr/local/bin/tailscale up --login-server "$LOGIN_SERVER" --accept-dns=false >>/data/logs/tailscaled.log 2>&1
        RC=$?
        if [ "$RC" -eq 0 ]; then
          break
        fi
        I=$((I + 1))
        sleep 2
      done
      echo "TAILSCALE re-join rc=$RC"
    fi
  ) &
fi
# AI relay 2: the relay agent (R6) — start it when the user enabled
# it (`sevyn ai relay on` writes /data/ai/relay-agent.json). The
# bind address comes from the tailnet (`tailscale ip -4`); the
# backgrounded re-join above may still be in flight, so the address
# may not exist yet — and if it does, the interface may not be fully
# up. The agent retries its bind for up to 60s on failure, so a
# slow re-join does not lose the agent; if `tailscale ip` gives
# nothing at all, log and skip starting (the agent has no transport
# without the mesh — starting it would fail outright). No restart
# (same known gap as tailscaled): if the agent dies it stays dead
# until reboot, visible in its log + the missing pidfile, and
# `sevyn ai relay status` reports it as not running.
if [ -f /data/ai/relay-agent.json ]; then
  RELAY_IP=$(/usr/local/bin/tailscale ip -4 2>/dev/null | head -n 1 || true)
  if [ -n "$RELAY_IP" ]; then
    echo "RELAY agent starting (bind $RELAY_IP:17893)"
    /usr/local/bin/sevyn-relay --bind "$RELAY_IP" --port 17893 >/data/logs/sevyn-relay.log 2>&1 &
  else
    echo "RELAY agent not started: no tailnet address yet (re-join still in flight?)"
  fi
fi
# Sevyn Code (M4): code-server serves the IDE on 127.0.0.1:8080
# (localhost only — the browser that paints it arrives in M5). It
# needs HOME for its user-data dir (the staged settings file lives
# under /root/.local/share/code-server). --auth none: the IDE is local
# only; auth arrives with the browser milestone. The pid file is what
# `sevyn code status` reads for "running".
export HOME=/root
/usr/share/sevyn/code-server/bin/code-server --auth none --disable-telemetry --disable-update-check --bind-addr 127.0.0.1:8080 >/tmp/code-server.log 2>&1 &
echo $! > /run/code-server.pid
# --- Genesis compositor (Stage 3) ----------------------------------------
# sevyn.recovery=1: direct entry to the recovery console, skipping
# the compositor entirely (RECOVERY.md item 4) — for the case where
# the compositor cannot start at all. Checked here, after the
# daemons above (so the `sevyn` CLI has statusd/appd/aid behind it)
# and before seatd / the compositor. The check boots with this flag
# and proves the console + `sevyn` CLI answer.
for a in $(cat /proc/cmdline); do case "$a" in sevyn.recovery=*) RECOVERY_ARG=${a#sevyn.recovery=};; esac; done
if [ "${RECOVERY_ARG:-0}" = "1" ]; then
  echo "GENESIS sevyn.recovery=1: entering recovery console, compositor skipped"
  recovery_console "sevyn.recovery=1 (direct entry)"
fi
# Seat daemon: Genesis (as root) opens DRM + input devices through
# it (libseat session). Wait for its socket — without a seat the
# compositor fails cleanly with exit 1, and init must land on the
# recovery console, not hang.
# --socket=wayland-0 is REQUIRED, not cosmetic: without --socket the
# compositor ignores WAYLAND_DISPLAY and picks the first free
# wayland-N name starting at wayland-1, so the socket would land at
# /run/wayland-1 while this init and the shell host both wait on
# /run/wayland-0 (the M1 failure mode, same as Weston before it).
/usr/sbin/seatd &
echo "GENESIS init: starting seatd @ $(cut -d" " -f1 /proc/uptime)s"
i=0
while [ ! -S /run/seatd.sock ] && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
if [ ! -S /run/seatd.sock ]; then
  echo "GENESIS seatd socket never appeared; recovery console"
  recovery_console "seatd socket never appeared"
fi
# Start sevyn-compositor --standalone as the one and only
# compositor. No Weston fallback, ever: a Genesis failure lands on
# the recovery console (RECOVERY.md). The compositor's own
# /tmp/genesis.log carries the SEVYN READY marker + the crash
# record; its stdout goes to /dev/console so the markers are in the
# serial log the check reads, stderr to /tmp/genesis-stderr.log.
# Started through an exec wrapper so GENESIS_PID is the compositor
# itself (not a shell), and `wait` below returns its real exit code.
# No GL overrides are exported here: Genesis opens the DRM device
# through GBM itself, and the standalone check proves GLES on
# llvmpipe with no overrides (the Weston-era LIBGL_ALWAYS_SOFTWARE
# / MESA_LOADER_DRIVER_OVERRIDE / EGL_PLATFORM exports belonged to
# Weston's renderer, not the compositor). The host launch below
# exports the software-GL overrides for the host only.
# SEVYN_TEST_PANIC is never set in production (test-only fault
# injection — only standalone-check.sh sets it).
# No --runtime-pid: the image is single-uid (root), so the Stage 2/3
# same-uid bridge auth applies; pid binding is the Stage 4 adoption
# feature, and the adoption proof passes it explicitly.
# sevyn.pixman=1: force the Pixman renderer (GLES off) — the check's
# Pixman boot. Genesis forces Pixman with --no-gles (SEVYN_NO_GLES=1
# does the same; src/main.rs + src/drm.rs, and compositor/README.md);
# the READY marker then reports renderer=pixman. Without this the
# Pixman boot comes up renderer=gles and the check records NOT_PROVEN.
for a in $(cat /proc/cmdline); do case "$a" in sevyn.pixman=*) PIXMAN_ARG=${a#sevyn.pixman=};; esac; done
GENESIS_EXTRA_ARGS=""
if [ "${PIXMAN_ARG:-0}" = "1" ]; then
  GENESIS_EXTRA_ARGS="--no-gles"
  echo "GENESIS sevyn.pixman=1: forcing Pixman renderer (--no-gles)"
fi
# Restart policy (RECOVERY.md item 3): up to 3 start attempts with
# a backoff; before each retry the log is preserved off
# (/data/logs/genesis-attempt-N.log) because the next start
# truncates /tmp/genesis.log. A crash loop surfaces, it does not
# spin: after 3 attempts init lands on the recovery console.
GENESIS_ATTEMPT=0
GENESIS_OK=0
GENESIS_PID=""
while [ "$GENESIS_ATTEMPT" -lt 3 ] && [ "$GENESIS_OK" = "0" ]; do
  GENESIS_ATTEMPT=$((GENESIS_ATTEMPT + 1))
  # A stale socket / log from a previous attempt would fake a READY
  # (the wait below checks both), so remove them before each start.
  rm -f /run/wayland-0 /tmp/genesis.log /tmp/genesis-stderr.log
  echo "GENESIS starting sevyn-compositor --standalone (attempt $GENESIS_ATTEMPT/3) @ $(cut -d" " -f1 /proc/uptime)s"
  ( exec env -u SEVYN_TEST_PANIC /usr/local/bin/sevyn-compositor --standalone --socket wayland-0 $GENESIS_EXTRA_ARGS >/dev/console 2>/tmp/genesis-stderr.log ) &
  GENESIS_PID=$!
  echo "$GENESIS_PID" > /run/sevyn-compositor.pid
  # Wait for the SEVYN READY marker (socket up) in the compositor's
  # own log AND the socket itself. Budget: socket up ≤ 2 s from
  # exec; the wait is 15 s so a slow TCG boot still makes it, and a
  # dead compositor still lands on the recovery console promptly.
  i=0
  while [ "$i" -lt 150 ]; do
    if ! kill -0 "$GENESIS_PID" 2>/dev/null; then break; fi
    if [ -S /run/wayland-0 ] && grep -q "SEVYN READY" /tmp/genesis.log 2>/dev/null; then GENESIS_OK=1; break; fi
    sleep 0.1
    i=$((i + 1))
  done
  if [ "$GENESIS_OK" = "1" ]; then
    echo "GENESIS $(grep 'SEVYN READY' /tmp/genesis.log 2>/dev/null | head -n 1)"
    break
  fi
  # Start failed (or the compositor died while starting): stop it
  # if it is still alive, say why, preserve the log, back off.
  if kill -0 "$GENESIS_PID" 2>/dev/null; then
    kill "$GENESIS_PID" 2>/dev/null || true
    i=0
    while kill -0 "$GENESIS_PID" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    if kill -0 "$GENESIS_PID" 2>/dev/null; then kill -9 "$GENESIS_PID" 2>/dev/null || true; sleep 1; fi
  fi
  wait "$GENESIS_PID" 2>/dev/null; GENESIS_RC=$?
  echo "GENESIS attempt $GENESIS_ATTEMPT failed (exit ${GENESIS_RC:-?}); compositor log:"
  cat /tmp/genesis.log 2>/dev/null || echo "(no /tmp/genesis.log)"
  echo "--- genesis stderr ---"
  cat /tmp/genesis-stderr.log 2>/dev/null || echo "(no genesis stderr)"
  preserve_genesis_log "attempt-$GENESIS_ATTEMPT"
  if [ "$GENESIS_ATTEMPT" -lt 3 ]; then sleep 2; fi
done
if [ "$GENESIS_OK" = "0" ]; then
  echo "GENESIS compositor failed to start after 3 attempts; recovery console"
  recovery_console "compositor failed to start (3 attempts)"
fi
# GENESIS RSS: the check's memory step reads the first `GENESIS RSS
# <kib>` console line after Shell + Terminal idle 2s and asserts
# RSS <= 200 MB (Stage 3 budget, ACCEPTANCE.md). No sevyn/statusd
# verb reports a process's RSS, so init prints it directly from
# /proc/<pid>/status (VmRSS, KiB). 5 s interval: slow enough to be
# harmless under TCG load, fast enough that the check never waits
# long for the first line after idle. The loop exits when the
# compositor dies.
(
  while kill -0 "$GENESIS_PID" 2>/dev/null; do
    _rss=$(grep '^VmRSS:' "/proc/$GENESIS_PID/status" 2>/dev/null | awk '{print $2}')
    if [ -n "$_rss" ]; then echo "GENESIS RSS $_rss"; fi
    sleep 5
  done
) > /dev/console 2>&1 &
# M12 Genesis: sevyn.genesis=0 on the kernel cmdline forces the CPU
# painter (the fallback boot the M12 check proves). The host reads
# SEVYN_GENESIS; anything else means "try the GPU path".
case " $(cat /proc/cmdline 2>/dev/null) " in
  *" sevyn.genesis=0 "*) export SEVYN_GENESIS=0 ;;
esac
# The shell host: Hermes + Yoga + Wayland + Genesis GPU present path
# (CPU raster fallback). Its logLine
# writes to /dev/console (the serial the harness reads) AND stderr, so
# stderr is captured to a file for the READY wait while the serial keeps
# the live stream (LAUNCH lines, errors).
# CPU-only software GL for the HOST only (M12, Kevon 2026-11-13:
# SevynOS must run on CPU-only devices): this image has no
# 3D-capable GPU — virtio-gpu exposes dumb scanout buffers only
# (no virgl) — so the host's EGL presenter must render in software
# (llvmpipe into the virtio-gpu dumb buffers), exactly the shape a
# real CPU-only machine has. These exports are set HERE, after the
# compositor is already running, so they cannot leak into the
# compositor's environment (Genesis opens DRM through GBM itself
# with no overrides). EGL_PLATFORM is never set in this image: it
# was Weston's setting, and in the host's env it forces
# eglGetDisplay(wl_display) onto the GBM platform, so Mesa reads
# the wl_display pointer as a gbm_device and eglInitialize fails
# EGL_NOT_INITIALIZED (0x3001) — the M12 root cause #8 failure.
# The `env -u EGL_PLATFORM` on the launch line stays as a guard
# against a stray export from the boot environment.
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_LOADER_DRIVER_OVERRIDE=kms_swrast
env -u EGL_PLATFORM /usr/local/bin/sevyn-rn-host 2>/tmp/sevyn-host.log &
HOST_PID=$!
# If the host dies, dump genesis + host logs to the console (the serial
# the harness captures) so a blank screen is diagnosable from the
# artifacts instead of a silent exit: libwayland prints the protocol
# error to the host's stderr, Genesis prints its side to genesis.log.
(while kill -0 "$HOST_PID" 2>/dev/null; do sleep 0.5; done
 echo "--- sevyn-host died; genesis.log ---"
 cat /tmp/genesis.log 2>/dev/null || echo "(no genesis log)"
 echo "--- sevyn-host.log ---"
 cat /tmp/sevyn-host.log 2>/dev/null || echo "(no host log)") > /dev/console 2>&1 &
# Wait for the shell to mount (the host logs SEVYNOS_M2_READY after the
# bundle evaluates). Exit the wait early if the host process died: a dead
# shell can never become ready, and powering off promptly lets the
# bootloader fall back to the good slot instead of burning the full
# 60 s wait on a broken image.
i=0
while ! grep -q "SEVYNOS_M2_READY" /tmp/sevyn-host.log 2>/dev/null && kill -0 "$HOST_PID" 2>/dev/null && [ "$i" -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
if ! grep -q "SEVYNOS_M2_READY" /tmp/sevyn-host.log 2>/dev/null; then
  echo "M4 init: shell host never became ready; host log:"
  cat /tmp/sevyn-host.log 2>/dev/null || echo "(no host log)"
  # The desktop cannot come up without its shell: stop the
  # compositor (it holds the display) and land on the recovery
  # console — never a hung black screen, never a silent poweroff
  # that hides the failure from the operator.
  if kill -0 "$GENESIS_PID" 2>/dev/null; then kill "$GENESIS_PID" 2>/dev/null || true; sleep 1; kill -9 "$GENESIS_PID" 2>/dev/null || true; fi
  recovery_console "shell host never became ready"
fi
echo "SEVYNOS_M2_READY"
# Sevyn Code must be serving before the harness starts driving the
# Terminal: give it up to 120 s to answer on its port. code-server is
# a 457 MB Node app and under TCG load its startup can exceed 10 s,
# which used to leave CODE_OK=0 on slow boots. A longer wait is not
# enough on its own: under load code-server can die during startup
# (it logs "error timed out" ~11 s after writing its config and never
# serves), so a failed attempt relaunches it, up to 3 launches; a
# relaunch after the compositor + the shell are up runs under less startup
# load. A failure here does NOT fail the boot -- the M4 check asserts
# code status separately, with the server log as the diagnostic.
CODE_OK=0
attempt=1
while [ "$attempt" -le 3 ] && [ "$CODE_OK" = "0" ]; do
  i=0
  while [ "$i" -lt 1200 ]; do
    if wget -qO- http://127.0.0.1:8080/ 2>/dev/null | grep -q codeServerVersion; then CODE_OK=1; break; fi
    sleep 0.1
    i=$((i + 1))
  done
  if [ "$CODE_OK" = "0" ] && [ "$attempt" -lt 3 ]; then
    echo "M4 init: code-server attempt $attempt did not serve; relaunching"
    if [ -f /run/code-server.pid ]; then kill "$(cat /run/code-server.pid)" 2>/dev/null || true; fi
    sleep 1
    /usr/share/sevyn/code-server/bin/code-server --auth none --disable-telemetry --disable-update-check --bind-addr 127.0.0.1:8080 >>/tmp/code-server.log 2>&1 &
    echo $! > /run/code-server.pid
  fi
  attempt=$((attempt + 1))
done
if [ "$CODE_OK" = "1" ]; then echo "M4 init: code-server serving"; else echo "M4 init: code-server NOT serving (see /tmp/code-server.log)"; echo "--- code-server.log ---"; cat /tmp/code-server.log 2>/dev/null || echo "(no code-server log)"; echo "--- end code-server.log ---"; fi
echo "SEVYNOS_M4_READY"
echo "SEVYNOS_M4_SLOT ${SLOT:-?} VERSION $VERSION"
# The AI daemon must answer before the harness starts driving it:
# give it up to 10 s to answer `sevyn ai status` on its socket. A
# failure here does NOT fail the boot — the M4.5 check asserts the
# AID READY line + this probe separately, with the aid log as the
# diagnostic (the daemon logs to the console + stderr).
AID_OK=0
i=0
while [ "$i" -lt 100 ]; do
  if /usr/local/bin/sevyn ai status >/dev/null 2>&1; then AID_OK=1; break; fi
  sleep 0.1
  i=$((i + 1))
done
if [ "$AID_OK" = "1" ]; then echo "M4.5 init: AI daemon ready"; else echo "M4.5 init: AI daemon NOT ready"; fi
echo "SEVYNOS_M4_5_READY"
# Connectivity + Chromium must answer before the harness starts
# driving the browser: `sevyn net status` reads the link, and
# `sevyn browser status` must report Chromium down (it only starts
# on demand via `browser open`) without erroring. A failure here does
# NOT fail the boot — the M5 check asserts net + browser status
# separately, with the console as the diagnostic.
NET_IF=$(/usr/local/bin/sevyn net status 2>/dev/null | grep '^interface:' || echo "interface: unknown")
echo "M5 init: $NET_IF"
echo "SEVYNOS_M5_READY"
# Genesis supervisor (RECOVERY.md item 2 + Stage 3 milestone 8): if
# the compositor exits after starting — crash (SEVYN CRASH marker,
# exit 101) or clean shutdown (exit 0) — the desktop is gone, so
# preserve the log, stop the shell host (its Wayland connection is
# dead), and land on the recovery console. No restart attempts here:
# the compositor never restarts itself, and a crash loop must
# surface on the console, not spin. The exit code is read from the
# log markers (a poll loop cannot wait() a child of another shell).
(
  while kill -0 "$GENESIS_PID" 2>/dev/null; do sleep 0.5; done
  if grep -q "SEVYN CRASH" /tmp/genesis.log 2>/dev/null; then
    GENESIS_END="crashed ($(grep 'SEVYN CRASH' /tmp/genesis.log 2>/dev/null | head -n 1))"
  elif grep -q "SEVYN SHUTDOWN clean" /tmp/genesis.log 2>/dev/null; then
    GENESIS_END="clean shutdown"
  else
    GENESIS_END="exited"
  fi
  echo "GENESIS compositor $GENESIS_END; preserving log and entering recovery console"
  preserve_genesis_log "exit"
  if kill -0 "$HOST_PID" 2>/dev/null; then kill "$HOST_PID" 2>/dev/null || true; fi
  recovery_console "compositor $GENESIS_END"
) &
# Stay alive; the harness powers us off via the status daemon.
while true; do sleep 3600; done
EOF
chmod +x "$STAGE/init"

# Genesis check 4 (recovery entry): the staged init must contain the
# sevyn.recovery=1 direct entry AND the recovery console marker.
# Checked here, after the init is written — a missing entry must
# fail this build, never ship as an image with no way back in.
grep -q "sevyn.recovery=1" "$STAGE/init" || { echo "error: staged init has no sevyn.recovery=1 entry (recovery console unreachable)" >&2; exit 1; }
grep -q "SEVYN RECOVERY READY" "$STAGE/init" || { echo "error: staged init has no SEVYN RECOVERY READY marker (recovery console missing)" >&2; exit 1; }
echo "Genesis init verified: sevyn.recovery=1 entry + recovery console present"

(cd "$STAGE" && find . | cpio -o -H newc 2>/dev/null | gzip -9 >"$OUT/initramfs.cpio.gz")

# M7: the GPT USB-boot disk image (ESP + data partition) — built
# rootless by make-disk-image.py from the kernel + initramfs just
# produced. make-data-disk.py builds the data partition's ext4
# (A/B slots + slot-state) inside it.
python3 "$ROOT/image/make-disk-image.py" \
  --kernel "$OUT/vmlinuz" \
  --initramfs "$OUT/initramfs.cpio.gz" \
  --version "$os_version" \
  --make-data-disk "$ROOT/image/make-data-disk.py" \
  --sysroot "$SYSROOT" \
  --out "$OUT/sevynos-genesis.img" \
  || { echo "error: disk image build failed" >&2; exit 1; }

# Genesis image size budget: GitHub caps release assets at 2 GiB
# (2,147,483,648 bytes) and the nightly publish guard fails at >= cap
# — the M13 nightly on main d479fdb7 failed exactly this way, the
# image hitting the cap after sample-media seeding grew the data disk
# by ~32 MiB. This builder stages no sample media and no Weston, but
# the data-disk default dominates the size, so enforce the cap here:
# hard fail at the cap, warn within 47 MiB of it.
GENESIS_IMG="$OUT/sevynos-genesis.img"
GENESIS_IMG_BYTES=$(stat -c %s "$GENESIS_IMG")
GENESIS_IMG_CAP=2147483648
GENESIS_IMG_WARN=2100000000
echo "Genesis image size: $GENESIS_IMG_BYTES bytes (cap $GENESIS_IMG_CAP)"
if [ "$GENESIS_IMG_BYTES" -ge "$GENESIS_IMG_CAP" ]; then
  echo "error: Genesis image is $GENESIS_IMG_BYTES bytes, at or over the 2 GiB GitHub release-asset cap ($GENESIS_IMG_CAP) — it cannot publish" >&2
  exit 1
fi
if [ "$GENESIS_IMG_BYTES" -ge "$GENESIS_IMG_WARN" ]; then
  echo "warning: Genesis image is $GENESIS_IMG_BYTES bytes, within $((GENESIS_IMG_CAP - GENESIS_IMG_BYTES)) bytes of the 2 GiB cap" >&2
fi

echo "Built Genesis image in $OUT (kernel $kernel_version, OS version $os_version)"
ls -l "$OUT"
