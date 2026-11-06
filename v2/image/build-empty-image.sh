#!/bin/sh
# Build the SevynOS v2 empty image (M0): a host kernel + a minimal initramfs.
#
# No shell, no apps, no compositor — the image boots to a blank screen and
# prints SEVYNOS_V2_BOOT_OK on the serial console. That is the whole point
# of M0: prove the pipeline, not the OS.
#
# Requirements: a kernel in /boot (linux-image-generic), busybox-static, cpio.
# Outputs (SEVYN_V2_BUILD_DIR, default v2/image/build/):
#   vmlinuz, initramfs.cpio.gz, kernel-version.txt
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${SEVYN_V2_BUILD_DIR:-$ROOT/image/build}"

# The build host may carry more than one kernel. Its own kernel can be
# host-specific (GitHub runners: vmlinuz-*-azure) and root-only, and even
# the generic kernel ships mode 600 — so this script must run with read
# access to /boot (CI runs it under sudo). Take the newest readable
# non-Azure kernel — on CI that is the linux-image-generic kernel the
# workflow installs.
kernel="$(find /boot -maxdepth 1 -type f -name 'vmlinuz-*' -readable ! -name 'vmlinuz-*-azure' 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -z "$kernel" ]; then
  echo "error: no readable kernel found in /boot (install linux-image-generic; sudo may be needed to read it)" >&2
  exit 1
fi
kernel_version="${kernel#/boot/vmlinuz-}"

command -v busybox >/dev/null 2>&1 || {
  echo "error: busybox not found (install busybox-static)" >&2
  exit 1
}
busybox_bin="$(command -v busybox)"
command -v cpio >/dev/null 2>&1 || {
  echo "error: cpio not found" >&2
  exit 1
}

mkdir -p "$OUT"
cp "$kernel" "$OUT/vmlinuz"
chmod 644 "$OUT/vmlinuz"
printf '%s\n' "$kernel_version" >"$OUT/kernel-version.txt"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT INT TERM
mkdir -p "$STAGE/bin" "$STAGE/proc" "$STAGE/sys" "$STAGE/dev"
cp "$busybox_bin" "$STAGE/bin/busybox"
ln -s busybox "$STAGE/bin/sh"
ln -s busybox "$STAGE/bin/poweroff"

cat >"$STAGE/init" <<'EOF'
#!/bin/busybox sh
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
echo "SevynOS v2 - empty image (M0)"
echo "SEVYNOS_V2_BOOT_OK"
exec /bin/busybox poweroff -f
EOF
chmod +x "$STAGE/init"

(cd "$STAGE" && find . | cpio -o -H newc 2>/dev/null | gzip -9 >"$OUT/initramfs.cpio.gz")

echo "Built empty image in $OUT (kernel $kernel_version)"
ls -l "$OUT"
