#!/bin/sh
# Fetch the pinned Genesis tree (realkevonporter/genesis) — the split
# of 2026-11-19 moved the compositor server code, the M1 test client,
# and the graphics model out of sevynos into the genesis repo, and
# sevynos consumes them by pinned-commit fetch (not a submodule, not a
# vendored copy). The pin lives in v2/image/genesis-pin.txt
# (<commit sha> <tarball sha256>).
#
# Usage:
#   fetch-genesis.sh tree [dest-dir]
#     Resolve the genesis tree and print its path. With SEVYN_GENESIS_SRC
#     set, prints that local checkout (validated) instead of fetching.
#     With dest-dir, extracts the tarball there; otherwise a fresh temp
#     dir (the caller owns it). The M1 image builder passes its own
#     temp dir so its trap cleans it up.
#
# Requirements: curl (or wget), sha256sum, tar. The tarball sha256 from
# the pin file is verified before anything is extracted.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIN="$ROOT/v2/image/genesis-pin.txt"

read_pin() {
  # First non-comment, non-blank line: "<commit> <sha256>".
  set -- $(grep -v '^[[:space:]]*#' "$PIN" | grep -v '^[[:space:]]*$')
  COMMIT="$1"
  SHA256="$2"
  if [ -z "${COMMIT:-}" ] || [ -z "${SHA256:-}" ]; then
    echo "error: bad pin file $PIN (want '<commit sha> <tarball sha256>')" >&2
    exit 1
  fi
}

check_tree() {
  # $1 = candidate tree dir. The two paths sevynos consumes must exist.
  if [ ! -f "$1/compositor/tests/test-client.c" ]; then
    echo "error: $1 has no compositor/tests/test-client.c (not a genesis tree?)" >&2
    exit 1
  fi
  if [ ! -f "$1/model/package.json" ]; then
    echo "error: $1 has no model/package.json (not a genesis tree?)" >&2
    exit 1
  fi
}

resolve_tree() {
  # Prints the tree path. $1 = optional dest dir for the extraction.
  if [ -n "${SEVYN_GENESIS_SRC:-}" ]; then
    check_tree "$SEVYN_GENESIS_SRC"
    printf '%s\n' "$SEVYN_GENESIS_SRC"
    return 0
  fi
  read_pin
  for tool in tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "error: $tool not found" >&2
      exit 1
    }
  done
  if command -v curl >/dev/null 2>&1; then
    downloader="curl -sSL"
  elif command -v wget >/dev/null 2>&1; then
    downloader="wget -qO-"
  else
    echo "error: curl or wget not found" >&2
    exit 1
  fi
  DEST="${1:-$(mktemp -d)}"
  mkdir -p "$DEST"
  TMP_TARBALL="$(mktemp)"
  trap 'rm -f "$TMP_TARBALL"' EXIT INT TERM
  $downloader "https://codeload.github.com/realkevonporter/genesis/tar.gz/$COMMIT" >"$TMP_TARBALL"
  ACTUAL="$(sha256sum "$TMP_TARBALL" | cut -d' ' -f1)"
  if [ "$ACTUAL" != "$SHA256" ]; then
    echo "error: genesis tarball sha256 mismatch for $COMMIT" >&2
    echo "  expected: $SHA256" >&2
    echo "  actual:   $ACTUAL" >&2
    exit 1
  fi
  tar xzf "$TMP_TARBALL" -C "$DEST" --strip-components=1
  check_tree "$DEST"
  printf '%s\n' "$DEST"
}

cmd="${1:-tree}"
case "$cmd" in
  tree)
    resolve_tree "${2:-}"
    ;;
  *)
    echo "usage: fetch-genesis.sh tree [dest-dir]" >&2
    exit 1
    ;;
esac
