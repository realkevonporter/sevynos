#!/bin/sh
# weston-liveness.sh — liveness probing for the Weston compositor.
#
# A Weston Unix socket file existing is NOT proof Weston is alive. Under
# QEMU TCG the llvmpipe backend can hit an LLVM JIT codegen failure and
# abort a minute after start — after creating /run/sevynos/wayland-0 —
# leaving a stale socket behind. Every check here verifies BOTH that the
# Weston process is alive (kill -0) AND that the socket actually accepts a
# connection (the same connect() the Wayland bridge performs).
#
# This file is a library: source it, do not execute it. It defines
# functions only, has no side effects on source, and is safe under
# `set -eu`. Requires python3 (for the connect probe).

# weston_socket_connectable <socket-path>
# Returns 0 if a Unix stream connection to the socket succeeds within the
# timeout, 1 otherwise (missing socket, refused, or timed out).
weston_socket_connectable() {
  _wsc_sock=$1
  [ -S "$_wsc_sock" ] || return 1
  python3 - "$_wsc_sock" <<'PYEOF' 2>/dev/null
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect(sys.argv[1])
except OSError:
    sys.exit(1)
finally:
    s.close()
PYEOF
}

# weston_is_alive <pid> <socket-path>
# Returns 0 iff the Weston process is alive AND its socket accepts
# connections. A stale socket from a dead Weston returns 1.
weston_is_alive() {
  _wia_pid=$1
  _wia_sock=$2
  kill -0 "$_wia_pid" 2>/dev/null || return 1
  weston_socket_connectable "$_wia_sock"
}

# wait_for_weston_liveness <pid> <socket-path> [timeout_ds]
# Polls at a 0.1s cadence (no busy-spin) until weston_is_alive succeeds or
# the timeout expires. timeout_ds is in deciseconds, default 50 (5s).
# Returns 0 if Weston became live, 1 on timeout or process death.
wait_for_weston_liveness() {
  _wfw_pid=$1
  _wfw_sock=$2
  _wfw_timeout=${3:-50}
  _wfw_attempt=0
  while [ "$_wfw_attempt" -lt "$_wfw_timeout" ]; do
    if weston_is_alive "$_wfw_pid" "$_wfw_sock"; then
      return 0
    fi
    if ! kill -0 "$_wfw_pid" 2>/dev/null; then
      return 1
    fi
    _wfw_attempt=$((_wfw_attempt + 1))
    sleep 0.1
  done
  return 1
}
