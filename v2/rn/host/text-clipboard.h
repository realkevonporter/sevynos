// SevynOS v2 — text clipboard plumbing (gap build unit 2).
//
// Dependency-free (no Wayland headers), so the store, the MIME
// negotiation, and the fd transfer are unit-testable without a
// compositor — see test-text-clipboard.cc. The Wayland layer
// (wayland.cc) owns one TextClipboard as its cache of the compositor
// selection; the host (sevyn-rn-host.cc) keeps a second one for
// headless mode, where there is no compositor at all.
//
// The clipboard NEVER logs its contents: the bytes are the user's
// text (an API key, a password, a message) and must not land in a
// log, a marker, or a persisted file.
#pragma once

#include <cerrno>
#include <cstddef>
#include <cstring>
#include <poll.h>
#include <string>
#include <unistd.h>
#include <vector>

namespace sevyn {

// MIME type offered for text copy, and accepted on paste. Chromium
// offers "text/plain;charset=utf-8" alongside "text/plain"; see
// selectTextMime.
inline constexpr const char* kClipboardTextMime = "text/plain";
// Paste cap: a paste larger than this is truncated. A key is tens
// of bytes and a pasted document stays usable; a hostile source
// cannot OOM the host through the clipboard.
inline constexpr size_t kClipboardMaxBytes = 1024 * 1024;

class TextClipboard {
 public:
  void set(const std::string& text) { text_ = text; }
  const std::string& get() const { return text_; }
  void clear() { text_.clear(); }
  bool empty() const { return text_.empty(); }

 private:
  std::string text_;
};

// Best text MIME from an offer's list: exact "text/plain" first,
// then any "text/plain;..." variant (e.g. Chromium's
// "text/plain;charset=utf-8"). "" when nothing offered is text.
inline std::string selectTextMime(const std::vector<std::string>& mimes) {
  for (const std::string& mime : mimes) {
    if (mime == kClipboardTextMime)
      return mime;
  }
  for (const std::string& mime : mimes) {
    if (mime.rfind("text/plain;", 0) == 0)
      return mime;
  }
  return "";
}

// Write the whole text to fd (the wl_data_source.send side — the
// compositor hands us the fd when another client asks for our
// selection). Returns false on a short or failed write. Does NOT
// close fd; the caller owns it.
inline bool writeTextToFd(int fd, const std::string& text) {
  size_t off = 0;
  while (off < text.size()) {
    ssize_t n = ::write(fd, text.data() + off, text.size() - off);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      return false;
    }
    if (n == 0)
      return false;
    off += static_cast<size_t>(n);
  }
  return true;
}

// Read until EOF (the wl_data_offer.receive side — the source writes
// the selection, then closes its end), capped at maxBytes, giving up
// after timeoutMs with whatever arrived ("" on a clean timeout with
// nothing read, so a source that never answers cannot stall the
// host's dispatch loop). Does NOT close fd; the caller owns it.
inline std::string readTextFromFd(int fd, size_t maxBytes, int timeoutMs) {
  std::string out;
  char buf[4096];
  int remainingMs = timeoutMs;
  while (out.size() < maxBytes) {
    pollfd pfd{fd, POLLIN, 0};
    int pr = ::poll(&pfd, 1, remainingMs);
    if (pr < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (pr == 0)
      break; // Timeout: keep what arrived (possibly "").
    size_t want = maxBytes - out.size();
    if (want > sizeof(buf))
      want = sizeof(buf);
    ssize_t n = ::read(fd, buf, want);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (n == 0)
      break; // EOF: the source finished writing.
    out.append(buf, static_cast<size_t>(n));
    // Data arrived: the source is alive — give the rest of the
    // transfer a fresh window instead of the shrinking remainder.
    remainingMs = timeoutMs;
  }
  return out;
}

} // namespace sevyn
