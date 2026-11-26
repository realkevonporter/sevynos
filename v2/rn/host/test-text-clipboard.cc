// SevynOS v2 — text-clipboard test (gap build unit 2).
//
// Drives the real TextClipboard store, MIME negotiation, and fd
// transfer (text-clipboard.h) with no Wayland, no compositor and no
// Hermes:
//   1. the store holds, replaces, and clears text;
//   2. selectTextMime prefers exact "text/plain", accepts a
//      "text/plain;..." variant (Chromium's charset form), and
//      refuses offers with no text MIME;
//   3. the fd round-trip carries the exact bytes (unicode, newlines,
//      empty string) from writer to reader through a pipe;
//   4. the read is capped at maxBytes;
//   5. the read times out (instead of blocking forever) when the
//      writer never writes and never closes.
//
// The Wayland wiring (wayland.cc binds the manager, offers the
// source, receives the offer) is proven by the host-compile job and
// by the GF65 on-device proof in the PR body, not here.
//
// Build: g++ -O2 -std=c++17 -Wall -Wextra -I v2/rn/host
//        -o /tmp/test-text-clipboard v2/rn/host/test-text-clipboard.cc
//        && /tmp/test-text-clipboard
#include <cstdio>
#include <string>
#include <unistd.h>
#include <vector>

#include "text-clipboard.h"

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
  // 1. Store: hold, replace, clear.
  {
    TextClipboard c;
    check(c.empty(), "store: initial state empty");
    check(c.get().empty(), "store: initial get is empty");
    c.set("hello");
    check(!c.empty() && c.get() == "hello", "store: set + get round-trip");
    c.set("sk-test-key-123");
    check(c.get() == "sk-test-key-123", "store: set replaces the old text");
    c.clear();
    check(c.empty() && c.get().empty(), "store: clear empties it");
  }

  // 2. MIME negotiation.
  {
    check(selectTextMime({"text/plain"}) == "text/plain",
          "mime: exact text/plain accepted");
    check(selectTextMime({"text/plain;charset=utf-8"}) ==
              "text/plain;charset=utf-8",
          "mime: text/plain;charset=utf-8 accepted (Chromium form)");
    check(selectTextMime({"image/png", "text/plain", "text/html"}) ==
              "text/plain",
          "mime: exact text/plain wins over the other offers");
    check(selectTextMime({"text/html", "text/plain;charset=utf-8"}) ==
              "text/plain;charset=utf-8",
          "mime: charset variant accepted when no exact match");
    check(selectTextMime({"image/png", "text/html"}).empty(),
          "mime: no text MIME offered -> empty");
    check(selectTextMime({}).empty(), "mime: empty offer list -> empty");
    check(selectTextMime({"text/plainx"}).empty(),
          "mime: text/plainx is not text/plain");
  }

  // 3. Fd round-trip through a pipe (writer -> reader, exact bytes).
  {
    const std::string text = "sk-test-key-123\nsecond line\n\xe2\x80\xa2 bullet";
    int fds[2];
    if (pipe(fds) != 0) {
      printf("FAIL - fd: pipe() failed\n");
      return 1;
    }
    check(writeTextToFd(fds[1], text), "fd: write succeeds");
    close(fds[1]);
    std::string got = readTextFromFd(fds[0], kClipboardMaxBytes, 1000);
    close(fds[0]);
    check(got == text, "fd: round-trip carries the exact bytes",
          "got " + std::to_string(got.size()) + " bytes");
  }

  // 3b. Empty text round-trips as empty (EOF with no bytes).
  {
    int fds[2];
    if (pipe(fds) != 0) {
      printf("FAIL - fd: pipe() failed\n");
      return 1;
    }
    check(writeTextToFd(fds[1], ""), "fd: empty write succeeds");
    close(fds[1]);
    std::string got = readTextFromFd(fds[0], kClipboardMaxBytes, 1000);
    close(fds[0]);
    check(got.empty(), "fd: empty text reads back empty");
  }

  // 4. Read cap: a long write is truncated at maxBytes.
  {
    int fds[2];
    if (pipe(fds) != 0) {
      printf("FAIL - fd: pipe() failed\n");
      return 1;
    }
    const std::string big(100, 'x');
    check(writeTextToFd(fds[1], big), "fd: big write succeeds");
    close(fds[1]);
    std::string got = readTextFromFd(fds[0], 10, 1000);
    close(fds[0]);
    check(got.size() == 10 && got == std::string(10, 'x'),
          "fd: read capped at maxBytes");
  }

  // 5. Read timeout: the writer never writes and never closes — the
  // read must give up, not block forever.
  {
    int fds[2];
    if (pipe(fds) != 0) {
      printf("FAIL - fd: pipe() failed\n");
      return 1;
    }
    // fds[1] stays open with nothing written: poll must time out.
    std::string got = readTextFromFd(fds[0], kClipboardMaxBytes, 50);
    close(fds[0]);
    close(fds[1]);
    check(got.empty(), "fd: silent writer times out with empty read");
  }

  if (failures != 0) {
    printf("test-text-clipboard: %d FAILURES\n", failures);
    return 1;
  }
  printf("test-text-clipboard: ALL PASS\n");
  return 0;
}
