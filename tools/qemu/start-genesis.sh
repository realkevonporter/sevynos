#!/bin/sh
set -eu
runtime_dir=/run/sevynos
mkdir -p "$runtime_dir" /var/lib/sevynos
chmod 700 "$runtime_dir"
export XDG_RUNTIME_DIR="$runtime_dir"
export WAYLAND_DISPLAY=wayland-0
export SEVYN_WAYLAND_BRIDGE=/usr/local/bin/sevyn-wayland-bridge
export SEVYN_STATE_DIRECTORY=/var/lib/sevynos
export SEVYN_FONT_ATLAS=/usr/local/share/sevynos/font-atlas.json
if [ ! -f "$SEVYN_FONT_ATLAS" ]; then
  SEVYN_FONT_ATLAS="$runtime_dir/font-atlas.json"
  python3 /usr/local/lib/sevynos/build-font-atlas.py "$SEVYN_FONT_ATLAS" 2>/dev/null || true
  export SEVYN_FONT_ATLAS
fi
case " $(cat /proc/cmdline) " in
  *" sevyn.focus-trace=1 "*)
    export SEVYN_FOCUS_TRACE=1
    echo SEVYN_QEMU_FOCUS_TRACE_ENABLED
    ;;
esac
case " $(cat /proc/cmdline) " in
  *" sevyn.hittest-probe=1 "*)
    export SEVYN_HITTEST_PROBE=1
    echo SEVYN_HITTEST_PROBE_ENABLED
    ;;
esac
echo $$ > "$runtime_dir/start-genesis.pid"

# Inhibit Linux virtual terminal switching (Ctrl+Alt+Fx)
if command -v python3 >/dev/null 2>&1; then
  python3 -c "
import fcntl, os
for dev in ['/dev/tty0', '/dev/tty1', '/dev/tty']:
    if os.path.exists(dev):
        try:
            with open(dev, 'wb', buffering=0) as f:
                fcntl.ioctl(f.fileno(), 0x560B, 1)
        except Exception:
            pass
" 2>/dev/null || true
fi

log_marker() {
  echo "$1"
  if [ -c /dev/ttyS0 ]; then
    echo "$1" > /dev/ttyS0 2>/dev/null || true
  fi
}

echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
echo "contents of /dev/dri:"
ls -la /dev/dri || true
echo "contents of /run/user/0:"
ls -la /run/user/0 || true

output_mode=1280x720
for modes_path in /sys/class/drm/card*-*/modes; do
  if [ -f "$modes_path" ]; then
    detected_mode=$(sed -n '1p' "$modes_path")
    if [ -n "$detected_mode" ]; then
      output_mode=$detected_mode
      break
    fi
  fi
done
output_width=${output_mode%x*}
output_height=${output_mode#*x}
echo "QEMU/WESTON OUTPUT SIZE width=$output_width height=$output_height source=drm-connector"

if grep -q 'sevyn.headless=1' /proc/cmdline; then
  weston_backend=headless-backend.so
  weston_shell=desktop-shell.so
else
  weston_backend=drm-backend.so
  weston_shell=kiosk-shell.so
fi
if [ "$weston_backend" = "drm-backend.so" ]; then
  safe_graphics=0
  case " $(cat /proc/cmdline) " in
    *" nomodeset "*|*" sevyn.gpu=0 "*|*" sevyn.safe-graphics=1 "*) safe_graphics=1 ;;
  esac
  gpu_active=0
  if [ "$safe_graphics" -eq 0 ] && ls /dev/dri/card* >/dev/null 2>&1; then
    echo "Attempting Weston launch with GPU hardware acceleration (DRM/GBM/EGL)..."
    weston --backend="$weston_backend" --shell="$weston_shell" --tty=1 --socket="$WAYLAND_DISPLAY" --idle-time=0 --log=/var/log/weston-gpu.log < /dev/tty1 &
    weston_pid=$!
    attempt=0
    while [ "$attempt" -lt 250 ]; do
      if [ -S "$runtime_dir/$WAYLAND_DISPLAY" ]; then
        gpu_active=1
        break
      fi
      if ! kill -0 "$weston_pid" 2>/dev/null; then
        echo "Weston with GPU hardware acceleration exited"
        break
      fi
      attempt=$((attempt + 1))
      sleep 0.05
    done
    if [ "$gpu_active" -eq 1 ]; then
      echo "SEVYN_GPU_HARDWARE_ACCELERATION_ACTIVE"
      export SEVYN_GRAPHICS_ACCELERATION=gpu
      cp /var/log/weston-gpu.log /var/log/weston.log 2>/dev/null || true
    else
      echo "SEVYN_GPU_HARDWARE_ACCELERATION_UNAVAILABLE; falling back to software renderer (pixman)..."
      if [ -f /var/log/weston-gpu.log ]; then
        echo "GPU failure log summary:"
        tail -n 20 /var/log/weston-gpu.log || true
      fi
      kill -9 "$weston_pid" 2>/dev/null || true
      wait "$weston_pid" 2>/dev/null || true
      rm -f "$runtime_dir/$WAYLAND_DISPLAY"*
    fi
  fi
  if [ "$gpu_active" -eq 0 ]; then
    echo "Using drm-backend.so with Pixman software renderer"
    weston --backend="$weston_backend" --shell="$weston_shell" --use-pixman --tty=1 --socket="$WAYLAND_DISPLAY" --idle-time=0 --log=/var/log/weston.log < /dev/tty1 &
    weston_pid=$!
    export SEVYN_GRAPHICS_ACCELERATION=software
  fi
else
  echo "Using headless-backend.so for Weston"
  weston --backend="$weston_backend" --shell="$weston_shell" --socket="$WAYLAND_DISPLAY" --idle-time=0 --log=/var/log/weston.log &
  weston_pid=$!
  export SEVYN_GRAPHICS_ACCELERATION=headless
fi

# Prevent automatic restart in guest service mode by not respawning services from this script.
# For systemd-based launches, service units should also use Restart=no where applicable.
attempt=0
while [ ! -S "$runtime_dir/$WAYLAND_DISPLAY" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 200 ]; then cat /var/log/weston.log; exit 1; fi
  sleep 0.05
done
log_marker SEVYN_QEMU_WESTON_READY
if [ "$weston_backend" = "drm-backend.so" ]; then
  log_marker SEVYN_QEMU_GRAPHICAL_WESTON_READY
fi
mkdir -p /var/log /tmp
touch /tmp/genesis.log /var/log/genesis.log
genesis_log_tail_pid=""
if [ "${SEVYN_FOCUS_TRACE:-0}" = "1" ] && [ -c /dev/ttyS0 ]; then
  # TypeScript markers already mirror themselves to the serial console. Stream
  # only the native timing records here; replaying the complete render log over
  # an emulated serial port materially changes the latency being measured.
  tail -n +1 -f /tmp/genesis.log | while IFS= read -r line; do
    case "$line" in
      RUST_FOCUS_TRACE_ENABLED|RUST_BUFFER_COPIED\ *|FOCUS_TRACE_PRESENTED\ *)
        echo "$line" > /dev/ttyS0
        ;;
    esac
  done &
  genesis_log_tail_pid=$!
fi
probe_log_tail_pid=""
if [ "${SEVYN_HITTEST_PROBE:-0}" = "1" ]; then
  # Persist the click-through probe output where it can be retrieved after
  # the run: /var/lib/sevynos is the SEVYN_DATA volume when one is attached,
  # tmpfs otherwise. Boot with: sevyn.hittest-probe=1
  probe_log=/var/lib/sevynos/hittest-probe.log
  : > "$probe_log" 2>/dev/null || true
  tail -n +1 -f /tmp/genesis.log 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      SEVYN_PROBE_HITTEST*|*"TYPESCRIPT DISPLAY SIZE"*)
        echo "$line" >> "$probe_log"
        ;;
    esac
  done &
  probe_log_tail_pid=$!
fi
node /opt/sevynos/genesis-wayland.mjs > /tmp/genesis.log 2>&1 &
genesis_pid=$!
echo "$genesis_pid" > "$runtime_dir/genesis.pid"
controlled_shutdown() {
  kill -TERM "$genesis_pid" 2>/dev/null || true
  wait "$genesis_pid" 2>/dev/null || true
  if [ -n "$genesis_log_tail_pid" ]; then
    kill "$genesis_log_tail_pid" 2>/dev/null || true
    wait "$genesis_log_tail_pid" 2>/dev/null || true
  fi
  if [ -n "$probe_log_tail_pid" ]; then
    kill "$probe_log_tail_pid" 2>/dev/null || true
    wait "$probe_log_tail_pid" 2>/dev/null || true
  fi
  kill "$weston_pid" 2>/dev/null || true
  wait "$weston_pid" 2>/dev/null || true
  log_marker SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE
  exit 0
}
trap controlled_shutdown TERM INT
if grep -q 'sevyn.full-desktop-smoke=1' /proc/cmdline; then
  attempt=0
  while ! grep -q SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED /tmp/genesis.log; do
    if ! kill -0 "$genesis_pid" 2>/dev/null; then cat /tmp/genesis.log; exit 1; fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 800 ]; then cat /tmp/genesis.log; exit 1; fi
    sleep 0.05
  done
  kill -TERM "$genesis_pid"
  wait "$genesis_pid"
  cat /tmp/genesis.log
  kill "$weston_pid" 2>/dev/null || true
  log_marker SEVYN_QEMU_CONTROLLED_SHUTDOWN
  exit 0
fi
genesis_exit=0
wait "$genesis_pid" || genesis_exit=$?
if [ -n "$genesis_log_tail_pid" ]; then
  kill "$genesis_log_tail_pid" 2>/dev/null || true
  wait "$genesis_log_tail_pid" 2>/dev/null || true
fi
if [ -n "$probe_log_tail_pid" ]; then
  kill "$probe_log_tail_pid" 2>/dev/null || true
  wait "$probe_log_tail_pid" 2>/dev/null || true
fi
kill "$weston_pid" 2>/dev/null || true
wait "$weston_pid" 2>/dev/null || true
if [ "$genesis_exit" -ne 0 ]; then
  echo "Genesis exited with code $genesis_exit"
  echo "=== Genesis log tail ==="
  tail -n 50 /tmp/genesis.log
  echo "=== End Genesis log ==="
  exit "$genesis_exit"
fi
