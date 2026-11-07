#!/bin/sh
# SevynOS v2 M2 — build the RN host's native dependencies.
#
# Fetches and builds, from pinned sources:
#   Hermes 0.13.0  (JS engine + hermesc; libhermes.a + JSI headers)
#   Yoga @ 41118bd (flexbox layout; libyogacore.a + headers)
# into SEVYN_V2_DEPS_DIR (default v2/rn/host/deps).
#
# Layout:
#   $DEPS_DIR/
#     src/hermes-0.13.0/      extracted Hermes source
#     src/yoga-<commit>/      extracted Yoga source
#     build/hermes/           Hermes CMake build dir (kept: the host links
#                             the static archives from here, because
#                             libhermes's PRIVATE deps — hermesVMRuntime,
#                             the llvh LLVM libs — are not installed)
#     build/yoga/             Yoga CMake build dir
#     prefix/                 cmake --install prefix:
#       bin/hermesc           bundle compiler (shell.js -> shell.hbc)
#       include/hermes/       Hermes public headers
#       include/jsi/          JSI headers
#       include/yoga/         Yoga headers
#       lib/libhermes.a       embed library (public face)
#       lib/libyogacore.a     layout library
#       lib/libjsi.a
#     .sevyn-deps             marker with the pinned versions; the script
#                             is idempotent — a matching marker skips the
#                             whole build (this is what CI caches).
#
# The host links libhermes.a + libyogacore.a + libjsi.a + every other
# static archive under build/hermes (except the lean variants and
# unittests), inside --start-group/--end-group so link order does not
# matter. See v2/image/build-m2-image.sh.
#
# Requirements: curl, sha256sum, cmake >= 3.28, ninja or make, g++,
# python3. The Hermes build is the slow part (10-20 min on a 2-core CI
# runner); cache $DEPS_DIR in CI keyed by the versions below + this
# script's hash. Do NOT run this in the memory-tight sandbox — a Hermes
# build OOMs there; CI is the gate.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ROOT is v2/rn (the script lives in v2/rn/host), so the deps dir is
# $ROOT/host/deps = v2/rn/host/deps — NOT $ROOT/rn/host/deps (that
# doubles the "rn" and disagrees with build-m2-image.sh + the CI cache,
# which both expect v2/rn/host/deps).
DEPS_DIR="${SEVYN_V2_DEPS_DIR:-$ROOT/host/deps}"
SRC_DIR="$DEPS_DIR/src"
BUILD_DIR="$DEPS_DIR/build"
PREFIX="$DEPS_DIR/prefix"
MARKER="$DEPS_DIR/.sevyn-deps"

HERMES_VERSION="0.13.0"
HERMES_SHA256="40ecd782552335126fdb91f63f6822a7f4bef71ef3ec980fe34a263fbf447c93"
HERMES_URL="https://github.com/facebook/hermes/archive/refs/tags/v${HERMES_VERSION}.tar.gz"
YOGA_COMMIT="41118bd3a86c637fdb43a90fd596e78375137d0f"
YOGA_SHA256="afddb3b7c273642223d4237f82a41a5bfe1ad865fff1317ef6c38eaf7c9026a4"
YOGA_URL="https://codeload.github.com/facebook/yoga/tar.gz/${YOGA_COMMIT}"

MARKER_CONTENT="hermes=${HERMES_VERSION} yoga=${YOGA_COMMIT}"

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$MARKER_CONTENT" ] \
   && [ -x "$PREFIX/bin/hermesc" ] \
   && [ -f "$PREFIX/lib/libhermes.a" ] \
   && [ -f "$PREFIX/lib/libyogacore.a" ]; then
  echo "deps up to date ($MARKER_CONTENT) — skipping build"
  exit 0
fi

for tool in curl sha256sum cmake g++ python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool not found" >&2
    exit 1
  }
done

mkdir -p "$SRC_DIR" "$BUILD_DIR" "$PREFIX"

# --- fetch + verify -------------------------------------------------------
fetch() {
  url="$1"; sha="$2"; dest="$3"
  if [ -f "$dest" ]; then
    echo "reusing $(basename "$dest")"
  else
    echo "fetching $url"
    curl -fsSL -o "$dest" "$url"
  fi
  echo "$sha  $dest" | sha256sum -c - || {
    echo "error: sha256 mismatch for $dest" >&2
    rm -f "$dest"
    exit 1
  }
}

fetch "$HERMES_URL" "$HERMES_SHA256" "$SRC_DIR/hermes-${HERMES_VERSION}.tar.gz"
fetch "$YOGA_URL" "$YOGA_SHA256" "$SRC_DIR/yoga-${YOGA_COMMIT}.tar.gz"

# --- extract --------------------------------------------------------------
if [ ! -d "$SRC_DIR/hermes-${HERMES_VERSION}" ]; then
  tar -xzf "$SRC_DIR/hermes-${HERMES_VERSION}.tar.gz" -C "$SRC_DIR"
fi
if [ ! -d "$SRC_DIR/yoga-${YOGA_COMMIT}" ]; then
  mkdir -p "$SRC_DIR/yoga-${YOGA_COMMIT}"
  tar -xzf "$SRC_DIR/yoga-${YOGA_COMMIT}.tar.gz" -C "$SRC_DIR/yoga-${YOGA_COMMIT}" --strip-components=1
fi

# Parallelism: Hermes is a big build; use all cores but leave one free.
if command -v nproc >/dev/null 2>&1; then
  JOBS="$(nproc)"
else
  JOBS="2"
fi
[ "$JOBS" -gt 1 ] && JOBS=$((JOBS - 1))
[ "$JOBS" -lt 1 ] && JOBS=1
echo "building with $JOBS parallel jobs"

# --- Hermes ---------------------------------------------------------------
# Build only the targets the host needs (libhermes + hermesc) so the
# build dir holds no lean/test archives that would clash at link time.
# The tool targets (hermes, hdb, hbcdump, hvm, hcdp) are built too —
# NOT because the host needs them, but because `cmake --install`
# unconditionally installs all six tool binaries and fails the whole
# install when any was never built (hermes bit us, then hdb). They are
# executables, not archives, so they add nothing the host link picks up.
HERMES_SRC="$SRC_DIR/hermes-${HERMES_VERSION}"
HERMES_BUILD="$BUILD_DIR/hermes"
# -include string: Hermes 0.13.0's API/hermes/cdp/DomainState.h uses
# std::string (unordered_map<string, …>) but never #includes <string> —
# it relied on a transitive include that GCC 13's libstdc++ no longer
# provides, so the libhermes build dies at 98% with "incomplete type
# std::__cxx11::basic_string". Forcing the include for every TU covers
# this file and any other latent instance in the tree, without patching
# vendored sources. Harmless for TUs that already compile (<string> is
# idempotent). Verified the failure in CI run 42326585817.
# -DBUILD_SHARED_LIBS=OFF: on Linux, Hermes defaults shared libs ON, so
# libhermes/jsi build as .so — but the host links STATIC archives from
# the build dir (and the verify step below expects libhermes.a/libjsi.a
# in the prefix). Static also keeps the image free of .so runtime deps.
# Verified the .so install in CI run 42330696308.
cmake -S "$HERMES_SRC" -B "$HERMES_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMES_BUILD_APPLE_FRAMEWORK=OFF \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DCMAKE_CXX_FLAGS="-include string" \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$HERMES_BUILD" --target hermesc libhermes jsi hermes hdb hbcdump hvm hcdp --parallel "$JOBS"
cmake --install "$HERMES_BUILD"

# --- Yoga ------------------------------------------------------------------
YOGA_SRC="$SRC_DIR/yoga-${YOGA_COMMIT}"
YOGA_BUILD="$BUILD_DIR/yoga"
cmake -S "$YOGA_SRC" -B "$YOGA_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
# Yoga's top-level CMake unconditionally adds tests/, which FetchContents
# googletest — and `cmake --install` then tries to install libgmock.a /
# libgtest.a (+ _main variants) even though only yogacore was built, so
# the install dies on the missing archives. Build the four googletest
# libs too (small, ~30s); they live in the Yoga build dir, so they add
# nothing the host link picks up (it only scans the Hermes build dir).
cmake --build "$YOGA_BUILD" --target yogacore gtest gtest_main gmock gmock_main --parallel "$JOBS"
cmake --install "$YOGA_BUILD"

# --- verify + mark ---------------------------------------------------------
for f in "$PREFIX/bin/hermesc" "$PREFIX/lib/libhermes.a" \
         "$PREFIX/lib/libyogacore.a" "$PREFIX/lib/libjsi.a" \
         "$PREFIX/include/hermes/hermes.h" "$PREFIX/include/jsi/jsi.h" \
         "$PREFIX/include/yoga/Yoga.h"; do
  [ -e "$f" ] || { echo "error: expected $f after install" >&2; exit 1; }
done
# The host links the Hermes build archives directly (see header comment).
HERMES_LIBS="$(find "$HERMES_BUILD" -name '*.a' ! -name '*lean*' ! -path '*unittests*' | wc -l)"
echo "hermes build archives available for host link: $HERMES_LIBS"
[ "$HERMES_LIBS" -gt 5 ] || { echo "error: too few hermes archives — build incomplete?" >&2; exit 1; }

printf '%s\n' "$MARKER_CONTENT" >"$MARKER"
echo "deps built in $DEPS_DIR ($MARKER_CONTENT)"
ls -l "$PREFIX/bin" "$PREFIX/lib" | head -30
