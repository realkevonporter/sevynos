#!/bin/sh
set -eu
runtime_dir="$(mktemp -d)"
chmod 700 "$runtime_dir"
export XDG_RUNTIME_DIR="$runtime_dir"
export WAYLAND_DISPLAY=wayland-sevyn-test
weston --backend=headless-backend.so --socket="$WAYLAND_DISPLAY" --idle-time=0 --log="$runtime_dir/weston.log" &
weston_pid=$!
trap 'kill "$weston_pid" 2>/dev/null || true' EXIT
attempt=0
while [ ! -S "$runtime_dir/$WAYLAND_DISPLAY" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ]; then cat "$runtime_dir/weston.log"; exit 1; fi
  sleep 0.05
done
if ! python3 /usr/local/lib/sevynos/smoke-wayland.py; then
  cat "$runtime_dir/weston.log"
  exit 1
fi
