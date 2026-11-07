// SevynOS v2 M3 — appd client (see appclient.h).
#include "appclient.h"

#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "common.h"

namespace sevyn {

namespace {
const char* kSockPath = "/run/sevyn-apps.sock";

// Split a "|" list line ("id|name|version|color|glyph|system=0|
// protected=0|perms=a,b|key=...") into an AppInfo. Returns false when
// the line does not have the expected shape.
bool parseAppLine(const std::string& line, AppInfo& out) {
  std::vector<std::string> parts;
  size_t start = 0;
  for (;;) {
    size_t bar = line.find('|', start);
    if (bar == std::string::npos) {
      parts.push_back(line.substr(start));
      break;
    }
    parts.push_back(line.substr(start, bar - start));
    start = bar + 1;
  }
  if (parts.size() < 9)
    return false;
  out.id = parts[0];
  out.name = parts[1];
  out.version = parts[2];
  out.color = parts[3];
  out.glyph = parts[4];
  out.system = parts[5] == "system=1";
  out.protected_ = parts[6] == "protected=1";
  if (parts[7].rfind("perms=", 0) == 0) {
    std::string perms = parts[7].substr(6);
    size_t s = 0;
    while (s < perms.size()) {
      size_t comma = perms.find(',', s);
      if (comma == std::string::npos) {
        out.permissions.push_back(perms.substr(s));
        break;
      }
      out.permissions.push_back(perms.substr(s, comma - s));
      s = comma + 1;
    }
  }
  return true;
}

int connectAppd() {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return -1;
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", kSockPath);
  if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

// Read newline-terminated lines from fd until `until` (a line prefix)
// is seen or the socket closes. Returns all lines read.
std::vector<std::string> readLinesUntil(int fd, const char* until) {
  std::vector<std::string> lines;
  char buf[1024];
  std::string pending;
  ssize_t n;
  while ((n = read(fd, buf, sizeof(buf))) > 0) {
    pending.append(buf, (size_t)n);
    size_t pos;
    while ((pos = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, pos);
      pending.erase(0, pos + 1);
      if (!line.empty() && line.back() == '\r')
        line.pop_back();
      lines.push_back(line);
      if (until && line.rfind(until, 0) == 0)
        return lines;
    }
  }
  return lines;
}

} // namespace

AppClient::AppClient() = default;

AppClient::~AppClient() { stop(); }

void AppClient::start() {
  if (thread_.joinable())
    return;
  stopping_ = false;
  thread_ = std::thread([this] { run(); });
}

void AppClient::stop() {
  stopping_ = true;
  int fd = fd_.load();
  if (fd >= 0)
    shutdown(fd, SHUT_RDWR);
  if (thread_.joinable())
    thread_.join();
}

std::vector<std::string> AppClient::command(
    const std::vector<std::string>& lines, int retries, int retryMs) {
  for (int attempt = 0; attempt <= retries; attempt++) {
    int fd = connectAppd();
    if (fd < 0) {
      if (attempt < retries)
        usleep((useconds_t)retryMs * 1000);
      continue;
    }
    for (const auto& line : lines) {
      std::string out = line + "\n";
      if ((size_t)write(fd, out.data(), out.size()) != out.size()) {
        close(fd);
        fd = -1;
        break;
      }
    }
    if (fd < 0) {
      if (attempt < retries)
        usleep((useconds_t)retryMs * 1000);
      continue;
    }
    // One-shot commands get exactly one reply line, except LIST
    // (APP lines, then "OK list"). Read until OK/ERR.
    std::vector<std::string> reply;
    char buf[1024];
    std::string pending;
    ssize_t n;
    bool done = false;
    while (!done && (n = read(fd, buf, sizeof(buf))) > 0) {
      pending.append(buf, (size_t)n);
      size_t pos;
      while ((pos = pending.find('\n')) != std::string::npos) {
        std::string line = pending.substr(0, pos);
        pending.erase(0, pos + 1);
        if (!line.empty() && line.back() == '\r')
          line.pop_back();
        reply.push_back(line);
        if (line.rfind("OK", 0) == 0 || line.rfind("ERR", 0) == 0)
          done = true;
        if (done)
          break;
      }
    }
    close(fd);
    return reply;
  }
  return {};
}

std::vector<AppInfo> AppClient::listApps() {
  std::vector<std::string> reply = command({"LIST"}, 25, 200);
  std::vector<AppInfo> apps;
  for (const auto& line : reply) {
    if (line.rfind("APP ", 0) != 0)
      continue;
    AppInfo info;
    if (parseAppLine(line.substr(4), info))
      apps.push_back(info);
  }
  return apps;
}

bool AppClient::launchApp(const std::string& id) {
  std::vector<std::string> reply =
      command({"LAUNCH " + id}, 10, 200);
  for (const auto& line : reply) {
    if (line.rfind("OK launched", 0) == 0)
      return true;
  }
  return false;
}

void AppClient::run() {
  while (!stopping_) {
    int fd = connectAppd();
    if (fd < 0) {
      sleep(1);
      continue;
    }
    (void)!write(fd, "SUBSCRIBE\n", 10);
    fd_.store(fd);
    char buf[512];
    std::string pending;
    ssize_t n;
    while (!stopping_ && (n = read(fd, buf, sizeof(buf))) > 0) {
      pending.append(buf, (size_t)n);
      size_t pos;
      while ((pos = pending.find('\n')) != std::string::npos) {
        std::string line = pending.substr(0, pos);
        pending.erase(0, pos + 1);
        if (!line.empty() && line.back() == '\r')
          line.pop_back();
        if (eventHandler_)
          eventHandler_(line);
      }
    }
    close(fd);
    fd_.store(-1);
    if (!stopping_)
      sleep(1);
  }
}

} // namespace sevyn
