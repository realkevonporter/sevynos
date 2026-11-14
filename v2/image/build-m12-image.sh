#!/bin/sh
# Build the SevynOS v2 M12 image: everything in the M11 image, plus
# Genesis, the GPU compositor (Kevon, 2026-11-13: "Start the GPU
# compositor" — 60 fps on the GF65; QEMU/TCG cannot prove the bar).
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
# Tokrah (M6): the 100% React Native Tokrah app, bundled by Metro
# against the SevynOS compat shim (v2/tokrah/), compiled to Hermes
# bytecode, packaged as an unsigned third-party .sevyn bundle
# (tokrah.sevyn, cli.exec permission) into pristine, with the raw hbc
# staged at /usr/share/sevyn/tokrah/tokrah.hbc (what `sevyn tokrah
# run` falls back to). The mock API server (v2/tokrah/harness/
# mock-api.js + socket.io) is staged at /usr/share/sevyn/tokrah-mock/
# for the check; init starts it ONLY when the kernel cmdline carries
# sevyn.mockapi=1 (a test double, never a system service).
#
# Tokrah source: TOKRAH_SRC (a local checkout of realkevonporter/
# tokrah) or, in CI, a clone authenticated with TOKRAH_READ_TOKEN (a
# read-only repo-scoped PAT — Sevyn cannot create repo secrets). If
# NEITHER is set the build FAILS LOUDLY: an M6 image without Tokrah
# is not an M6 image. The built bundle is never committed to this
# public repo (Tokrah's proprietary JS; Hermes bytecode is
# decompilable).
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
# Requirements (on top of the M6 list): yarn (Tokrah installs with its
# pinned yarn 1.22.22), sgdisk, mkfs.vfat, mcopy, mkfs.ext4, debugfs
# (the disk image), zstd (firmware decompression).
# Outputs (SEVYN_V2_BUILD_DIR, default v2/image/build/):
#   vmlinuz, initramfs.cpio.gz, kernel-version.txt, os-version,
#   sevynos.img, update-signing-key.json (test mode only)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="${SEVYN_V2_SYSROOT:-/}"
OUT="${SEVYN_V2_BUILD_DIR:-$ROOT/image/build}"
DEPS_DIR="${SEVYN_V2_DEPS_DIR:-$ROOT/rn/host/deps}"
PREFIX="$DEPS_DIR/prefix"
HERMES_BUILD="$DEPS_DIR/build/hermes"

if [ "$SYSROOT" != "/" ]; then
  PATH="$SYSROOT/usr/bin:$SYSROOT/bin:$SYSROOT/usr/sbin:$SYSROOT/sbin:$PATH"
  export PATH
fi

if [ -n "${SEVYN_V2_KERNEL:-}" ]; then
  kernel="$SEVYN_V2_KERNEL"
else
  kernel="$(find /boot -maxdepth 1 -type f -name 'vmlinuz-*' -readable ! -name 'vmlinuz-*-azure' 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [ -z "$kernel" ]; then
  echo "error: no readable kernel found in /boot (install linux-image-generic; sudo may be needed to read it)" >&2
  exit 1
fi
kernel_version="$(basename "$kernel" | sed 's/^vmlinuz-//')"

for tool in busybox cpio curl gcc g++ pkg-config wayland-scanner python3 zstd modinfo cmake node npm openssl unzip strip sgdisk mkfs.vfat mcopy mdir mmd mkfs.ext4 debugfs blkid efibootmgr; do
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
for f in "$SYSROOT/usr/bin/weston" "$SYSROOT/usr/sbin/seatd" \
         "$SYSROOT/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml"; do
  if [ ! -f "$f" ]; then
    echo "error: missing $f (install weston, seatd, wayland-protocols)" >&2
    exit 1
  fi
done

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
HERMES_SRC="$(ls -d "$DEPS_DIR"/src/hermes-*/)"
[ -x "$PREFIX/bin/hermesc" ] || { echo "error: $PREFIX/bin/hermesc missing" >&2; exit 1; }
[ -f "$PREFIX/lib/libyogacore.a" ] || { echo "error: libyogacore.a missing" >&2; exit 1; }

# --- compile the SevynOS programs -----------------------------------------
wayland-scanner client-header \
  "$SYSROOT/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml" \
  "$BUILD_TMP/xdg-shell-client-protocol.h"
wayland-scanner private-code \
  "$SYSROOT/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml" \
  "$BUILD_TMP/xdg-shell-protocol.c"

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

# The update daemon + CLI (M8): sevyn-updated owns the A/B slots and
# the feed check/download/apply flow; `sevyn` is the CLI (M4: update
# + shell + files + code verbs, REPL mode). The daemon links OpenSSL
# for Ed25519 feed verification.
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn-updated" \
  "$ROOT/update/sevyn-updated.c" "$ROOT/update/canonical.c" \
  "$ROOT/loader/json.c" "$ROOT/loader/verify.c" -lcrypto
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn" \
  "$ROOT/update/sevyn.c"

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

# wayland-scanner's private-code output is C: its `const struct
# wl_interface` definitions have external linkage in C, but in C++
# namespace-scope const has INTERNAL linkage — so passing the .c to g++
# makes every interface invisible to wayland.cc (undefined reference to
# xdg_wm_base_interface, verified in CI run 42333389196). M1 compiles
# the same file with gcc (build-m1-image.sh). Compile it as C here too
# and link the object.
gcc -O2 -c $(pkg-config --cflags wayland-client) \
  -I"$BUILD_TMP" \
  -o "$BUILD_TMP/xdg-shell-protocol.o" \
  "$BUILD_TMP/xdg-shell-protocol.c"

# The RN host: Hermes embed + Yoga + Wayland + painter + status bridge.
# Hermes's public headers (HermesExport.h, RuntimeConfig.h) are NOT
# installed by cmake --install, so the source public/ dir is on the
# include path too. Link: every Hermes build archive (except the lean
# variants, which would duplicate libhermes's symbols) inside
# --start-group/--end-group so order does not matter, plus yogacore.
# ICU: Hermes's libhermesPlatformUnicode.a calls ICU (ucol_*/uloc_*/udat_*,
# verified in CI run 42333389196) — link icui18n/icuuc/icudata. The host
# binary is in the copy-closure list below, so the libicu*.so.74 runtime
# closure is staged into the image with it.
HERMES_LIBS="$(find "$HERMES_BUILD" -name '*.a' ! -name '*lean*' ! -path '*unittests*' ! -name '*Test*' | sort)"
# shellcheck disable=SC2086
# M12 Genesis: the GPU present path needs EGL + GLES2 + wayland-egl
# headers. Fail loudly without them — a silent CPU-only M12 image is
# not acceptable (the M12 check asserts the GPU path is live).
# wayland-egl.h ships with libwayland-dev (already required above).
if ! pkg-config --exists egl glesv2 wayland-egl; then
  echo "error: EGL dev packages missing (install libegl-dev libgles-dev)" >&2
  exit 1
fi
g++ -O2 -std=c++17 -Wall -Wextra -DSEVYN_HAVE_EGL=1 \
  -I"$ROOT/rn/host" -I"$BUILD_TMP" \
  -I"$PREFIX/include" -I"$HERMES_SRC/public" \
  $(pkg-config --cflags wayland-client wayland-cursor freetype2 libpng egl glesv2 wayland-egl) \
  -o "$BUILD_TMP/sevyn-rn-host" \
  "$ROOT/rn/host/common.cc" "$ROOT/rn/host/painter.cc" \
  "$ROOT/rn/host/genesis-presenter.cc" \
  "$ROOT/rn/host/wayland.cc" "$ROOT/rn/host/status.cc" \
  "$ROOT/rn/host/appclient.cc" \
  "$ROOT/rn/host/yoga-bridge.cc" "$ROOT/rn/host/sevyn-rn-host.cc" \
  "$BUILD_TMP/xdg-shell-protocol.o" \
  -Wl,--start-group $HERMES_LIBS "$PREFIX/lib/libyogacore.a" -Wl,--end-group \
  $(pkg-config --libs wayland-client wayland-cursor freetype2 libpng egl glesv2 wayland-egl) $(pkg-config --libs icu-uc icu-i18n) -lpthread -ldl

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
# Browser is a real app with its own .hbc (M5); the other eight stock
# apps share the one template .hbc (identity comes from the host at
# runtime); the crash .hbc is the harness's crash fixture.
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
[ -f "$BUILD_TMP/app-dist/app.hbc" ] || { echo "error: app.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/crash.hbc" ] || { echo "error: crash.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/terminal.hbc" ] || { echo "error: terminal.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/settings.hbc" ] || { echo "error: settings.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/files.hbc" ] || { echo "error: files.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/browser.hbc" ] || { echo "error: browser.hbc not built" >&2; exit 1; }
[ -f "$BUILD_TMP/app-dist/installer.hbc" ] || { echo "error: installer.hbc not built" >&2; exit 1; }
python3 "$APPS_DIR/make-bundles.py" \
  --hbc "$BUILD_TMP/app-dist/app.hbc" \
  --crash-hbc "$BUILD_TMP/app-dist/crash.hbc" \
  --terminal-hbc "$BUILD_TMP/app-dist/terminal.hbc" \
  --settings-hbc "$BUILD_TMP/app-dist/settings.hbc" \
  --files-hbc "$BUILD_TMP/app-dist/files.hbc" \
  --browser-hbc "$BUILD_TMP/app-dist/browser.hbc" \
  --installer-hbc "$BUILD_TMP/app-dist/installer.hbc" \
  --out "$BUILD_TMP/pristine" \
  --trusted-keys-dir "$BUILD_TMP/trusted-keys" \
  --test-bundles-dir "$BUILD_TMP/test-bundles"

# --- Tokrah (M6) ------------------------------------------------------------
# Bundle Tokrah from a pinned source, compile to Hermes bytecode, and
# package it as an unsigned third-party .sevyn bundle into pristine.
# Source: TOKRAH_SRC, or a TOKRAH_READ_TOKEN clone in CI. If NEITHER
# is set the build FAILS LOUDLY — an M6 image without Tokrah is not
# an M6 image (see the header; the token is Kevon's one-time action).
if [ -n "${TOKRAH_SRC:-}" ]; then
  echo "Tokrah source: TOKRAH_SRC=$TOKRAH_SRC"
elif [ -n "${TOKRAH_READ_TOKEN:-}" ]; then
  TOKRAH_SRC="$BUILD_TMP/tokrah-src"
  echo "Tokrah source: cloning realkevonporter/tokrah (read-only token)"
  git clone --depth 1 "https://x-access-token:${TOKRAH_READ_TOKEN}@github.com/realkevonporter/tokrah.git" "$TOKRAH_SRC" \
    || { echo "error: Tokrah clone failed (check TOKRAH_READ_TOKEN)" >&2; exit 1; }
else
  echo "error: M6 needs Tokrah source — set TOKRAH_SRC (local checkout) or TOKRAH_READ_TOKEN (CI: a read-only repo-scoped PAT on realkevonporter/tokrah; add it under Settings > Secrets and variables > Actions). Sevyn cannot create repo secrets." >&2
  exit 1
fi
[ -d "$TOKRAH_SRC/tokrah" ] || { echo "error: TOKRAH_SRC has no tokrah/ dir: $TOKRAH_SRC" >&2; exit 1; }
TOKRAH_VERSION="$(node -e "console.log(require('$TOKRAH_SRC/tokrah/package.json').version)")"
echo "Tokrah version: $TOKRAH_VERSION"
# Tokrah installs with its pinned yarn (packageManager yarn@1.22.22);
# the app's node_modules are its own — nothing is hoisted into this
# monorepo's pnpm catalog (the dogfooding rule).
command -v yarn >/dev/null 2>&1 || { echo "error: yarn not found (Tokrah installs with yarn 1.22.22)" >&2; exit 1; }
if [ ! -d "$TOKRAH_SRC/tokrah/node_modules" ]; then
  (cd "$TOKRAH_SRC/tokrah" && yarn install --frozen-lockfile --non-interactive) \
    || { echo "error: Tokrah yarn install failed" >&2; exit 1; }
fi
EXPO_PUBLIC_API_URL=http://127.0.0.1:7070 TOKRAH_SRC="$TOKRAH_SRC" \
  node "$ROOT/tokrah/build-tokrah.mjs" "$ROOT/tokrah/entry-tokrah.js" \
  "$BUILD_TMP/tokrah.bundle.js" ios \
  || { echo "error: Tokrah Metro bundle failed" >&2; exit 1; }
[ -f "$BUILD_TMP/tokrah.bundle.js" ] || { echo "error: tokrah.bundle.js not built" >&2; exit 1; }
"$PREFIX/bin/hermesc" -emit-binary -out "$BUILD_TMP/tokrah.hbc" "$BUILD_TMP/tokrah.bundle.js" \
  || { echo "error: tokrah.hbc compile failed" >&2; exit 1; }
python3 "$ROOT/tokrah/make-tokrah-bundle.py" \
  --hbc "$BUILD_TMP/tokrah.hbc" --version "$TOKRAH_VERSION" \
  --out "$BUILD_TMP/pristine" \
  --staged-hbc "$BUILD_TMP/tokrah-staged.hbc" \
  || { echo "error: tokrah.sevyn packaging failed" >&2; exit 1; }
# The mock API server for the check: the harness mock-api.js plus a
# socket.io install next to it (mock-api.js prefers a sibling
# node_modules/socket.io, so no Tokrah API install is needed here).
mkdir -p "$BUILD_TMP/tokrah-mock/node_modules"
cp "$ROOT/tokrah/harness/mock-api.js" "$BUILD_TMP/tokrah-mock/mock-api.js"
(cd "$BUILD_TMP/tokrah-mock" && npm install --no-audit --no-fund socket.io@4.8.3) \
  || { echo "error: mock server socket.io install failed" >&2; exit 1; }

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

# --- stage the rootfs ------------------------------------------------------
mkdir -p "$STAGE/bin" "$STAGE/proc" "$STAGE/sys" "$STAGE/dev" "$STAGE/run" \
         "$STAGE/tmp" "$STAGE/data" "$STAGE/root/.local/share/code-server/User" \
         "$STAGE/etc/xdg/weston" "$STAGE/usr/local/bin" \
         "$STAGE/usr/share/sevyn/shell" "$STAGE/usr/share/sevyn/pristine" \
         "$STAGE/usr/share/sevyn/code-server" \
         "$STAGE/usr/share/sevyn/chromium" \
         "$STAGE/usr/share/sevyn/ai/backends" \
         "$STAGE/usr/share/sevyn/test-bundles" \
         "$STAGE/usr/share/sevyn/tokrah" "$STAGE/usr/share/sevyn/tokrah-mock" \
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
python3 "$ROOT/image/copy-closure.py" "$SYSROOT" "$STAGE" \
  "$SYSROOT/usr/bin/weston:/usr/bin/weston" \
  "$SYSROOT/usr/sbin/seatd:/usr/sbin/seatd" \
  "$SYSROOT/usr/lib/systemd/systemd-udevd:/usr/lib/systemd/systemd-udevd" \
  "$SYSROOT/usr/bin/udevadm:/usr/bin/udevadm" \
  "$SYSROOT/usr/lib/x86_64-linux-gnu/libweston-13/drm-backend.so:/usr/lib/x86_64-linux-gnu/libweston-13/drm-backend.so" \
  "$SYSROOT/usr/lib/x86_64-linux-gnu/weston/desktop-shell.so:/usr/lib/x86_64-linux-gnu/weston/desktop-shell.so" \
  "$SYSROOT/usr/libexec/weston-desktop-shell:/usr/libexec/weston-desktop-shell" \
  "$SYSROOT/usr/libexec/weston-keyboard:/usr/libexec/weston-keyboard" \
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
  "$BUILD_TMP/sevyn-statusd:/usr/local/bin/sevyn-statusd" \
  "$BUILD_TMP/sevyn-status-client:/usr/local/bin/sevyn-status-client" \
  "$BUILD_TMP/sevyn-loader:/usr/local/bin/sevyn-loader" \
  "$BUILD_TMP/sevyn-appd:/usr/local/bin/sevyn-appd" \
  "$BUILD_TMP/sevyn-aid:/usr/local/bin/sevyn-aid" \
  "$BUILD_TMP/sevyn-updated:/usr/local/bin/sevyn-updated" \
  "$BUILD_TMP/sevyn:/usr/local/bin/sevyn" \
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
for f in files terminal browser settings music photos calendar notes calculator camera messages store video-calls voice-calls installer tokrah; do
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
# Tokrah (M6): the raw hbc (what `sevyn tokrah run` falls back to) and
# the mock API server for the check (started by init only with
# sevyn.mockapi=1 on the kernel cmdline).
cp "$BUILD_TMP/tokrah-staged.hbc" "$STAGE/usr/share/sevyn/tokrah/tokrah.hbc"
cp "$BUILD_TMP/tokrah-mock/mock-api.js" "$STAGE/usr/share/sevyn/tokrah-mock/mock-api.js"
cp -r "$BUILD_TMP/tokrah-mock/node_modules" "$STAGE/usr/share/sevyn/tokrah-mock/node_modules"

# The AI connector (M4.5): the grant + the stub backends. The
# backends are plain executables; their ids are their filenames.
# (cp -a keeps the +x bit the daemon's scan requires.)
cp -a "$ROOT/ai/backends/"* "$STAGE/usr/share/sevyn/ai/backends/"
cp "$ROOT/ai/grant.json" "$STAGE/usr/share/sevyn/ai/grant.json"

# Sevyn Code: the extracted code-server tree, plus the terminal
# default (the integrated terminal spawns `sevyn` with no args, so
# the REPL mode is what it gets). The settings file is the config the
# M4 harness reads back through `sevyn files cat`.
cp -a "$CODE_SERVER_DIR/." "$STAGE/usr/share/sevyn/code-server/"
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
mkdir -p "$STAGE/etc/ssl" "$STAGE/etc/fonts"
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

# Data Weston and its stack load with dlopen / by path (not via ldd).
for d in \
  "usr/lib/x86_64-linux-gnu/weston" \
  "usr/lib/x86_64-linux-gnu/gbm" \
  "usr/lib/x86_64-linux-gnu/dri" \
  "usr/lib/udev/rules.d" \
  "usr/share/weston" \
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
for d in "$SYSROOT"/usr/lib/x86_64-linux-gnu/libweston-*; do
  if [ -d "$d" ]; then
    rel="usr/lib/x86_64-linux-gnu/$(basename "$d")"
    mkdir -p "$STAGE/usr/lib/x86_64-linux-gnu"
    cp -a "$d" "$STAGE/$rel"
  fi
done
# Weston 13's GL renderer is a loadable module, NOT built into
# libweston — the pixman renderer IS built in, which is why the
# pixman fallback always works while GL never starts. The
# libweston-* dir copy above should have brought it, but the
# b8956218 guest proved it absent — weston.log: "Failed to load
# module: .../libweston-13/gl-renderer.so: cannot open shared
# object file" → "failed to initialize egl" → "fatal: failed to
# create compositor backend". Stage it explicitly (it ships in
# libweston-13-0) and fail loudly without it.
[ -f "$SYSROOT/usr/lib/x86_64-linux-gnu/libweston-13/gl-renderer.so" ] || { echo "error: missing gl-renderer.so (install libweston-13-0)" >&2; exit 1; }
cp "$SYSROOT/usr/lib/x86_64-linux-gnu/libweston-13/gl-renderer.so" "$STAGE/usr/lib/x86_64-linux-gnu/libweston-13/gl-renderer.so"
mkdir -p "$STAGE/usr/share/icons"
if [ -d "$SYSROOT/usr/share/icons/Adwaita" ]; then
  mkdir -p "$STAGE/usr/share/icons/Adwaita"
  cp -a "$SYSROOT/usr/share/icons/Adwaita/cursors" "$STAGE/usr/share/icons/Adwaita/" 2>/dev/null || true
  cp -a "$SYSROOT/usr/share/icons/Adwaita/index.theme" "$STAGE/usr/share/icons/Adwaita/" 2>/dev/null || true
fi
if [ -f "$SYSROOT/usr/share/icons/default/index.theme" ]; then
  mkdir -p "$STAGE/usr/share/icons/default"
  cp -a "$SYSROOT/usr/share/icons/default/index.theme" "$STAGE/usr/share/icons/default/"
fi

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
# Installer v2: usb-storage + uas + sd_mod — the USB storage stack.
# Without them the live system cannot see a USB disk at all (no
# /dev/sd*, no /sys/block/sda): the portable install target is
# unprovable in QEMU and unusable on real hardware. xhci-hcd is
# built into the kernel; xhci-pci was already staged. The dep
# closure (scsi_mod) resolves via modinfo.
python3 "$ROOT/image/stage-modules.py" "$SYSROOT" "$kernel_version" "$STAGE" \
  virtio-gpu usbhid hid-generic xhci-pci virtio-blk virtio-net ext4 \
  i915 iwlwifi iwlmvm mac80211 cfg80211 nvme alx \
  snd-hda-intel snd-hda-codec-realtek snd-hda-codec-generic snd-hda-codec-hdmi \
  i2c-hid-acpi i2c-hid hid-multitouch intel-lpss-pci \
  nls_iso8859-1 nls_utf8 \
  usb-storage uas sd_mod

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
ldconfig -r "$STAGE" 2>/dev/null || echo "warning: ldconfig -r failed (continuing)" >&2

cp "$ROOT/image/weston.ini" "$STAGE/etc/xdg/weston/weston.ini"

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
echo "SevynOS v2 - M11 image (compositor + RN shell + app runtime + system updates + system apps + Sevyn Code + AI connector + connectivity + Chromium browser + bare-metal boot + desktop polish + dual-boot installer)"
# M11: /usr/sbin (the wifi PATH fix — the daemon spawns
# wpa_supplicant/wpa_cli by bare name, and they live in /usr/sbin).
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin
export XDG_RUNTIME_DIR=/run
export WAYLAND_DISPLAY=wayland-0
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
# for the booted slot before Weston or the shell can fail, and marks
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
# App daemon next: seeds the registry from pristine on first boot and
# owns /run/sevyn-apps.sock. The shell connects to it for its dock
# list and launches; the harness drives it over /dev/ttyS2.
# Tokrah mock API (M6): a test double, never a system service — it
# starts ONLY when the kernel cmdline carries sevyn.mockapi=1 (the
# M6 check boots with it). It serves the M6 mock Tokrah API on
# 127.0.0.1:7070 from the code-server node binary, logging every
# request/socket event to the console (MOCK_LOG=1) so the harness can
# grep the serial log for the wire.
for a in $(cat /proc/cmdline); do case "$a" in sevyn.mockapi=*) MOCKAPI=${a#sevyn.mockapi=};; esac; done
if [ "${MOCKAPI:-0}" = "1" ]; then
  MOCK_LOG=1 /usr/share/sevyn/code-server/lib/node /usr/share/sevyn/tokrah-mock/mock-api.js >/dev/console 2>&1 &
  echo "M6 init: tokrah mock API started (sevyn.mockapi=1)"
fi
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
# Sevyn Code (M4): code-server serves the IDE on 127.0.0.1:8080
# (localhost only — the browser that paints it arrives in M5). It
# needs HOME for its user-data dir (the staged settings file lives
# under /root/.local/share/code-server). --auth none: the IDE is local
# only; auth arrives with the browser milestone. The pid file is what
# `sevyn code status` reads for "running".
export HOME=/root
/usr/share/sevyn/code-server/bin/code-server --auth none --disable-telemetry --disable-update-check --bind-addr 127.0.0.1:8080 >/tmp/code-server.log 2>&1 &
echo $! > /run/code-server.pid
# Seat daemon: Weston (as root) opens DRM + input devices through it.
/usr/sbin/seatd &
echo "M4 init: starting weston @ $(cut -d" " -f1 /proc/uptime)s"
# --socket=wayland-0 is REQUIRED, not cosmetic: without --socket Weston
# ignores WAYLAND_DISPLAY and picks the first free wayland-N name starting
# at wayland-1, so the socket would land at /run/wayland-1 while this init
# and the shell host both wait on /run/wayland-0 (the M1 failure mode).
# CPU-only software GL (M12, Kevon 2026-11-13: SevynOS must run on
# CPU-only devices): this image has no 3D-capable GPU — virtio-gpu
# exposes dumb scanout buffers only (no virgl) — so Mesa must use its
# software driver. LIBGL_ALWAYS_SOFTWARE makes Mesa's loader pick
# swrast (llvmpipe) for every EGL/GBM context: Weston's GL renderer
# and the host's EGL presenter both render in software into the
# virtio-gpu dumb buffers, which is exactly the shape a real CPU-only
# machine has (basic display controller, no GPU). The virgl route is
# dead in CI: -display egl-headless needs a host DRM render node and
# GitHub runners have none (QEMU fails to start: "egl: no drm render
# node available"). On hardware WITH a real GPU the nightly's init
# must not set this unconditionally — it is the CPU-only path.
export LIBGL_ALWAYS_SOFTWARE=1
# M12 Genesis: Mesa's loader picks the DRI driver from the DRM
# device's kernel name — virtio-gpu maps to virtio_gpu_dri.so (the
# virgl driver), which cannot create a screen with no virgl cap
# sets, so eglGetDisplay returns EGL_NO_DISPLAY ("failed to create
# display" in weston.log) and GL never starts. LIBGL_ALWAYS_SOFTWARE
# does NOT change which driver binary loads, so it cannot fix this.
# MESA_LOADER_DRIVER_OVERRIDE=kms_swrast forces Mesa's software
# rasterizer for KMS devices (llvmpipe rendering into the
# virtio-gpu dumb buffers) — the driver this CPU-only path needs.
export MESA_LOADER_DRIVER_OVERRIDE=kms_swrast
# M12 diagnostic (probe, not a fix): the kms_swrast override changed
# nothing on c89c989d — two identical failures, no llvmpipe, no
# MESA-LOADER line — so make the driver selection VISIBLE instead of
# guessing again. Echo the env + prove the driver files are actually
# staged in the image, and turn on EGL/Mesa debug logging so the
# weston.log dump shows which driver Mesa loads and where
# eglGetDisplay fails. Remove once the path is understood.
# 4fb2439a verdict: env + staging CONFIRMED, but EGL_LOG_LEVEL/MESA_DEBUG
# printed NOTHING — Mesa stays silent on the driver-load success path,
# so the debug knobs cannot answer "which driver". The decisive
# instrument is the dynamic linker: LD_DEBUG=libs, scoped to the GL
# Weston launch only (an export would flood the whole boot), prints
# every .so Weston dlopens to the console, including which dri/*.so
# Mesa actually opens (kms_swrast vs virtio_gpu). The echo below now
# runs AFTER the exports (it previously ran before them, so it always
# printed EGL_LOG_LEVEL=<unset> even when the export worked).
export EGL_LOG_LEVEL=debug
export MESA_DEBUG=1
echo "GENESIS mesa env: MESA_LOADER_DRIVER_OVERRIDE=${MESA_LOADER_DRIVER_OVERRIDE:-<unset>} LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-<unset>} EGL_LOG_LEVEL=${EGL_LOG_LEVEL:-<unset>} MESA_DEBUG=${MESA_DEBUG:-<unset>}"
ls -l /usr/lib/x86_64-linux-gnu/dri/kms_swrast_dri.so /usr/lib/x86_64-linux-gnu/dri/virtio_gpu_dri.so /usr/lib/x86_64-linux-gnu/dri/swrast_dri.so 2>&1
# M12 Genesis: try the GL renderer first (GPU compositing); fall back
# to pixman if Weston cannot start on GL, so a GPU failure can never
# brick the boot. The active renderer is logged to the console for
# the M12 check (which FAILS if the fallback engaged — QEMU must
# prove GL init works via llvmpipe, forced by LIBGL_ALWAYS_SOFTWARE
# above, since there is no 3D device in this image).
GENESIS_RENDERER=gl
LD_DEBUG=libs /usr/bin/weston --backend=drm-backend.so --renderer=gl --socket=wayland-0 \
  --config=/etc/xdg/weston/weston.ini --log=/tmp/weston.log &
WESTON_PID=$!
i=0
while [ ! -S /run/wayland-0 ] && kill -0 "$WESTON_PID" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
if [ ! -S /run/wayland-0 ]; then
  echo "GENESIS weston GL renderer failed to start; falling back to pixman"
  kill "$WESTON_PID" 2>/dev/null
  sleep 1
  # Save the GL attempt's weston log before the pixman fallback
  # overwrites it: --log=/tmp/weston.log is shared, and /tmp is
  # tmpfs (lost on shutdown), so without this the GL failure's
  # reason never reaches any artifact. /data/logs rides the data
  # disk (in the CI artifact); the console dump puts it in the
  # boot log the check reads first.
  cp /tmp/weston.log /data/logs/weston-gl.log 2>/dev/null || true
  echo "--- weston GL attempt log (/tmp/weston.log) ---"
  cat /tmp/weston.log 2>/dev/null || echo "(no weston log)"
  GENESIS_RENDERER=pixman
  /usr/bin/weston --backend=drm-backend.so --renderer=pixman --socket=wayland-0 \
    --config=/etc/xdg/weston/weston.ini --log=/tmp/weston.log &
fi
i=0
while [ ! -S /run/wayland-0 ] && [ "$i" -lt 1800 ]; do sleep 0.1; i=$((i + 1)); done
echo "GENESIS weston renderer=$GENESIS_RENDERER"
if [ ! -S /run/wayland-0 ]; then
  echo "M4 init: Wayland socket never appeared; weston log:"
  cat /tmp/weston.log 2>/dev/null || echo "(no weston log)"
  exec /bin/busybox poweroff -f
fi
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
/usr/local/bin/sevyn-rn-host 2>/tmp/sevyn-host.log &
HOST_PID=$!
# If the host dies, dump weston + host logs to the console (the serial
# the harness captures) so a blank screen is diagnosable from the
# artifacts instead of a silent exit: libwayland prints the protocol
# error to the host's stderr, Weston prints its side to weston.log.
(while kill -0 "$HOST_PID" 2>/dev/null; do sleep 0.5; done
 echo "--- sevyn-host died; weston.log ---"
 cat /tmp/weston.log 2>/dev/null || echo "(no weston log)"
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
  exec /bin/busybox poweroff -f
fi
echo "SEVYNOS_M2_READY"
# Sevyn Code must be serving before the harness starts driving the
# Terminal: give it up to 10 s to answer on its port. A failure here
# does NOT fail the boot — the M4 check asserts code status
# separately, with the server log as the diagnostic.
CODE_OK=0
i=0
while [ "$i" -lt 100 ]; do
  if wget -qO- http://127.0.0.1:8080/ 2>/dev/null | grep -q codeServerVersion; then CODE_OK=1; break; fi
  sleep 0.1
  i=$((i + 1))
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
# Stay alive; the harness powers us off via the status daemon.
while true; do sleep 3600; done
EOF
chmod +x "$STAGE/init"

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
  --out "$OUT/sevynos.img" \
  || { echo "error: disk image build failed" >&2; exit 1; }

echo "Built M11 image in $OUT (kernel $kernel_version, OS version $os_version)"
ls -l "$OUT"
