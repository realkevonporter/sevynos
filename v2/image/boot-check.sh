#!/bin/sh
# Boot the SevynOS v2 empty image in QEMU and assert the boot marker.
#
# Usage: sh v2/image/boot-check.sh
# Passes when SEVYNOS_V2_BOOT_OK appears on the serial console within
# SEVYN_V2_BOOT_TIMEOUT seconds (default 120). The full serial log is kept
# at v2/image/build/boot.log.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${SEVYN_V2_BUILD_DIR:-$ROOT/image/build}"
LOG="$OUT/boot.log"
TIMEOUT="${SEVYN_V2_BOOT_TIMEOUT:-120}"

for f in "$OUT/vmlinuz" "$OUT/initramfs.cpio.gz"; do
  if [ ! -f "$f" ]; then
    echo "error: missing $f — run v2/image/build-empty-image.sh first" >&2
    exit 1
  fi
done
command -v qemu-system-x86_64 >/dev/null 2>&1 || {
  echo "error: qemu-system-x86_64 not found (install qemu-system-x86)" >&2
  exit 1
}

: >"$LOG"
qemu-system-x86_64 \
  -machine q35 -m 256 -smp 1 \
  -kernel "$OUT/vmlinuz" -initrd "$OUT/initramfs.cpio.gz" \
  -append "console=ttyS0" \
  -display none -monitor none -serial stdio -no-reboot -nic none \
  >>"$LOG" 2>&1 &
qemu_pid=$!

deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q "SEVYNOS_V2_BOOT_OK" "$LOG" 2>/dev/null; then
    kill "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
    echo "BOOT OK — marker SEVYNOS_V2_BOOT_OK found in $LOG"
    exit 0
  fi
  if ! kill -0 "$qemu_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

kill "$qemu_pid" 2>/dev/null || true
wait "$qemu_pid" 2>/dev/null || true
echo "BOOT FAILED — marker SEVYNOS_V2_BOOT_OK not found in $LOG" >&2
tail -n 40 "$LOG" >&2
exit 1
