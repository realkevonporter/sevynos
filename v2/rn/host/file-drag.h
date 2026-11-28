// SevynOS v2 — file-drag plumbing (gap build unit 15, audit #18).
//
// Dependency-free (no Wayland headers), so the URI-list build/parse
// and the MIME negotiation are unit-testable without a compositor —
// see test-file-drag.cc. The Wayland layer (wayland.cc) owns the
// data source / data offer; the host (sevyn-rn-host.cc) owns the
// JS bridge (Sevyn.startFileDrag / onDragDrop).
//
// The drag carries absolute file paths as a `text/uri-list` body
// (one `file://` URI per line). The bytes are the user's file paths
// — the host never logs them, only the MIME type and the count, the
// same rule as the text clipboard.
#pragma once

#include <cstddef>
#include <cstring>
#include <string>
#include <vector>

namespace sevyn {

// MIME type offered for a file drag, and accepted on drop. The
// standard URI list — any Wayland file manager speaks it.
inline constexpr const char* kFileDragMime = "text/uri-list";
// Drop cap: a URI list larger than this is truncated. A drag of a
// hundred files is a few KB; a hostile source cannot OOM the host
// through a drop.
inline constexpr size_t kFileDragMaxBytes = 1024 * 1024;

namespace detail {

// Percent-encode one byte (uppercase hex, the URI-list convention).
inline std::string percentEncodeByte(unsigned char c) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out;
  out += '%';
  out += kHex[(c >> 4) & 0xF];
  out += kHex[c & 0xF];
  return out;
}

// True for a byte that rides unencoded in a file URI: the RFC 3986
// unreserved set, plus '/' (the path separator — encodeURI leaves
// it alone, and so do we).
inline bool isUriSafe(unsigned char c) {
  if (c >= 'A' && c <= 'Z')
    return true;
  if (c >= 'a' && c <= 'z')
    return true;
  if (c >= '0' && c <= '9')
    return true;
  switch (c) {
    case '-':
    case '_':
    case '.':
    case '~':
    case '/':
      return true;
    default:
      return false;
  }
}

inline int hexValue(char c) {
  if (c >= '0' && c <= '9')
    return c - '0';
  if (c >= 'A' && c <= 'F')
    return c - 'A' + 10;
  if (c >= 'a' && c <= 'f')
    return c - 'a' + 10;
  return -1;
}

} // namespace detail

// `file://` URI for one absolute path. Only the unreserved set and
// '/' ride unencoded; everything else (spaces, UTF-8 bytes, '#',
// '?') is percent-encoded, so the URI list stays one URI per line.
inline std::string fileUriForPath(const std::string& path) {
  std::string uri = "file://";
  for (char ch : path) {
    auto c = static_cast<unsigned char>(ch);
    if (detail::isUriSafe(c)) {
      uri += ch;
    } else {
      uri += detail::percentEncodeByte(c);
    }
  }
  return uri;
}

// The `text/uri-list` body for a set of absolute paths: one URI per
// line, trailing newline (the RFC 2483 convention).
inline std::string buildUriList(const std::vector<std::string>& paths) {
  std::string out;
  for (const std::string& path : paths) {
    out += fileUriForPath(path);
    out += '\n';
  }
  return out;
}

// Parse a `text/uri-list` body back into absolute paths. Comment
// lines (`#...`) and blank lines are skipped; only `file://` URIs
// with an absolute path survive — anything else is dropped, never
// trusted, because the bytes come from another client. A malformed
// percent-escape drops that line, not the whole list.
inline std::vector<std::string> parseUriList(const std::string& text) {
  std::vector<std::string> paths;
  size_t pos = 0;
  while (pos <= text.size()) {
    size_t end = text.find('\n', pos);
    if (end == std::string::npos)
      end = text.size();
    std::string line = text.substr(pos, end - pos);
    if (!line.empty() && line.back() == '\r')
      line.pop_back();
    // Trim leading/trailing spaces (a sloppy source may pad lines).
    size_t first = line.find_first_not_of(" \t");
    size_t last = line.find_last_not_of(" \t");
    if (first != std::string::npos)
      line = line.substr(first, last - first + 1);
    else
      line.clear();
    if (!line.empty() && line[0] != '#' &&
        line.rfind("file://", 0) == 0) {
      std::string raw = line.substr(strlen("file://"));
      std::string decoded;
      bool ok = true;
      for (size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] == '%') {
          if (i + 2 >= raw.size()) {
            ok = false;
            break;
          }
          int hi = detail::hexValue(raw[i + 1]);
          int lo = detail::hexValue(raw[i + 2]);
          if (hi < 0 || lo < 0) {
            ok = false;
            break;
          }
          decoded += static_cast<char>((hi << 4) | lo);
          i += 2;
        } else {
          decoded += raw[i];
        }
      }
      if (ok && !decoded.empty() && decoded[0] == '/')
        paths.push_back(decoded);
    }
    if (end == text.size())
      break;
    pos = end + 1;
  }
  return paths;
}

// The file MIME from an offer's list: exact "text/uri-list" only —
// a suffixed variant would be a different type. "" when the offer
// carries no files.
inline std::string selectFileMime(const std::vector<std::string>& mimes) {
  for (const std::string& mime : mimes) {
    if (mime == kFileDragMime)
      return mime;
  }
  return "";
}

} // namespace sevyn
