// SevynOS v2 — file-drag test (gap build unit 15).
//
// Drives the URI-list build/parse and MIME negotiation
// (file-drag.h) with no Wayland, no compositor and no Hermes:
//   1. buildUriList encodes one file:// URI per line (spaces and
//      UTF-8 bytes percent-encoded, '/' untouched);
//   2. parseUriList recovers the paths (round-trip), skipping
//      comments, blanks, non-file URIs, relative paths, and lines
//      with malformed escapes;
//   3. selectFileMime accepts exactly "text/uri-list" and nothing else.
//
// The Wayland wiring (wayland.cc offers the source, receives the
// offer) is proven by the host-compile job and by the QEMU
// on-device proof in the PR body, not here — the same split as
// test-text-clipboard.cc.
//
// Build: g++ -O2 -std=c++17 -Wall -Wextra -I v2/rn/host
//        -o /tmp/test-file-drag v2/rn/host/test-file-drag.cc
//        && /tmp/test-file-drag
#include <cstdio>
#include <string>
#include <vector>

#include "file-drag.h"

using namespace sevyn;

namespace {

int failures = 0;

void check(bool ok, const std::string& name, const std::string& detail = "") {
  if (ok) {
    printf("ok - %s%s\n", name.c_str(),
           detail.empty() ? "" : (" (" + detail + ")").c_str());
  } else {
    printf("FAIL - %s%s\n", name.c_str(),
           detail.empty() ? "" : (" (" + detail + ")").c_str());
    failures++;
  }
}

} // namespace

int main() {
  // 1. Build: one URI per line, trailing newline.
  {
    check(buildUriList({"/data/photo.png"}) ==
              "file:///data/photo.png\n",
          "build: single path");
    check(buildUriList({"/data/a.txt", "/data/b.txt"}) ==
              "file:///data/a.txt\nfile:///data/b.txt\n",
          "build: two paths, one per line");
    check(buildUriList({}).empty(), "build: empty list is empty");
    check(buildUriList({"/data/My File.txt"}) ==
              "file:///data/My%20File.txt\n",
          "build: space percent-encoded");
    check(buildUriList({"/data/a#b.txt"}) ==
              "file:///data/a%23b.txt\n",
          "build: hash percent-encoded (else it would start a comment)");
    check(fileUriForPath("/data/Photos") == "file:///data/Photos",
          "build: no trailing newline on the single-URI helper");
  }

  // 2. Parse: the round-trip, plus hostile input.
  {
    const std::vector<std::string> paths = {"/data/photo.png",
                                             "/data/My File.txt",
                                             "/data/a#b.txt"};
    check(parseUriList(buildUriList(paths)) == paths,
          "parse: round-trip recovers the paths");
    check(parseUriList("file:///data/a.txt\n# a comment\n\n"
                       "file:///data/b.txt\n") ==
              std::vector<std::string>({"/data/a.txt", "/data/b.txt"}),
          "parse: comments and blank lines skipped");
    check(parseUriList("file:///data/a.txt\r\nfile:///data/b.txt\r\n") ==
              std::vector<std::string>({"/data/a.txt", "/data/b.txt"}),
          "parse: CRLF line endings tolerated");
    check(parseUriList("https://example.com/x\nfile:///data/a.txt\n") ==
              std::vector<std::string>({"/data/a.txt"}),
          "parse: non-file URIs dropped");
    check(parseUriList("file://relative/path\nfile:///data/a.txt\n") ==
              std::vector<std::string>({"/data/a.txt"}),
          "parse: relative paths dropped");
    check(parseUriList("file:///data/a%2Fb.txt\n") ==
              std::vector<std::string>({"/data/a/b.txt"}),
          "parse: %2F decodes to a slash");
    check(parseUriList("file:///data/a%ZZb.txt\nfile:///data/ok.txt\n") ==
              std::vector<std::string>({"/data/ok.txt"}),
          "parse: malformed escape drops that line only");
    check(parseUriList("file:///data/a%.txt\n") ==
              std::vector<std::string>{},
          "parse: truncated escape drops the line");
    check(parseUriList("").empty(), "parse: empty input is empty");
    check(parseUriList(buildUriList({"/data/caf\xC3\xA9.txt"})) ==
              std::vector<std::string>({"/data/caf\xC3\xA9.txt"}),
          "parse: UTF-8 bytes round-trip through percent-encoding");
  }

  // 3. MIME negotiation.
  {
    check(selectFileMime({"text/uri-list"}) == "text/uri-list",
          "mime: exact text/uri-list accepted");
    check(selectFileMime({"image/png", "text/uri-list", "text/plain"}) ==
              "text/uri-list",
          "mime: file MIME wins over the other offers");
    check(selectFileMime({"text/plain", "text/html"}).empty(),
          "mime: no file MIME offered -> empty");
    check(selectFileMime({}).empty(), "mime: empty offer list -> empty");
    check(selectFileMime({"text/uri-list;charset=utf-8"}).empty(),
          "mime: suffixed variant is not the file MIME");
  }

  if (failures != 0) {
    printf("%d FAILURES\n", failures);
    return 1;
  }
  printf("all file-drag checks passed\n");
  return 0;
}
