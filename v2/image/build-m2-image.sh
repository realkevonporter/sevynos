#!/bin/sh
# Build the SevynOS v2 M2 image: kernel + initramfs with Weston, the
# status service, and the React Native shell host (Hermes + Yoga +
# Wayland + CPU raster) running the shell bundle.
#
# M2 is the shell milestone: the image boots to the SevynOS shell (top
# bar + live status tray, main area, dock with 12 apps). The host
# harness (v2/image/m2-check.mjs) proves: the shell surface is on
# screen, the dock never overflows at 12 apps and scrolls, clicking a
# launcher icon logs LAUNCH <appId> and shows "Starting…", the status
# tray updates on a pushed change, and keyboard Tab/Enter activates the
# focused control.
#
# Structure mirrors build-m1-image.sh (kernel selection, staging,
# modules, weston.ini); the M1 test client is replaced by the RN host
# + shell bundle. The M1 image is untouched.
#
# Requirements (on top of the M1 list): cmake, node (for the shell
# bundle build), libfreetype-dev, libpng-dev, libwayland-dev.
# The Hermes/Yoga deps are built by v2/rn/host/build-deps.sh into
# v2/rn/host/deps (SEVYN_V2_DEPS_DIR); this script runs it if the
# marker is absent. CI caches that dir (see .github/workflows/v2-m2.yml).
# Outputs (SEVYN_V2_BUILD_DIR, default v2/image/build/):
#   vmlinuz, initramfs.cpio.gz, kernel-version.txt
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

for tool in busybox cpio gcc g++ pkg-config wayland-scanner python3 zstd modinfo cmake node npm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool not found" >&2
    exit 1
  }
done
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
g++ -O2 -std=c++17 -Wall -Wextra \
  -I"$ROOT/rn/host" -I"$BUILD_TMP" \
  -I"$PREFIX/include" -I"$HERMES_SRC/public" \
  $(pkg-config --cflags wayland-client freetype2 libpng) \
  -o "$BUILD_TMP/sevyn-rn-host" \
  "$ROOT/rn/host/common.cc" "$ROOT/rn/host/painter.cc" \
  "$ROOT/rn/host/wayland.cc" "$ROOT/rn/host/status.cc" \
  "$ROOT/rn/host/yoga-bridge.cc" "$ROOT/rn/host/sevyn-rn-host.cc" \
  "$BUILD_TMP/xdg-shell-protocol.o" \
  -Wl,--start-group $HERMES_LIBS "$PREFIX/lib/libyogacore.a" -Wl,--end-group \
  $(pkg-config --libs wayland-client freetype2 libpng) $(pkg-config --libs icu-uc icu-i18n) -lpthread -ldl

# --- build the shell bundle ------------------------------------------------
# npm ci (frozen lockfile) + esbuild bundle + hermesc bytecode. The
# bundle is the only JS in the image; there is no Node at runtime.
SHELL_DIR="$ROOT/shell"
if [ ! -d "$SHELL_DIR/node_modules" ]; then
  (cd "$SHELL_DIR" && npm ci --no-audit --no-fund)
fi
(cd "$SHELL_DIR" && node build-shell.mjs --hermesc "$PREFIX/bin/hermesc" --out "$BUILD_TMP/shell-dist")
[ -f "$BUILD_TMP/shell-dist/shell.hbc" ] || { echo "error: shell.hbc not built" >&2; exit 1; }

# --- stage the rootfs ------------------------------------------------------
mkdir -p "$STAGE/bin" "$STAGE/proc" "$STAGE/sys" "$STAGE/dev" "$STAGE/run" \
         "$STAGE/tmp" "$STAGE/etc/xdg/weston" "$STAGE/usr/local/bin" \
         "$STAGE/usr/share/sevyn/shell"

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

# Binaries + their shared-library closure (from the sysroot). The host
# binary is included so its runtime libs (wayland-client, freetype,
# libpng) are staged with it.
python3 "$ROOT/image/copy-closure.py" "$SYSROOT" "$STAGE" \
  "$SYSROOT/usr/bin/weston:/usr/bin/weston" \
  "$SYSROOT/usr/sbin/seatd:/usr/sbin/seatd" \
  "$SYSROOT/usr/lib/systemd/systemd-udevd:/usr/lib/systemd/systemd-udevd" \
  "$SYSROOT/usr/bin/udevadm:/usr/bin/udevadm" \
  "$SYSROOT/usr/lib/x86_64-linux-gnu/libweston-13/drm-backend.so:/usr/lib/x86_64-linux-gnu/libweston-13/drm-backend.so" \
  "$SYSROOT/usr/lib/x86_64-linux-gnu/weston/desktop-shell.so:/usr/lib/x86_64-linux-gnu/weston/desktop-shell.so" \
  "$SYSROOT/usr/libexec/weston-desktop-shell:/usr/libexec/weston-desktop-shell" \
  "$SYSROOT/usr/libexec/weston-keyboard:/usr/libexec/weston-keyboard" \
  "$BUILD_TMP/sevyn-statusd:/usr/local/bin/sevyn-statusd" \
  "$BUILD_TMP/sevyn-status-client:/usr/local/bin/sevyn-status-client" \
  "$BUILD_TMP/sevyn-rn-host:/usr/local/bin/sevyn-rn-host"

cp "$BUILD_TMP/shell-dist/shell.hbc" "$STAGE/usr/share/sevyn/shell/shell.hbc"

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
for d in "$SYSROOT"/usr/lib/x86_64-linux-gnu/libweston-*; do
  if [ -d "$d" ]; then
    rel="usr/lib/x86_64-linux-gnu/$(basename "$d")"
    mkdir -p "$STAGE/usr/lib/x86_64-linux-gnu"
    cp -a "$d" "$STAGE/$rel"
  fi
done
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

python3 "$ROOT/image/stage-modules.py" "$SYSROOT" "$kernel_version" "$STAGE" \
  virtio-gpu usbhid hid-generic xhci-pci

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
mkdir -p /run /tmp
echo "SevynOS v2 - M2 image (compositor + RN shell)"
export XDG_RUNTIME_DIR=/run
export WAYLAND_DISPLAY=wayland-0
echo "M2 init: modules start @ $(cut -d" " -f1 /proc/uptime)s"
for mod in $(cat "/lib/modules/$(uname -r)/sevyn-modules.txt" 2>/dev/null); do
  /bin/busybox insmod "$mod" || echo "M2 init: insmod $mod failed"
done
echo "M2 init: modules done @ $(cut -d" " -f1 /proc/uptime)s"
ls /dev/dri/ 2>/dev/null || echo "M2 init: no /dev/dri (virtio-gpu module missing?)"
/usr/lib/systemd/systemd-udevd &
echo "M2 init: udevd started @ $(cut -d" " -f1 /proc/uptime)s"
i=0
while [ ! -e /dev/input/event2 ] && [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
echo "M2 init: event2 seen @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm trigger --action=add 2>/dev/null || echo "M2 init: udevadm trigger failed"
echo "M2 init: trigger done @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm settle --timeout=10 2>/dev/null || echo "M2 init: udevadm settle timed out"
echo "M2 init: settle done @ $(cut -d" " -f1 /proc/uptime)s"
ls -la /dev/input/ 2>/dev/null || echo "M2 init: no /dev/input (no input devices?)"
# Status service first: the shell subscribes to it.
/usr/local/bin/sevyn-statusd &
# Seat daemon: Weston (as root) opens DRM + input devices through it.
/usr/sbin/seatd &
echo "M2 init: starting weston @ $(cut -d" " -f1 /proc/uptime)s"
# --socket=wayland-0 is REQUIRED, not cosmetic: without --socket Weston
# ignores WAYLAND_DISPLAY and picks the first free wayland-N name starting
# at wayland-1, so the socket would land at /run/wayland-1 while this init
# and the shell host both wait on /run/wayland-0 (the M1 failure mode).
/usr/bin/weston --backend=drm-backend.so --renderer=pixman --socket=wayland-0 \
  --config=/etc/xdg/weston/weston.ini --log=/tmp/weston.log &
i=0
while [ ! -S /run/wayland-0 ] && [ "$i" -lt 1800 ]; do sleep 0.1; i=$((i + 1)); done
if [ ! -S /run/wayland-0 ]; then
  echo "M2 init: Wayland socket never appeared; weston log:"
  cat /tmp/weston.log 2>/dev/null || echo "(no weston log)"
  exec /bin/busybox poweroff -f
fi
# The shell host: Hermes + Yoga + Wayland + CPU raster. Its logLine
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
# bundle evaluates).
i=0
while ! grep -q "SEVYNOS_M2_READY" /tmp/sevyn-host.log 2>/dev/null && [ "$i" -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
if ! grep -q "SEVYNOS_M2_READY" /tmp/sevyn-host.log 2>/dev/null; then
  echo "M2 init: shell host never became ready; host log:"
  cat /tmp/sevyn-host.log 2>/dev/null || echo "(no host log)"
  exec /bin/busybox poweroff -f
fi
echo "SEVYNOS_M2_READY"
# Stay alive; the harness powers us off via the status daemon.
while true; do sleep 3600; done
EOF
chmod +x "$STAGE/init"

(cd "$STAGE" && find . | cpio -o -H newc 2>/dev/null | gzip -9 >"$OUT/initramfs.cpio.gz")

echo "Built M2 image in $OUT (kernel $kernel_version)"
ls -l "$OUT"
