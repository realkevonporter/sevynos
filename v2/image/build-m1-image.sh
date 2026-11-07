#!/bin/sh
# Build the SevynOS v2 M1 image: kernel + initramfs with a Wayland
# compositor (Weston), the M1 test client, and the status service.
#
# M1 is the compositor + input + live-status milestone. The image boots to
# a Weston desktop with one test window (two click targets) and a status
# daemon that pushes battery/wifi/volume changes to subscribers. The host
# harness (v2/image/m1-check.mjs) proves: a surface is on screen, the
# cursor moves, clicks land on the intended surface, keys reach the
# focused surface, and status changes arrive as pushed events.
#
# The compositor is upstream Weston, not SevynOS code: it is the boring
# display/input layer, the same category as the Linux kernel — separable
# and replaceable, per the layered architecture. SevynOS's own shell
# arrives in M2, on top of this layer.
#
# Requirements: a kernel in /boot (linux-image-generic), busybox-static,
# cpio, gcc, pkg-config, libwayland-dev, wayland-protocols, weston, seatd.
# SEVYN_V2_SYSROOT (default /) is the tree the packages are copied from:
# on CI it is the runner itself; locally it is the extracted-deb sysroot.
# Outputs (SEVYN_V2_BUILD_DIR, default v2/image/build/):
#   vmlinuz, initramfs.cpio.gz, kernel-version.txt
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="${SEVYN_V2_SYSROOT:-/}"
OUT="${SEVYN_V2_BUILD_DIR:-$ROOT/image/build}"

# When building against an extracted-deb sysroot (local testing), its bin
# dirs hold tools the host may not have (cpio, busybox). Prefer them, fall
# back to the host PATH. On CI (SYSROOT=/) this is a no-op.
if [ "$SYSROOT" != "/" ]; then
  PATH="$SYSROOT/usr/bin:$SYSROOT/bin:$SYSROOT/usr/sbin:$SYSROOT/sbin:$PATH"
  export PATH
fi

# Newest readable non-Azure kernel (same selection as M0: the runner's own
# kernel can be host-specific and root-only; this script runs under sudo).
# SEVYN_V2_KERNEL overrides the search (local testing against a sysroot
# kernel, where /boot has no usable kernel).
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

for tool in busybox cpio gcc pkg-config wayland-scanner python3 zstd modinfo; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool not found" >&2
    exit 1
  }
done
# busybox is resolved from the sysroot below (it is not on the host PATH
# in local testing); the build fails there if it cannot be found.
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

# --- compile the SevynOS programs ---------------------------------------
wayland-scanner client-header \
  "$SYSROOT/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml" \
  "$BUILD_TMP/xdg-shell-client-protocol.h"
wayland-scanner private-code \
  "$SYSROOT/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml" \
  "$BUILD_TMP/xdg-shell-protocol.c"

gcc -O2 -Wall -o "$BUILD_TMP/sevyn-test-client" \
  "$ROOT/compositor/test-client.c" "$BUILD_TMP/xdg-shell-protocol.c" \
  -I"$BUILD_TMP" $(pkg-config --cflags --libs wayland-client)
gcc -O2 -Wall -o "$BUILD_TMP/sevyn-statusd" "$ROOT/services/statusd.c"
gcc -O2 -Wall -o "$BUILD_TMP/sevyn-status-client" "$ROOT/services/status-client.c"

# --- stage the rootfs ----------------------------------------------------
mkdir -p "$STAGE/bin" "$STAGE/proc" "$STAGE/sys" "$STAGE/dev" "$STAGE/run" \
         "$STAGE/tmp" "$STAGE/etc/xdg/weston" "$STAGE/usr/local/bin"

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

# Binaries + their shared-library closure (from the sysroot). The backend
# and shell .so files are dlopen'd by Weston, so their NEEDED libraries
# are not in weston's own closure — list them explicitly.
python3 "$ROOT/image/copy-closure.py" "$SYSROOT" "$STAGE" \
  "$SYSROOT/usr/bin/weston:/usr/bin/weston" \
  "$SYSROOT/usr/sbin/seatd:/usr/sbin/seatd" \
  "$SYSROOT/usr/lib/systemd/systemd-udevd:/usr/lib/systemd/systemd-udevd" \
  "$SYSROOT/usr/bin/udevadm:/usr/bin/udevadm" \
  "$SYSROOT/usr/lib/x86_64-linux-gnu/libweston-13/drm-backend.so:/usr/lib/x86_64-linux-gnu/libweston-13/drm-backend.so" \
  "$SYSROOT/usr/lib/x86_64-linux-gnu/weston/desktop-shell.so:/usr/lib/x86_64-linux-gnu/weston/desktop-shell.so" \
  "$SYSROOT/usr/libexec/weston-desktop-shell:/usr/libexec/weston-desktop-shell" \
  "$SYSROOT/usr/libexec/weston-keyboard:/usr/libexec/weston-keyboard" \
  "$BUILD_TMP/sevyn-test-client:/usr/local/bin/sevyn-test-client" \
  "$BUILD_TMP/sevyn-statusd:/usr/local/bin/sevyn-statusd" \
  "$BUILD_TMP/sevyn-status-client:/usr/local/bin/sevyn-status-client"

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
# Weston backend modules live in libweston-<version>/ (not weston/).
for d in "$SYSROOT"/usr/lib/x86_64-linux-gnu/libweston-*; do
  if [ -d "$d" ]; then
    rel="usr/lib/x86_64-linux-gnu/$(basename "$d")"
    mkdir -p "$STAGE/usr/lib/x86_64-linux-gnu"
    cp -a "$d" "$STAGE/$rel"
  fi
done
# Cursor theme (Weston draws the pointer from the XCursor theme).
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

# Kernel modules the Ubuntu generic kernel builds as modules and the
# compositor/input stack needs: virtio-gpu (DRM device) + the USB HID
# stack (usb-tablet pointer). See v2/image/stage-modules.py.
python3 "$ROOT/image/stage-modules.py" "$SYSROOT" "$kernel_version" "$STAGE" \
  virtio-gpu usbhid hid-generic xhci-pci

# ld.so configuration + cache, so the loader finds the multiarch lib dirs.
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
echo "SevynOS v2 - M1 image (compositor + input + live status)"
export XDG_RUNTIME_DIR=/run
export WAYLAND_DISPLAY=wayland-0
# Kernel modules the generic kernel builds as modules: virtio-gpu (the DRM
# device) and the USB HID stack (the usb-tablet pointer). Load them in
# dependency order before anything needs them.
echo "M1 init: modules start @ $(cut -d" " -f1 /proc/uptime)s"
for mod in $(cat "/lib/modules/$(uname -r)/sevyn-modules.txt" 2>/dev/null); do
  /bin/busybox insmod "$mod" || echo "M1 init: insmod $mod failed"
done
echo "M1 init: modules done @ $(cut -d" " -f1 /proc/uptime)s"
ls /dev/dri/ 2>/dev/null || echo "M1 init: no /dev/dri (virtio-gpu module missing?)"
# Device manager: Weston/libinput discover input devices through udev
# properties (ID_INPUT, seat tags). devtmpfs creates the nodes, but
# without a udev daemon nothing tags them, so Weston finds no input
# devices. Start udevd, wait for the tablet's event node, replay + settle.
# (The tablet enumerates asynchronously after xhci-pci loads.)
/usr/lib/systemd/systemd-udevd &
echo "M1 init: udevd started @ $(cut -d" " -f1 /proc/uptime)s"
i=0
while [ ! -e /dev/input/event2 ] && [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
echo "M1 init: event2 seen @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm trigger --action=add 2>/dev/null || echo "M1 init: udevadm trigger failed"
echo "M1 init: trigger done @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/udevadm settle --timeout=10 2>/dev/null || echo "M1 init: udevadm settle timed out"
echo "M1 init: settle done @ $(cut -d" " -f1 /proc/uptime)s"
ls -la /dev/input/ 2>/dev/null || echo "M1 init: no /dev/input (no input devices?)"
# Status service first: everything else subscribes to it.
/usr/local/bin/sevyn-statusd &
# Seat daemon: Weston (as root) opens DRM + input devices through it.
/usr/sbin/seatd &
# Compositor: DRM backend on virtio-gpu, pixman renderer (no GL needed).
echo "M1 init: starting weston @ $(cut -d" " -f1 /proc/uptime)s"
# Real compositor: DRM backend on virtio-gpu, pixman renderer (no GL needed).
# --socket=wayland-0 is REQUIRED, not cosmetic: without --socket Weston
# ignores WAYLAND_DISPLAY and picks the first free wayland-N name starting
# at wayland-1 (weston 13 main.c: weston_create_listening_socket), so the
# socket would land at /run/wayland-1 while this init and the test client
# both wait on /run/wayland-0 — the exact failure that killed the first
# M1 check runs (Weston up, socket never seen, 180s wait, poweroff).
echo "M1 init: launching weston @ $(cut -d" " -f1 /proc/uptime)s"
/usr/bin/weston --backend=drm-backend.so --renderer=pixman --socket=wayland-0 \
  --config=/etc/xdg/weston/weston.ini --log=/tmp/weston.log &
# Wait for the Wayland socket.
i=0
while [ ! -S /run/wayland-0 ] && [ "$i" -lt 1800 ]; do sleep 0.1; i=$((i + 1)); done
if [ ! -S /run/wayland-0 ]; then
  echo "M1 init: Wayland socket never appeared; weston log:"
  cat /tmp/weston.log 2>/dev/null || echo "(no weston log)"
  exec /bin/busybox poweroff -f
fi
# Test client (two click targets) + status subscriber.
/usr/local/bin/sevyn-test-client &
/usr/local/bin/sevyn-status-client &
# Wait for the client to report its surfaces are up.
i=0
while ! grep -q "M1CLIENT READY" /tmp/sevyn-m1-client.log 2>/dev/null && [ "$i" -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
echo "SEVYNOS_M1_READY"
# Stay alive; the harness powers us off via the status daemon.
while true; do sleep 3600; done
EOF
chmod +x "$STAGE/init"

(cd "$STAGE" && find . | cpio -o -H newc 2>/dev/null | gzip -9 >"$OUT/initramfs.cpio.gz")

echo "Built M1 image in $OUT (kernel $kernel_version)"
ls -l "$OUT"
