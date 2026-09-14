#!/bin/sh
set -eu
if [ -r /run/sevynos/start-genesis.pid ]; then
  supervisor_pid="$(cat /run/sevynos/start-genesis.pid)"
  case "$supervisor_pid" in
    ''|*[!0-9]*) exit 1 ;;
  esac
  kill -TERM "$supervisor_pid"
fi
