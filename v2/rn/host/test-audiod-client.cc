// SevynOS v2 — test driver for the RN host audiod client.
//
// Self-contained: spawns a fake audiod (Unix socket server with
// daemon-faithful semantics — same stable codes, clamped volume, real
// durations from its script) in a thread and drives AudiodClient
// against it, plus transport-failure servers (garbage / silent /
// closing) and a missing socket. No real daemon, no audio hardware,
// no Hermes.
//
// Run: g++ -O2 -std=c++17 -Wall -Wextra -o /tmp/test-audiod-client
//        v2/rn/host/audiod-client.cc v2/rn/host/test-audiod-client.cc -lpthread
//      /tmp/test-audiod-client   (exit 0 on pass)
#include <atomic>
#include <cctype>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>

#include "audiod-client.h"

using namespace sevyn;

namespace {

int g_passed = 0;
int g_failed = 0;

void check(bool cond, const char* name) {
  if (cond) {
    g_passed++;
    printf("ok - %s\n", name);
  } else {
    g_failed++;
    printf("FAIL - %s\n", name);
  }
}

// --- minimal JSON field readers (test-only; the replies are daemon-shaped) ---
bool hasOkTrue(const std::string& json) {
  return json.find("\"ok\":true") != std::string::npos;
}

bool hasOkFalse(const std::string& json) {
  return json.find("\"ok\":false") != std::string::npos;
}

std::string strField(const std::string& json, const std::string& key) {
  std::string pat = "\"" + key + "\":\"";
  size_t at = json.find(pat);
  if (at == std::string::npos)
    return "";
  size_t i = at + pat.size();
  std::string out;
  for (; i < json.size() && json[i] != '"'; i++) {
    if (json[i] == '\\' && i + 1 < json.size())
      out += json[++i];
    else
      out += json[i];
  }
  return out;
}

double numField(const std::string& json, const std::string& key) {
  std::string pat = "\"" + key + "\":";
  size_t at = json.find(pat);
  if (at == std::string::npos)
    return NAN;
  return strtod(json.c_str() + at + pat.size(), nullptr);
}

bool boolField(const std::string& json, const std::string& key) {
  std::string pat = "\"" + key + "\":";
  size_t at = json.find(pat);
  if (at == std::string::npos)
    return false;
  return json.compare(at + pat.size(), 4, "true") == 0;
}

std::string extOf(const std::string& path) {
  size_t dot = path.find_last_of('.');
  if (dot == std::string::npos)
    return "wav";
  std::string ext = path.substr(dot + 1);
  for (char& c : ext)
    c = (char)tolower((unsigned char)c);
  return ext == "mp3" || ext == "flac" || ext == "ogg" ? ext : "wav";
}

// --- fake audiod: stateful, scripted durations, daemon-faithful codes ---
// CALLS is test-only (returns the count of protocol commands handled;
// it does not count itself). The fake never invents a duration, a
// position, or a fake "playing" — the client tests catch it if it does.
struct FakeAudiod {
  bool playing = false;
  bool paused = false;
  double positionSec = 0;
  double durationSec = 0;
  double volume = 100;
  std::string trackPath;
  std::string trackFormat;
  int calls = 0;

  std::string statusJson() {
    char buf[1024];
    if (trackPath.empty()) {
      snprintf(buf, sizeof(buf),
               "{\"ok\":true,\"available\":true,\"playing\":%s,\"paused\":%s,"
               "\"positionSec\":%.3f,\"durationSec\":%.3f,\"volume\":%.0f,"
               "\"track\":null}",
               playing ? "true" : "false", paused ? "true" : "false",
               positionSec, durationSec, volume);
    } else {
      snprintf(buf, sizeof(buf),
               "{\"ok\":true,\"available\":true,\"playing\":%s,\"paused\":%s,"
               "\"positionSec\":%.3f,\"durationSec\":%.3f,\"volume\":%.0f,"
               "\"track\":{\"path\":\"%s\",\"format\":\"%s\","
               "\"durationSec\":%.3f}}",
               playing ? "true" : "false", paused ? "true" : "false",
               positionSec, durationSec, volume, trackPath.c_str(),
               trackFormat.c_str(), durationSec);
    }
    return buf;
  }

  std::string handle(const std::string& line) {
    if (line == "CALLS") {
      char buf[64];
      snprintf(buf, sizeof(buf), "{\"ok\":true,\"calls\":%d}", calls);
      return buf;
    }
    calls++;
    size_t sp = line.find(' ');
    std::string cmd = sp == std::string::npos ? line : line.substr(0, sp);
    std::string arg = sp == std::string::npos ? "" : line.substr(sp + 1);
    if (cmd == "STATUS")
      return statusJson();
    if (cmd == "PLAY") {
      if (arg == "/data/missing.wav")
        return AudiodClient::errorJson("not-found", "audio file not found");
      if (arg == "/data/not-audio.wav")
        return AudiodClient::errorJson("unsupported-format",
                                       "unsupported audio format");
      if (arg == "/data/boom.wav")
        return AudiodClient::errorJson("decode-error",
                                       "not a decodable MP3 file");
      playing = true;
      paused = false;
      positionSec = 0;
      durationSec = arg.size() >= 4 && arg.compare(arg.size() - 4, 4, ".mp3") == 0
                        ? 200
                        : 21.5;
      trackPath = arg;
      trackFormat = extOf(arg);
      return statusJson();
    }
    if (cmd == "PAUSE") {
      if (!playing)
        return AudiodClient::errorJson("idle", "nothing is playing");
      paused = true;
      return statusJson();
    }
    if (cmd == "RESUME") {
      if (!playing)
        return AudiodClient::errorJson("idle", "nothing is playing");
      paused = false;
      return statusJson();
    }
    if (cmd == "STOP") {
      playing = false;
      paused = false;
      positionSec = 0;
      trackPath.clear();
      return statusJson();
    }
    if (cmd == "SEEK") {
      if (!playing)
        return AudiodClient::errorJson("idle", "nothing is playing");
      double seconds = strtod(arg.c_str(), nullptr);
      if (seconds > durationSec)
        return AudiodClient::errorJson(
            "out-of-range",
            "seek is outside 0.." + std::to_string(durationSec));
      positionSec = seconds;
      return statusJson();
    }
    if (cmd == "VOLUME") {
      double v = strtod(arg.c_str(), nullptr);
      if (v < 0)
        v = 0;
      if (v > 100)
        v = 100;
      volume = v;
      return statusJson();
    }
    if (cmd == "SCAN") {
      if (arg == "/data/no-such-dir")
        return AudiodClient::errorJson("not-found",
                                       "cannot list /data/no-such-dir");
      return "{\"ok\":true,\"tracks\":["
             "{\"id\":\"/data/01-sunrise-acoustic.wav\",\"title\":"
             "\"01-sunrise-acoustic\",\"artist\":\"Unknown Artist\",\"album\":"
             "\"Local Library\",\"durationSec\":21.5,\"path\":"
             "\"/data/01-sunrise-acoustic.wav\",\"format\":\"wav\"},"
             "{\"id\":\"/data/song.mp3\",\"title\":\"song\",\"artist\":"
             "\"Unknown Artist\",\"album\":\"Local Library\","
             "\"durationSec\":200,\"path\":\"/data/song.mp3\",\"format\":\"mp3\"}]}";
    }
    return AudiodClient::errorJson("bad-argument", "unknown command");
  }
};

int listenOn(const std::string& path) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return -1;
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path.c_str());
  unlink(path.c_str());
  if (bind(fd, (sockaddr*)&addr, sizeof(addr)) != 0 || listen(fd, 16) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

// Accept loop for the stateful fake. Stops when stopFlag is set (the
// listening socket is shut down from the main thread to unblock
// accept).
void serveFake(int listenFd, FakeAudiod& fake, std::atomic<bool>& stopFlag) {
  while (!stopFlag.load()) {
    int conn = accept(listenFd, nullptr, nullptr);
    if (conn < 0) {
      if (stopFlag.load())
        break;
      continue;
    }
    std::string line;
    char buf[512];
    ssize_t n;
    while ((n = read(conn, buf, sizeof(buf))) > 0) {
      line.append(buf, (size_t)n);
      if (line.find('\n') != std::string::npos)
        break;
    }
    size_t nl = line.find('\n');
    std::string reply = fake.handle(line.substr(0, nl)) + "\n";
    size_t written = 0;
    while (written < reply.size()) {
      ssize_t w = write(conn, reply.data() + written, reply.size() - written);
      if (w <= 0)
        break;
      written += (size_t)w;
    }
    close(conn);
  }
}

// One-shot server with a fixed behaviour for the transport tests.
// Gives up after 30 s without a connection so a client-side failure
// can never hang the test run on join().
enum class OneShot { kGarbage, kSilent, kClosing };

void serveOneShot(const std::string& path, OneShot kind) {
  int listenFd = listenOn(path);
  if (listenFd < 0)
    return;
  struct pollfd pfd {};
  pfd.fd = listenFd;
  pfd.events = POLLIN;
  if (poll(&pfd, 1, 30000) <= 0) {
    close(listenFd);
    return;
  }
  int conn = accept(listenFd, nullptr, nullptr);
  if (conn < 0) {
    close(listenFd);
    return;
  }
  char buf[512];
  std::string line;
  ssize_t n;
  while ((n = read(conn, buf, sizeof(buf))) > 0) {
    line.append(buf, (size_t)n);
    if (line.find('\n') != std::string::npos)
      break;
  }
  if (kind == OneShot::kGarbage) {
    const char* garbage = "this is not json\n";
    (void)!write(conn, garbage, strlen(garbage));
  } else if (kind == OneShot::kSilent) {
    // Never answers; the client must time out, not hang.
    sleep(10);
  }
  // kClosing: just close without answering.
  close(conn);
  close(listenFd);
}

// Ask the fake (over a raw socket) how many protocol commands it has
// handled. Returns -1 when the query itself fails.
int fakeCalls(const std::string& fakePath) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return -1;
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", fakePath.c_str());
  if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
    close(fd);
    return -1;
  }
  const char* q = "CALLS\n";
  if (write(fd, q, strlen(q)) < 0) {
    close(fd);
    return -1;
  }
  char buf[128];
  ssize_t n = read(fd, buf, sizeof(buf) - 1);
  close(fd);
  if (n <= 0)
    return -1;
  buf[n] = '\0';
  return (int)numField(buf, "calls");
}

} // namespace

int main() {
  signal(SIGPIPE, SIG_IGN);
  char tmpTemplate[] = "/tmp/sevyn-audiod-test-XXXXXX";
  if (mkdtemp(tmpTemplate) == nullptr) {
    printf("FAIL - mkdtemp\n");
    return 1;
  }
  std::string dir = tmpTemplate;
  std::string fakePath = dir + "/audiod.sock";
  std::string garbagePath = dir + "/garbage.sock";
  std::string silentPath = dir + "/silent.sock";
  std::string closingPath = dir + "/closing.sock";

  int fakeFd = listenOn(fakePath);
  if (fakeFd < 0) {
    printf("FAIL - fake listen\n");
    return 1;
  }
  FakeAudiod fake;
  std::atomic<bool> stopFake{false};
  std::thread fakeThread(serveFake, fakeFd, std::ref(fake),
                         std::ref(stopFake));
  std::thread garbageThread(serveOneShot, garbagePath, OneShot::kGarbage);
  std::thread silentThread(serveOneShot, silentPath, OneShot::kSilent);
  std::thread closingThread(serveOneShot, closingPath, OneShot::kClosing);
  // The one-shot servers bind lazily in their threads; give them a
  // moment so the client never races a missing socket file.
  usleep(200 * 1000);

  AudiodClient client(fakePath, 5000);

  // --- playback reports the daemon's real duration and position ---
  {
    std::string s = client.play("/data/01-sunrise-acoustic.wav");
    check(hasOkTrue(s), "play: ok");
    check(boolField(s, "playing"), "play: playing");
    check(numField(s, "durationSec") == 21.5, "play: daemon duration 21.5");
    check(numField(s, "positionSec") == 0, "play: position 0");
    check(strField(s, "format") == "wav", "play: track format wav");
    // Position comes from the daemon, not a client clock: seek moves
    // it, and two status calls with no seek in between agree.
    std::string sought = client.seek(10);
    check(numField(sought, "positionSec") == 10, "seek: position 10");
    std::string st1 = client.status();
    std::string st2 = client.status();
    check(numField(st1, "positionSec") == 10 &&
              numField(st2, "positionSec") == 10,
          "status: position stable without a client clock");
    check(hasOkTrue(client.stop()), "stop: ok");
  }

  // --- daemon error codes pass through ---
  {
    std::string s = client.play("/data/missing.wav");
    check(hasOkFalse(s) && strField(s, "code") == "not-found",
          "play missing: not-found code");
    s = client.play("/data/not-audio.wav");
    check(hasOkFalse(s) && strField(s, "code") == "unsupported-format",
          "play non-audio: unsupported-format code");
    s = client.play("/data/boom.wav");
    check(hasOkFalse(s) && strField(s, "code") == "decode-error",
          "play undecodable: decode-error code");
    check(!boolField(client.status(), "playing"),
          "status: still not playing after failures");
  }

  // --- bad play arguments are rejected before any I/O ---
  {
    int before = fakeCalls(fakePath);
    for (const char* bad : {"", "relative/path.wav", "   "}) {
      std::string s = client.play(bad);
      check(hasOkFalse(s) && strField(s, "code") == "bad-argument",
            "play bad path rejected with bad-argument");
    }
    check(before >= 0 && fakeCalls(fakePath) == before,
          "play bad path: no I/O reached the daemon");
  }

  // --- idle guards ---
  {
    check(hasOkTrue(client.stop()), "stop while idle: ok");
    std::string s = client.pause();
    check(hasOkFalse(s) && strField(s, "code") == "idle",
          "pause while idle: idle code");
    s = client.resume();
    check(hasOkFalse(s) && strField(s, "code") == "idle",
          "resume while idle: idle code");
    s = client.seek(5);
    check(hasOkFalse(s) && strField(s, "code") == "idle",
          "seek while idle: idle code");
  }

  // --- pause / resume / seek flow with daemon positions ---
  {
    check(hasOkTrue(client.play("/data/01-sunrise-acoustic.wav")),
          "flow: play ok");
    std::string paused = client.pause();
    check(boolField(paused, "paused"), "flow: paused");
    std::string resumed = client.resume();
    check(!boolField(resumed, "paused"), "flow: resumed");
    std::string sought = client.seek(10);
    check(numField(sought, "positionSec") == 10, "flow: seek 10");
    std::string stopped = client.stop();
    check(!boolField(stopped, "playing") &&
              numField(stopped, "positionSec") == 0,
          "flow: stopped, position 0");
  }

  // --- bad seeks rejected before I/O; out-of-range from the daemon ---
  {
    check(hasOkTrue(client.play("/data/01-sunrise-acoustic.wav")),
          "seek guards: play ok");
    int before = fakeCalls(fakePath);
    for (double bad : {(double)NAN, (double)INFINITY, -1.0}) {
      std::string s = client.seek(bad);
      check(hasOkFalse(s) && strField(s, "code") == "bad-argument",
            "seek bad value rejected with bad-argument");
    }
    check(before >= 0 && fakeCalls(fakePath) == before,
          "seek bad value: no I/O reached the daemon");
    std::string s = client.seek(9999);
    check(hasOkFalse(s) && strField(s, "code") == "out-of-range",
          "seek past end: out-of-range code");
    check(boolField(client.status(), "playing"),
          "seek guards: still playing after bad seeks");
    check(hasOkTrue(client.stop()), "seek guards: stop ok");
  }

  // --- volume clamps like the daemon; non-numbers rejected ---
  {
    check(hasOkTrue(client.play("/data/01-sunrise-acoustic.wav")),
          "volume: play ok");
    check(numField(client.setVolume(50), "volume") == 50, "volume 50");
    check(numField(client.setVolume(150), "volume") == 100,
          "volume 150 clamps to 100");
    check(numField(client.setVolume(-5), "volume") == 0,
          "volume -5 clamps to 0");
    int before = fakeCalls(fakePath);
    for (double bad : {(double)NAN, (double)INFINITY, (double)-INFINITY}) {
      std::string s = client.setVolume(bad);
      check(hasOkFalse(s) && strField(s, "code") == "bad-argument",
            "volume non-finite rejected with bad-argument");
    }
    check(before >= 0 && fakeCalls(fakePath) == before,
          "volume non-finite: no I/O reached the daemon");
    std::string st = client.status();
    check(boolField(st, "playing") && numField(st, "volume") == 0,
          "volume: still playing at 0 after bad volumes");
    check(hasOkTrue(client.stop()), "volume: stop ok");
  }

  // --- scan reports the daemon's real durations ---
  {
    std::string s = client.scan("/data");
    check(hasOkTrue(s), "scan: ok");
    check(s.find("21.5") != std::string::npos &&
              s.find("\"durationSec\":200") != std::string::npos,
          "scan: real durations 21.5 and 200");
    check(s.find("210") == std::string::npos,
          "scan: no hardcoded duration");
    s = client.scan("/data/no-such-dir");
    check(hasOkFalse(s) && strField(s, "code") == "not-found",
          "scan missing dir: not-found code");
    int before = fakeCalls(fakePath);
    s = client.scan(std::string(""));
    check(hasOkFalse(s) && strField(s, "code") == "bad-argument",
          "scan empty dir: bad-argument code");
    check(before >= 0 && fakeCalls(fakePath) == before,
          "scan empty dir: no I/O reached the daemon");
    s = client.scan(std::nullopt);
    check(hasOkTrue(s), "scan default dir: ok");
  }

  // --- transport failure becomes audio-unavailable; client survives ---
  {
    AudiodClient dead(dir + "/no-such-daemon.sock", 1000);
    std::string s = dead.status();
    check(hasOkFalse(s) && strField(s, "code") == "audio-unavailable",
          "no daemon: audio-unavailable code");
    check(hasOkTrue(client.play("/data/01-sunrise-acoustic.wav")),
          "client usable after a transport failure");
    check(hasOkTrue(client.stop()), "transport: stop ok");
  }

  // --- storm of bad calls: all settle, none hang, playback works ---
  {
    int bad = 0;
    for (int i = 0; i < 5; i++) {
      for (const std::string& s :
           {client.play(""), client.play("/data/missing.wav"),
            client.play("/data/not-audio.wav"), client.seek(NAN),
            client.seek(-1), client.setVolume(NAN), client.pause(),
            client.resume(), client.scan(std::string("")),
            client.scan("/data/no-such-dir")}) {
        if (hasOkFalse(s) && !strField(s, "code").empty())
          bad++;
      }
    }
    check(bad == 50, "storm: 50 bad calls all settle with a code");
    std::string s = client.play("/data/01-sunrise-acoustic.wav");
    check(hasOkTrue(s) && numField(s, "durationSec") == 21.5,
          "storm: playback still works after");
    check(hasOkTrue(client.stop()), "storm: stop ok");
  }

  // --- transport servers: garbage / silent / closing ---
  {
    AudiodClient garbage(garbagePath, 1000);
    std::string s = garbage.status();
    check(hasOkFalse(s) && strField(s, "code") == "audio-unavailable",
          "garbage reply: audio-unavailable code");
    AudiodClient closing(closingPath, 1000);
    s = closing.status();
    check(hasOkFalse(s) && strField(s, "code") == "audio-unavailable",
          "close without answer: audio-unavailable code");
    AudiodClient silent(silentPath, 200);
    s = silent.status();
    check(hasOkFalse(s) && strField(s, "code") == "audio-unavailable",
          "silent daemon: audio-unavailable code (timeout, no hang)");
  }

  stopFake.store(true);
  shutdown(fakeFd, SHUT_RDWR);
  close(fakeFd);
  fakeThread.join();
  garbageThread.join();
  closingThread.join();
  // The silent thread sleeps 10 s on its accepted socket; detach it
  // rather than blocking the test run (the process exits anyway).
  silentThread.detach();

  printf("\n%d audiod-client checks passed, %d failed\n", g_passed, g_failed);
  return g_failed == 0 ? 0 : 1;
}
