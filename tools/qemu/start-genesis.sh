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
case " $(cat /proc/cmdline) " in
  *" sevyn.bitmap-diagnostics=1 "*)
    export SEVYN_BITMAP_DIAGNOSTICS=1
    echo SEVYN_BITMAP_DIAGNOSTICS_ENABLED
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

# Weston liveness probing library. A socket file alone never proves the
# compositor is alive (a crashed Weston leaves its socket behind), so every
# readiness check goes through weston_is_alive / wait_for_weston_liveness.
_weston_liveness_lib=/usr/local/lib/sevynos/weston-liveness.sh
if [ ! -f "$_weston_liveness_lib" ]; then
  # Development layout: the library sits next to this script.
  _weston_liveness_lib=$(dirname "$0")/weston-liveness.sh
fi
if [ -f "$_weston_liveness_lib" ]; then
  . "$_weston_liveness_lib"
else
  echo "FATAL: weston-liveness.sh not found at $_weston_liveness_lib" >&2
  exit 1
fi
unset _weston_liveness_lib

# ─── Session user ────────────────────────────────────────────────────
# On installed systems the desktop session runs as the installed user,
# never as root. The installer writes the accounts registry; when it is
# absent (live session, or an install without a user) the session keeps
# running as root, exactly as before.
#
# This block runs while still root: it hands ownership of the runtime,
# state and log paths to the user, then re-execs itself via setpriv.
if [ "$(id -u)" -eq 0 ] && [ -z "${SEVYN_SESSION_DROPPED:-}" ]; then
  session_user=""
  if [ -f /var/lib/sevyn/accounts/registry.json ]; then
    # registry.json is { version: 1, users: [{ username, uid, ... }] }.
    # Prefer node for exact parsing; fall back to sed.
    if command -v node >/dev/null 2>&1; then
      session_user=$(node -e '
        try {
          const fs = require("node:fs");
          const reg = JSON.parse(fs.readFileSync("/var/lib/sevyn/accounts/registry.json", "utf8"));
          const users = Array.isArray(reg) ? reg : reg.users;
          const first = Array.isArray(users) ? users[0] : undefined;
          if (first && typeof first.username === "string") process.stdout.write(first.username);
        } catch { /* fall back to sed */ }
      ' 2>/dev/null)
    fi
    if [ -z "$session_user" ]; then
      session_user=$(sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        /var/lib/sevyn/accounts/registry.json 2>/dev/null | head -n 1)
    fi
  fi
  if [ -n "$session_user" ] && id "$session_user" >/dev/null 2>&1; then
    session_uid=$(id -u "$session_user")
    session_gid=$(id -g "$session_user")
    session_home=$(sed -n "s|^${session_user}:[^:]*:[^:]*:[^:]*:[^:]*:\\([^:]*\\).*|\\1|p" /etc/passwd | head -n 1)
    [ -n "$session_home" ] || session_home="/var/lib/sevyn/users/$session_user"
    if command -v setpriv >/dev/null 2>&1; then
      log_marker "SEVYN_SESSION_USER=$session_user"
      # Hand over everything the session writes as root, before dropping.
      chown -R "$session_uid:$session_gid" "$runtime_dir" /var/lib/sevyn 2>/dev/null || true
      # The OS update bookkeeping dir must be writable by the session
      # user: the update service stages pending.json here and Genesis
      # writes the boot-health session-ready marker. Only the directory
      # itself is handed over (not recursive): root-created files inside
      # (boot-attempt counter, backup slot) keep root ownership, and the
      # backup slot's integrity is pinned by a sha256 in the root-only
      # update-trust dir, so a compromised session cannot plant an
      # unverified rollback payload.
      mkdir -p /var/lib/sevynos/updates
      chown "$session_uid:$session_gid" /var/lib/sevynos/updates 2>/dev/null || true
      touch /var/log/weston.log /var/log/genesis.log /tmp/genesis.log 2>/dev/null || true
      chown "$session_uid:$session_gid" /var/log/weston.log /var/log/genesis.log /tmp/genesis.log 2>/dev/null || true
      export SEVYN_SESSION_DROPPED=1
      export SEVYN_SESSION_USER="$session_user"
      export HOME="$session_home" USER="$session_user" LOGNAME="$session_user"
      if [ -z "${SEVYN_CODE_WORKSPACE:-}" ]; then
        SEVYN_CODE_WORKSPACE="$session_home/Projects"
        export SEVYN_CODE_WORKSPACE
      fi
      log_marker "SEVYN_SESSION_WHOAMI=$(id "$session_user" 2>/dev/null || echo "uid=$session_uid")"
      exec setpriv --reuid="$session_uid" --regid="$session_gid" --clear-groups \
        /usr/local/bin/start-genesis "$@"
    else
      log_marker "SEVYN_SESSION_USER_FALLBACK_ROOT reason=setpriv-missing user=$session_user"
    fi
  elif [ -n "$session_user" ]; then
    log_marker "SEVYN_SESSION_USER_FALLBACK_ROOT reason=unknown-user user=$session_user"
  fi
fi

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
    # A socket FILE is not proof Weston is alive: under QEMU TCG the
    # llvmpipe backend can abort after creating the socket, leaving it
    # stale. Require the process to be alive AND the socket to accept
    # connections before declaring GPU acceleration active.
    if wait_for_weston_liveness "$weston_pid" "$runtime_dir/$WAYLAND_DISPLAY" 125; then
      gpu_active=1
      echo "Weston GPU backend verified alive and accepting connections"
    else
      echo "Weston with GPU hardware acceleration failed liveness check"
    fi
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
# As with the GPU path, require the compositor to actually accept connections,
# not just to have created its socket file.
if ! wait_for_weston_liveness "$weston_pid" "$runtime_dir/$WAYLAND_DISPLAY" 100; then
  echo "Weston failed liveness check — no compositor available"
  log_marker SEVYN_NO_COMPOSITOR
  cat /var/log/weston.log
  exit 1
fi
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
# ─── Weston late-death fallback ───────────────────────────────────────
# If Genesis exits while the GPU Weston is dead (e.g. the QEMU TCG llvmpipe
# abort, which strikes after the socket is created), the socket is stale
# and no compositor will ever answer it. Remove the stale socket, start the
# Pixman Weston, and give Genesis one more chance.
# Bounded: a single retry, GPU path only, and only when Weston is actually
# dead — a live Weston with a dead Genesis is a Genesis bug, not a
# compositor death, and must not be masked by a fallback.
maybe_fallback_to_pixman() {
  if [ "${SEVYN_GRAPHICS_ACCELERATION:-}" != "gpu" ]; then
    return 1
  fi
  if weston_is_alive "$weston_pid" "$runtime_dir/$WAYLAND_DISPLAY"; then
    echo "Genesis failed but Weston is alive — no compositor fallback"
    return 1
  fi
  echo "Weston died during startup — falling back to Pixman software renderer"
  log_marker SEVYN_WESTON_DIED_FALLING_BACK_TO_PIXMAN
  kill -9 "$weston_pid" 2>/dev/null || true
  wait "$weston_pid" 2>/dev/null || true
  rm -f "$runtime_dir/$WAYLAND_DISPLAY"*
  weston --backend="$weston_backend" --shell="$weston_shell" --use-pixman --tty=1 --socket="$WAYLAND_DISPLAY" --idle-time=0 --log=/var/log/weston.log < /dev/tty1 &
  weston_pid=$!
  if ! wait_for_weston_liveness "$weston_pid" "$runtime_dir/$WAYLAND_DISPLAY" 200; then
    echo "Pixman Weston failed liveness check — no compositor available"
    log_marker SEVYN_NO_COMPOSITOR
    return 1
  fi
  export SEVYN_GRAPHICS_ACCELERATION=software
  echo "Pixman Weston verified alive and accepting connections"
  log_marker SEVYN_PIXMAN_WESTON_READY
  return 0
}

launch_genesis() {
  # $1: "truncate" for the first launch, "append" for the fallback relaunch
  # (append preserves the first failure's diagnostics in the log).
  if [ "$1" = "truncate" ]; then
    node /opt/sevynos/genesis-wayland.mjs > /tmp/genesis.log 2>&1 &
  else
    echo "=== SEVYN_GENESIS_RELAUNCH_AFTER_WESTON_FALLBACK ===" >> /tmp/genesis.log
    node /opt/sevynos/genesis-wayland.mjs >> /tmp/genesis.log 2>&1 &
  fi
  genesis_pid=$!
  echo "$genesis_pid" > "$runtime_dir/genesis.pid"
}

fell_back_to_pixman=0
launch_genesis truncate
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
  while :; do
    attempt=0
    while ! grep -q SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED /tmp/genesis.log; do
      if ! kill -0 "$genesis_pid" 2>/dev/null; then break; fi
      attempt=$((attempt + 1))
      if [ "$attempt" -gt 800 ]; then break; fi
      sleep 0.05
    done
    if grep -q SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED /tmp/genesis.log; then
      break
    fi
    if [ "$fell_back_to_pixman" -eq 0 ]; then
      # Make sure the old Genesis is not still running before falling back,
      # otherwise two Genesises would race on the new compositor.
      if kill -0 "$genesis_pid" 2>/dev/null; then
        echo "Genesis still running without first frame — terminating before fallback"
        kill -TERM "$genesis_pid" 2>/dev/null || true
        wait "$genesis_pid" 2>/dev/null || true
      fi
      if maybe_fallback_to_pixman; then
        fell_back_to_pixman=1
        echo "Relaunching Genesis on the Pixman compositor (smoke mode)"
        launch_genesis append
        continue
      fi
    fi
    cat /tmp/genesis.log
    exit 1
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
if [ "$genesis_exit" -ne 0 ] && [ "$fell_back_to_pixman" -eq 0 ] && maybe_fallback_to_pixman; then
  fell_back_to_pixman=1
  echo "Relaunching Genesis on the Pixman compositor"
  launch_genesis append
  genesis_exit=0
  wait "$genesis_pid" || genesis_exit=$?
fi
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
