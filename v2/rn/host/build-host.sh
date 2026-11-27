#!/bin/sh
# SevynOS v2 — build the RN host binary (sevyn-rn-host).
#
# Shared by the shipping image build (v2/image/build-m13-image.sh) and
# the quality.yml host-compile gate, so the gate and the image can never
# drift apart. The `namespace` issue (PR #158) reached CI because the
# only compile gate for the host was the image build itself.
#
# Usage: build-host.sh <deps-dir> <protocols-dir> <out> [build-tmp]
#   deps-dir:      the build-deps.sh output dir (v2/rn/host/deps) —
#                  prefix/ has hermesc + libhermes.a + libyogacore.a,
#                  build/hermes/ has the rest of the Hermes archives,
#                  src/hermes-*/ has the Hermes source (public/ headers).
#   protocols-dir: dir with stable/xdg-shell/xdg-shell.xml and
#                  stable/presentation-time/presentation-time.xml —
#                  the image sysroot's /usr/share/wayland-protocols, or
#                  the system /usr/share/wayland-protocols.
#   out:           the binary to write (e.g. $BUILD_TMP/sevyn-rn-host).
#   build-tmp:     scratch dir for the generated protocols + objects
#                  (default: a fresh mktemp -d, removed on exit; a
#                  caller-provided dir is left alone).
#
# Requirements: g++, gcc, pkg-config, wayland-scanner, and the -dev
# packages for wayland-client, wayland-cursor, freetype2, libpng, egl,
# glesv2, wayland-egl, icu-uc, icu-i18n.
set -eu

HOST_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="${1:?usage: build-host.sh <deps-dir> <protocols-dir> <out> [build-tmp]}"
PROTOCOLS_DIR="${2:?usage: build-host.sh <deps-dir> <protocols-dir> <out> [build-tmp]}"
OUT="${3:?usage: build-host.sh <deps-dir> <protocols-dir> <out> [build-tmp]}"
if [ -n "${4:-}" ]; then
  BUILD_TMP="$4"
  mkdir -p "$BUILD_TMP"
else
  BUILD_TMP="$(mktemp -d)"
  trap 'rm -rf "$BUILD_TMP"' EXIT INT TERM
fi

PREFIX="$DEPS_DIR/prefix"
HERMES_BUILD="$DEPS_DIR/build/hermes"
HERMES_SRC="$(ls -d "$DEPS_DIR"/src/hermes-*/)"
[ -x "$PREFIX/bin/hermesc" ] || { echo "error: $PREFIX/bin/hermesc missing (run build-deps.sh first)" >&2; exit 1; }
[ -f "$PREFIX/lib/libyogacore.a" ] || { echo "error: $PREFIX/lib/libyogacore.a missing (run build-deps.sh first)" >&2; exit 1; }
# wlr-layer-shell is a wlroots extension, not part of upstream
# wayland-protocols: the XML is vendored in the repo.
[ -f "$HOST_DIR/wlr-layer-shell-unstable-v1.xml" ] || {
  echo "error: missing $HOST_DIR/wlr-layer-shell-unstable-v1.xml (vendored protocol — the checkout is incomplete)" >&2
  exit 1
}

# --- Wayland protocols -----------------------------------------------------
wayland-scanner client-header \
  "$PROTOCOLS_DIR/stable/xdg-shell/xdg-shell.xml" \
  "$BUILD_TMP/xdg-shell-client-protocol.h"
wayland-scanner client-header \
  "$HOST_DIR/wlr-layer-shell-unstable-v1.xml" \
  "$BUILD_TMP/wlr-layer-shell-unstable-v1-client-protocol.h"
wayland-scanner private-code \
  "$PROTOCOLS_DIR/stable/xdg-shell/xdg-shell.xml" \
  "$BUILD_TMP/xdg-shell-protocol.c"
wayland-scanner private-code \
  "$HOST_DIR/wlr-layer-shell-unstable-v1.xml" \
  "$BUILD_TMP/wlr-layer-shell-unstable-v1-protocol.c"
wayland-scanner client-header \
  "$PROTOCOLS_DIR/stable/presentation-time/presentation-time.xml" \
  "$BUILD_TMP/presentation-time-client-protocol.h"
wayland-scanner private-code \
  "$PROTOCOLS_DIR/stable/presentation-time/presentation-time.xml" \
  "$BUILD_TMP/presentation-time-protocol.c"

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
gcc -O2 -c $(pkg-config --cflags wayland-client) \
  -I"$BUILD_TMP" \
  -o "$BUILD_TMP/wlr-layer-shell-unstable-v1-protocol.o" \
  "$BUILD_TMP/wlr-layer-shell-unstable-v1-protocol.c"

# The RN host: Hermes embed + Yoga + Wayland + painter + status bridge.
# Hermes's public headers (HermesExport.h, RuntimeConfig.h) are NOT
# installed by cmake --install, so the source public/ dir is on the
# include path too. Link: every Hermes build archive (except the lean
# variants, which would duplicate libhermes's symbols) inside
# --start-group/--end-group so order does not matter, plus yogacore.
# ICU: Hermes's libhermesPlatformUnicode.a calls ICU (ucol_*/uloc_*/udat_*,
# verified in CI run 42333389196) — link icui18n/icuuc/icudata.
HERMES_LIBS="$(find "$HERMES_BUILD" -name '*.a' ! -name '*lean*' ! -path '*unittests*' ! -name '*Test*' | sort)"
# M12 Genesis: the GPU present path needs EGL + GLES2 + wayland-egl
# headers. Fail loudly without them — a silent CPU-only M12 image is
# not acceptable (the M12 check asserts the GPU path is live).
# wayland-egl.h ships with libwayland-dev (already required above).
if ! pkg-config --exists egl glesv2 wayland-egl; then
  echo "error: EGL dev packages missing (install libegl-dev libgles-dev)" >&2
  exit 1
fi
# shellcheck disable=SC2086
g++ -O2 -std=c++17 -Wall -Wextra -DSEVYN_HAVE_EGL=1 \
  -I"$HOST_DIR" -I"$BUILD_TMP" \
  -I"$PREFIX/include" -I"$HERMES_SRC/public" \
  $(pkg-config --cflags wayland-client wayland-cursor freetype2 libpng egl glesv2 wayland-egl) \
  -o "$OUT" \
  "$HOST_DIR/common.cc" "$HOST_DIR/painter.cc" \
  "$HOST_DIR/genesis-presenter.cc" \
  "$HOST_DIR/compositor-bridge.cc" "$HOST_DIR/runtime-control.cc" \
  "$HOST_DIR/wayland.cc" "$HOST_DIR/status.cc" \
  "$HOST_DIR/appclient.cc" \
  "$HOST_DIR/audiod-client.cc" \
  "$HOST_DIR/yoga-bridge.cc" "$HOST_DIR/sevyn-rn-host.cc" \
  "$BUILD_TMP/xdg-shell-protocol.o" \
  "$BUILD_TMP/wlr-layer-shell-unstable-v1-protocol.o" \
  -Wl,--start-group $HERMES_LIBS "$PREFIX/lib/libyogacore.a" -Wl,--end-group \
  $(pkg-config --libs wayland-client wayland-cursor freetype2 libpng egl glesv2 wayland-egl) $(pkg-config --libs icu-uc icu-i18n) -lpthread -ldl

echo "host built: $OUT"
