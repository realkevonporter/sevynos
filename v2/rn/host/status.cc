// SevynOS v2 M2 — statusd subscriber (see status.h).
#include "status.h"

#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "common.h"

namespace sevyn {

namespace {
const char* kSockPath = "/run/sevyn-status.sock";
}

StatusClient::StatusClient() = default;

StatusClient::~StatusClient() { stop(); }

void StatusClient::start() {
  if (thread_.joinable())
    return;
  stopping_ = false;
  thread_ = std::thread([this] { run(); });
}

void StatusClient::stop() {
  stopping_ = true;
  if (thread_.joinable())
    thread_.join();
}

void StatusClient::run() {
  while (!stopping_) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
      sleep(1);
      continue;
    }
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", kSockPath);
    if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
      close(fd);
      sleep(1);
      continue;
    }
    (void)!write(fd, "SUBSCRIBE\n", 10);
    char buf[256];
    char linebuf[512];
    size_t lineLen = 0;
    ssize_t n;
    while (!stopping_ && (n = read(fd, buf, sizeof(buf))) > 0) {
      for (ssize_t i = 0; i < n; i++) {
        if (buf[i] == '\n') {
          linebuf[lineLen] = '\0';
          lineLen = 0;
          // STATUS <key> <value>
          if (strncmp(linebuf, "STATUS ", 7) == 0) {
            char* key = linebuf + 7;
            char* sp = strchr(key, ' ');
            if (sp && handler_) {
              *sp = '\0';
              handler_(key, sp + 1);
            }
          }
        } else if (lineLen < sizeof(linebuf) - 1) {
          linebuf[lineLen++] = buf[i];
        }
      }
    }
    close(fd);
    if (!stopping_)
      sleep(1);
  }
}

} // namespace sevyn
