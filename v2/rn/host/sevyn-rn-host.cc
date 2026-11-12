// SevynOS v2 M3 — the React Native host (sevyn-rn-host).
//
// One process, one app: the shell (fullscreen, --bundle defaults to
// the shell) or a sandboxed app window (--app <id>, 800x500, its own
// Hermes runtime — a crashing app never takes down the shell).
// Embeds Hermes, lays out with Yoga, paints to a Wayland surface,
// forwards pointer/keyboard input and statusd broadcasts to JS, and
// talks to sevyn-appd for the app list, launching, and app events.
// See v2/rn/README.md for the host ↔ JS contract.
//
// Usage: sevyn-rn-host [--bundle <path>] [--width <px>] [--height <px>]
//                      [--app <id>] [--name <name>] [--color <#rrggbb>]
//                      [--glyph <letter>] [--permissions <csv>]
//                      [--headless] [--headless-seconds <n>]
//                      [--headless-out <path>] [--headless-input <path>]
//   bundle default: /usr/share/sevyn/shell/shell.hbc
//   size default: 1024x768 (the Weston output mode); apps use 800x500
//   headless (M6): no Wayland surface — the bundle still runs and
//   presents, but ops go to a JSON dump (--headless-out) and input
//   arrives from a timed event file (--headless-input); the run ends
//   after --headless-seconds (exit 0).
#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <poll.h>
#include <queue>
#include <set>
#include <sstream>
#include <string>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <unordered_map>
#include <vector>

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include "appclient.h"
#include "common.h"
#include "painter.h"
#include "status.h"
#include "wayland.h"
#include "yoga-bridge.h"

namespace {

using namespace sevyn;
using namespace facebook;

constexpr int kDefaultWidth = 1024;
constexpr int kDefaultHeight = 768;
constexpr const char* kDefaultBundle = "/usr/share/sevyn/shell/shell.hbc";

// --- small JSI helpers ---
std::string jsString(jsi::Runtime& rt, const jsi::Value& v) {
  if (v.isString())
    return v.asString(rt).utf8(rt);
  return "";
}

double jsNumber(jsi::Runtime& rt, const jsi::Value& v, double fallback = 0) {
  (void)rt;
  if (v.isNumber())
    return v.asNumber();
  return fallback;
}

bool jsBool(jsi::Runtime& rt, const jsi::Value& v, bool fallback = false) {
  (void)rt;
  if (v.isBool())
    return v.asBool();
  return fallback;
}

jsi::Value jsProp(jsi::Runtime& rt, const jsi::Object& obj, const char* name) {
  return obj.getProperty(rt, name);
}

bool hasProp(jsi::Runtime& rt, const jsi::Object& obj, const char* name) {
  jsi::Value v = obj.getProperty(rt, name);
  return !v.isUndefined() && !v.isNull();
}

// --- Sevyn.exec: one-shot fork/exec of /usr/local/bin/sevyn only ---
// The Terminal app's only way to run commands: the host forks, the
// child execs the CLI (no shell, no pipes, no other binaries), the
// parent reads stdout+stderr with a 10 s timeout. Runs synchronously
// on the JS thread — commands are fast; a hung command blocks the UI
// for at most the timeout. The command line is split on whitespace
// with a 64-token cap; a double-quoted span is one token with the
// quotes stripped and \" / \\ unescaped (M9 — wifi SSIDs and
// passwords with spaces: `sevyn net wifi connect "My Network"
// "my pass"`). Unquoted input tokenizes exactly as before. Returns
// "<exit-code>\n<output>" (output capped at 64 KiB). Logs EXEC
// <cmdline> -> <code> to serial, which is what the M4 harness
// asserts on.
constexpr const char* kSevynCli = "/usr/local/bin/sevyn";

std::string runSevyn(const std::string& cmdline) {
  std::vector<std::string> tokens;
  {
    std::string cur;
    bool inQuotes = false;
    bool haveToken = false;
    for (size_t i = 0; i < cmdline.size() && tokens.size() < 64; i++) {
      char c = cmdline[i];
      if (inQuotes && c == '\\' && i + 1 < cmdline.size() &&
          (cmdline[i + 1] == '"' || cmdline[i + 1] == '\\')) {
        cur += cmdline[i + 1];
        i++;
        haveToken = true;
        continue;
      }
      if (c == '"') {
        inQuotes = !inQuotes;
        haveToken = true;
        continue;
      }
      if (!inQuotes &&
          (c == ' ' || c == '\t' || c == '\n' || c == '\r')) {
        if (haveToken) {
          tokens.push_back(cur);
          cur.clear();
          haveToken = false;
        }
        continue;
      }
      cur += c;
      haveToken = true;
    }
    // 64 tokens: the M6 check writes long headless input files
    // through `sevyn files write` (18+ whitespace-separated tokens);
    // a 16-token cap silently dropped the last tap's coordinates, so
    // the login submit never fired and the failure looked like a dead
    // button.
    if (haveToken && tokens.size() < 64)
      tokens.push_back(cur);
  }
  if (tokens.empty() || tokens[0] != "sevyn")
    return "ERR only the sevyn command is allowed";
  // `sevyn install install` copies ~400 MiB (kernel + initramfs) onto
  // the new ESP and builds the data partition — a legitimate
  // long-running disk operation. Under TCG it takes well over the
  // 10 s exec deadline (on KVM it is ~5 s), so the host would SIGKILL
  // it with exit 124 and the install would never complete. Give the
  // install verb a 300 s deadline (matching the M11 check's termCmd
  // timeout); every other command keeps the 10 s limit so a hung
  // command still cannot block the UI for long.
  const bool isInstall =
      tokens.size() >= 3 && tokens[1] == "install" && tokens[2] == "install";
  const int execTimeoutSec = isInstall ? 300 : 10;
  std::vector<char*> argv;
  for (auto& t : tokens)
    argv.push_back(t.data());
  argv.push_back(nullptr);
  int pipefd[2];
  if (pipe(pipefd) != 0)
    return "ERR cannot create pipe";
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return "ERR fork failed";
  }
  if (pid == 0) {
    // Child: async-signal-safe calls only, then exec.
    close(pipefd[0]);
    int nullfd = open("/dev/null", O_RDONLY);
    if (nullfd >= 0)
      dup2(nullfd, STDIN_FILENO);
    dup2(pipefd[1], STDOUT_FILENO);
    dup2(pipefd[1], STDERR_FILENO);
    if (pipefd[1] > STDERR_FILENO)
      close(pipefd[1]);
    execv(kSevynCli, argv.data());
    const char* msg = "ERR cannot exec the sevyn CLI\n";
    (void)!write(STDERR_FILENO, msg, strlen(msg));
    _exit(127);
  }
  close(pipefd[1]);
  std::string out;
  char buf[4096];
  auto deadline = std::chrono::steady_clock::now() +
                  std::chrono::seconds(execTimeoutSec);
  int status = 0;
  bool timedOut = false;
  while (out.size() < 65536) {
    struct pollfd pfd = { .fd = pipefd[0], .events = POLLIN };
    auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      timedOut = true;
      break;
    }
    int timeoutMs =
        (int)std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - now)
            .count();
    int pr = poll(&pfd, 1, timeoutMs);
    if (pr < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (pr == 0) {
      timedOut = true;
      break;
    }
    ssize_t r = read(pipefd[0], buf, sizeof(buf));
    if (r < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (r == 0)
      break;
    out.append(buf, (size_t)r);
  }
  if (timedOut)
    kill(pid, SIGKILL);
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }
  close(pipefd[0]);
  int code = 124;
  if (!timedOut) {
    if (WIFEXITED(status))
      code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status))
      code = 128 + WTERMSIG(status);
  }
  logLine("EXEC %s -> %d", cmdline.c_str(), code);
  return std::to_string(code) + "\n" + out;
}

// --- Sevyn.execAsync: the same CLI run, off the JS thread ---------
// Sevyn.exec is synchronous: a 5 s socket.io long-poll blocks the JS
// thread for 5 s, and back-to-back polls starve the app (the feed
// never paints, taps land on stale layouts). execAsync returns a JS
// Promise instead: a worker thread runs runSevyn (self-contained,
// fork/exec/wait) and posts {resolve, result} to a completion queue
// the main loop drains on the JS thread, where resolve is called.
// The resolve function stays alive via the Promise the JS side holds
// (the shim's request chain), so the C++ copy is only an alias.
// The queue is file-static (one host per process) so a worker never
// captures the RnHost — a detached thread must not dangle `this` if
// the host exits while a command is still running.
struct ExecCompletion {
  jsi::Function resolve;
  std::string result;
};
std::mutex g_execMutex;
std::queue<ExecCompletion> g_execCompletions;
class RnHost {
 public:
  RnHost(int width, int height, std::string bundle, std::string appId,
         std::string appName, std::string appColor, std::string appGlyph,
         std::set<std::string> permissions, bool headless = false,
         int headlessSeconds = 0, std::string headlessOut = "",
         std::string headlessInput = "")
      : width_(width),
        height_(height),
        bundle_(std::move(bundle)),
        appId_(std::move(appId)),
        appName_(std::move(appName)),
        appColor_(std::move(appColor)),
        appGlyph_(std::move(appGlyph)),
        permissions_(std::move(permissions)),
        headless_(headless),
        headlessSeconds_(headlessSeconds),
        headlessOut_(std::move(headlessOut)),
        headlessInput_(std::move(headlessInput)) {}

  // Stop the subscriber threads FIRST, while every member their
  // handlers touch (statusMutex_/statusQueue_/statusSnapshot_,
  // appEventMutex_/appEventQueue_) is still alive. Members are
  // destroyed in reverse declaration order, so without this a thread
  // could fire its handler on already destroyed members during
  // teardown — seen in CI as a segfault when a STATUS broadcast
  // arrived while the host was exiting.
  ~RnHost() {
    if (appClient_)
      appClient_->stop();
    if (status_)
      status_->stop();
    // Free the Yoga tree and the Wayland display BEFORE the Hermes
    // runtime is destroyed (it is a later member, so implicit
    // destruction would free them after it). Yoga nodes hold measure
    // lambdas capturing shared_ptr<jsi::Function>; releasing the last
    // copy into a dead runtime segfaults — seen in CI run 42362676981
    // as a browser segfault on window-close exit (the only path that
    // runs a clean teardown; SIGTERM kills never reach this code).
    yoga_.reset();
    wayland_.reset();
  }

  int run();

 private:
  void installSevyn(jsi::Runtime& rt);
  void installTimers(jsi::Runtime& rt);
  void fireDueTimers(jsi::Runtime& rt);
  double nowMs() const;
  void installYoga(jsi::Runtime& rt, jsi::Object& sevyn);
  void applyStyle(jsi::Runtime& rt, int nodeId, const jsi::Object& style);
  void applyDimension(jsi::Runtime& rt, int nodeId, const char* key,
                      const jsi::Value& v,
                      void (YogaBridge::*point)(int, float),
                      void (YogaBridge::*percent)(int, float),
                      void (YogaBridge::*autoFn)(int) = nullptr);
  void applyEdge(jsi::Runtime& rt, int nodeId, const char* key,
                 const jsi::Value& v, bool isMargin);
  std::vector<DrawOp> parseOps(jsi::Runtime& rt, const jsi::Value& opsValue);
  void dispatchPointer(const std::string& type, double x, double y,
                       uint32_t button, bool pressed);
  void dispatchScroll(double x, double y, double dx, double dy);
  void dispatchKey(uint32_t key, bool pressed, bool shift);
  // M9 surface resize: update the host size, Sevyn.width/height,
  // and the JS size handler (the renderer re-lays out + presents).
  void dispatchSize(int width, int height);
  // Window-state change: update windowState_, the Sevyn.windowState
  // property, and the JS onWindowState handler (the renderer's
  // window-state store re-renders the title bar).
  void setWindowState(const std::string& state);
  void drainStatusQueue();
  void drainAppEventQueue();
  void drainExecCompletions(jsi::Runtime& rt);
  // Headless helpers: write the latest present's ops as JSON, log the
  // compact ops (texts + pressable rects) when the screen changes,
  // load the timed input file, fire the events whose time has come.
  void dumpHeadlessOps(const std::vector<DrawOp>& ops, uint32_t bg);
  void logHeadlessOps(const std::vector<DrawOp>& ops);
  void loadHeadlessInput();
  void fireDueHeadlessInput();
  bool hasPermission(const std::string& name) const {
    // The shell is trusted: it always has every permission. An app
    // has only what its manifest granted (passed on the command line
    // by appd from the registry).
    return appId_.empty() || permissions_.count(name) > 0;
  }

  int width_, height_;
  std::string bundle_;
  // App identity: empty for the shell. appd launches apps with
  // --app <id> --name <name> --color <#rrggbb> --glyph <letter>
  // --permissions <csv>.
  std::string appId_;
  std::string appName_;
  std::string appColor_;
  std::string appGlyph_;
  std::set<std::string> permissions_;
  // Headless mode (M6): no Wayland surface at all. The bundle still
  // executes, the reconciler still commits, and present() still runs —
  // but the ops go to a JSON dump (--headless-out) instead of a
  // window, and input arrives from a timed event file
  // (--headless-input) instead of a compositor. The M6 check drives
  // Tokrah end to end through this mode: the check reads the ops dump
  // to find buttons, writes the next input file, and runs again.
  bool headless_ = false;
  int headlessSeconds_ = 0;
  std::string headlessOut_;
  std::string headlessInput_;
  // One timed input event from the headless input file. Events are
  // separated by ';' (the file is written through the Terminal's
  // single-line input, so it is one line):
  //   <ms> pointer <down|up|move> <x> <y>
  //   <ms> tap <x> <y>            (down + up 120 ms apart)
  //   <ms> key <evdev-code> <down|up> <shift 0|1>
  //   <ms> type <text>   (expands to key down/up pairs, 30 ms/char)
  struct HeadlessEvent {
    long long atMs = 0;
    bool isPointer = true;
    bool isScroll = false;
    std::string type;  // down/up/move (pointer) — key uses pressed
    double x = 0, y = 0;
    double dx = 0, dy = 0;  // scroll delta (scroll events)
    uint32_t code = 0;
    bool pressed = false;
    bool shift = false;
  };
  std::vector<HeadlessEvent> headlessEvents_;
  size_t headlessEventIdx_ = 0;
  long long headlessStartMs_ = 0;
  long long headlessPresents_ = 0;
  // Signature of the last logged compact ops (the texts, joined): the
  // host logs the compact ops only when the screen's text changes, so
  // a steady screen does not spam the console once per commit.
  std::string headlessLastOpsSig_;
  std::unique_ptr<Wayland> wayland_;
  std::unique_ptr<YogaBridge> yoga_;
  std::unique_ptr<StatusClient> status_;
  std::unique_ptr<AppClient> appClient_;
  std::unique_ptr<jsi::Runtime> runtime_;
  std::unordered_map<std::string, std::string> statusSnapshot_;
  std::mutex statusMutex_;
  std::queue<std::pair<std::string, std::string>> statusQueue_;
  // App events (EVENT lines from appd), queued by the subscriber
  // thread and drained on the main loop like the status queue.
  std::mutex appEventMutex_;
  std::queue<std::string> appEventQueue_;
  // Set by the window close handler / Sevyn.closeApp(): the main loop
  // exits cleanly (code 0) on the next tick.
  std::atomic<bool> exitRequested_{false};

  // Last presented hit-test list, in draw order.
  struct Hit {
    int nodeId;
    float x, y, w, h;
    bool hasClip;
    float cx, cy, cw, ch;
  };
  std::vector<Hit> hits_;

  std::optional<jsi::Function> pointerHandler_;
  std::optional<jsi::Function> keyHandler_;
  std::optional<jsi::Function> statusHandler_;
  std::optional<jsi::Function> appEventHandler_;
  std::optional<jsi::Function> scrollHandler_;
  std::optional<jsi::Function> sizeHandler_;
  std::optional<jsi::Function> windowStateHandler_;
  bool hasPointerHandler_ = false;
  bool hasKeyHandler_ = false;
  bool hasStatusHandler_ = false;
  bool hasAppEventHandler_ = false;
  bool hasScrollHandler_ = false;
  bool hasSizeHandler_ = false;
  bool hasWindowStateHandler_ = false;
  // Window state ("normal" | "maximized" | "minimized"), tracked by
  // the host: maximized comes from the compositor's configure states
  // (Wayland state handler), minimized is set by minimizeApp() and
  // cleared by a focus remap. Published to JS as Sevyn.windowState
  // and to the renderer's window-state store via onWindowState.
  std::string windowState_ = "normal";
  // The Sevyn host object, kept so dispatchSize can update
  // Sevyn.width/Sevyn.height when the surface resizes (M9).
  jsi::Value sevynValue_;

  // setTimeout/clearTimeout timers. Hermes has no timers of its own,
  // and React's scheduler falls back to setTimeout when neither
  // setImmediate nor MessageChannel exists — without it the first
  // commit dies calling a null localSetTimeout (verified locally:
  // the bundle fails in a no-setTimeout vm). Timers fire on the
  // host's main-loop tick; the JS function is kept alive in the list
  // until it fires or is cleared.
  //
  // setImmediate is the SAME function: Hermes's own Promise
  // implementation (lib/InternalBytecode/01-Promise.js handleResolved)
  // schedules already-resolved reactions via the global `setImmediate`
  // when the engine queue is off, and Hermes's own ConsoleHost does
  // exactly this ("Define `setImmediate` to be the same as
  // `setTimeout`"). Without it, `Promise.resolve().then(fn)` throws
  // ReferenceError 'setImmediate' (verified in CI run 42340892796).
  struct Timer {
    uint32_t id;
    double fireAtMs;  // steady_clock ms
    jsi::Function fn;
  };
  std::vector<Timer> timers_;
  uint32_t nextTimerId_ = 1;

  // Yoga measure callbacks, by node id (JS functions). shared_ptr
  // because jsi::Function is move-only and the Yoga measure lambda
  // (held in a std::function) must be copyable.
  std::unordered_map<int, std::shared_ptr<jsi::Function>> measureFuncs_;
};

void RnHost::applyDimension(jsi::Runtime& rt, int nodeId, const char* key,
                            const jsi::Value& v,
                            void (YogaBridge::*point)(int, float),
                            void (YogaBridge::*percent)(int, float),
                            void (YogaBridge::*autoFn)(int)) {
  (void)rt;
  (void)key;
  if (v.isNumber()) {
    (yoga_.get()->*point)(nodeId, (float)v.asNumber());
  } else if (v.isString()) {
    std::string s = v.asString(rt).utf8(rt);
    if (s == "auto") {
      // min/max have no auto in Yoga; autoFn is null there (ignored).
      if (autoFn)
        (yoga_.get()->*autoFn)(nodeId);
    } else if (!s.empty() && s.back() == '%') {
      try {
        (yoga_.get()->*percent)(nodeId, std::stof(s.substr(0, s.size() - 1)));
      } catch (...) {
      }
    }
  }
}

void RnHost::applyEdge(jsi::Runtime& rt, int nodeId, const char* key,
                       const jsi::Value& v, bool isMargin) {
  // key is padding/margin (number -> all edges) or a per-edge key.
  auto setOne = [&](int edge, float val) {
    if (isMargin)
      yoga_->setMargin(nodeId, edge, val);
    else
      yoga_->setPadding(nodeId, edge, val);
  };
  auto setOnePercent = [&](int edge, float val) {
    if (isMargin)
      yoga_->setMarginPercent(nodeId, edge, val);
    else
      yoga_->setPaddingPercent(nodeId, edge, val);
  };
  if (v.isNumber()) {
    setOne(8 /* YGEdgeAll */, (float)v.asNumber());
    return;
  }
  if (v.isString()) {
    std::string s = v.asString(rt).utf8(rt);
    if (!s.empty() && s.back() == '%') {
      try {
        setOnePercent(8, std::stof(s.substr(0, s.size() - 1)));
      } catch (...) {
      }
    }
    return;
  }
  if (!v.isObject())
    return;
  jsi::Object o = v.asObject(rt);
  static const struct {
    const char* key;
    int edge;
  } kEdges[] = {{"left", 0}, {"top", 1}, {"right", 2}, {"bottom", 3},
                {"horizontal", 6}, {"vertical", 7}};
  for (auto& e : kEdges) {
    if (!hasProp(rt, o, e.key))
      continue;
    jsi::Value ev = jsProp(rt, o, e.key);
    if (ev.isNumber())
      setOne(e.edge, (float)ev.asNumber());
    else if (ev.isString()) {
      std::string s = ev.asString(rt).utf8(rt);
      if (!s.empty() && s.back() == '%') {
        try {
          setOnePercent(e.edge, std::stof(s.substr(0, s.size() - 1)));
        } catch (...) {
        }
      }
    }
  }
  (void)key;
}

void RnHost::applyStyle(jsi::Runtime& rt, int nodeId,
                        const jsi::Object& style) {
  auto enumVal = [&](const char* key, const std::vector<const char*>& names,
                     int fallback) {
    if (!hasProp(rt, style, key))
      return fallback;
    std::string s = jsString(rt, jsProp(rt, style, key));
    for (size_t i = 0; i < names.size(); i++)
      if (s == names[i])
        return (int)i;
    return fallback;
  };
  // Enum lists below MUST be in Yoga's declaration order (YGEnums.h,
  // pinned Yoga 41118bd: YG_ENUM_DECL lists values from 0 up), because
  // enumVal returns the list index as the Yoga enum value. The old
  // flexDirection list {"row", ...} mapped row->0 (Yoga Column) and
  // column->2 (Yoga Row): every direction in the shell was swapped,
  // so the root laid out as a row, the top bar measured 112px wide,
  // the dock stacked at the top-right, and nothing was where the
  // check looks for it (CI failure #18). Same off-by-one in
  // justifyContent (the list omitted "auto") and position (omitted
  // "static"): "center" mapped to FlexStart, "absolute" to Relative.
  // flexDirection: column, column-reverse, row, row-reverse
  yoga_->setFlexDirection(
      nodeId, enumVal("flexDirection", {"column", "column-reverse", "row",
                                        "row-reverse"},
                      0));
  yoga_->setJustifyContent(
      nodeId, enumVal("justifyContent",
                      {"auto", "flex-start", "center", "flex-end",
                       "space-between", "space-around", "space-evenly"},
                      1));
  auto alignEnum = [&](const char* key, int fallback) {
    return enumVal(key,
                   {"auto", "flex-start", "center", "flex-end", "stretch",
                    "baseline", "space-between", "space-around"},
                   fallback);
  };
  yoga_->setAlignItems(nodeId, alignEnum("alignItems", 4)); // stretch
  yoga_->setAlignSelf(nodeId, alignEnum("alignSelf", 0));   // auto
  yoga_->setAlignContent(nodeId, alignEnum("alignContent", 0));
  yoga_->setFlexWrap(nodeId, enumVal("flexWrap", {"nowrap", "wrap",
                                                  "wrap-reverse"},
                                     0));
  yoga_->setPositionType(nodeId, enumVal("position", {"static", "relative",
                                                      "absolute"},
                                         1));
  yoga_->setDisplay(nodeId, enumVal("display", {"flex", "none"}, 0));
  yoga_->setOverflow(nodeId,
                     enumVal("overflow", {"visible", "hidden", "scroll"}, 0));
  if (hasProp(rt, style, "flex"))
    yoga_->setFlex(nodeId, (float)jsNumber(rt, jsProp(rt, style, "flex")));
  if (hasProp(rt, style, "flexGrow"))
    yoga_->setFlexGrow(nodeId,
                       (float)jsNumber(rt, jsProp(rt, style, "flexGrow")));
  if (hasProp(rt, style, "flexShrink"))
    yoga_->setFlexShrink(
        nodeId, (float)jsNumber(rt, jsProp(rt, style, "flexShrink")));
  if (hasProp(rt, style, "flexBasis"))
    applyDimension(rt, nodeId, "flexBasis", jsProp(rt, style, "flexBasis"),
                   &YogaBridge::setFlexBasisPoint,
                   &YogaBridge::setFlexBasisPercent,
                   &YogaBridge::setFlexBasisAuto);
  if (hasProp(rt, style, "width"))
    applyDimension(rt, nodeId, "width", jsProp(rt, style, "width"),
                   &YogaBridge::setWidthPoint, &YogaBridge::setWidthPercent,
                   &YogaBridge::setWidthAuto);
  if (hasProp(rt, style, "height"))
    applyDimension(rt, nodeId, "height", jsProp(rt, style, "height"),
                   &YogaBridge::setHeightPoint, &YogaBridge::setHeightPercent,
                   &YogaBridge::setHeightAuto);
  if (hasProp(rt, style, "minWidth"))
    applyDimension(rt, nodeId, "minWidth", jsProp(rt, style, "minWidth"),
                   &YogaBridge::setMinWidthPoint,
                   &YogaBridge::setMinWidthPercent, nullptr);
  if (hasProp(rt, style, "minHeight"))
    applyDimension(rt, nodeId, "minHeight", jsProp(rt, style, "minHeight"),
                   &YogaBridge::setMinHeightPoint,
                   &YogaBridge::setMinHeightPercent, nullptr);
  if (hasProp(rt, style, "maxWidth"))
    applyDimension(rt, nodeId, "maxWidth", jsProp(rt, style, "maxWidth"),
                   &YogaBridge::setMaxWidthPoint,
                   &YogaBridge::setMaxWidthPercent, nullptr);
  if (hasProp(rt, style, "maxHeight"))
    applyDimension(rt, nodeId, "maxHeight", jsProp(rt, style, "maxHeight"),
                   &YogaBridge::setMaxHeightPoint,
                   &YogaBridge::setMaxHeightPercent, nullptr);
  // Padding / margin: number, "n%", or {left, top, right, bottom,
  // horizontal, vertical}.
  if (hasProp(rt, style, "padding"))
    applyEdge(rt, nodeId, "padding", jsProp(rt, style, "padding"), false);
  if (hasProp(rt, style, "margin"))
    applyEdge(rt, nodeId, "margin", jsProp(rt, style, "margin"), true);
  // Per-edge padding/margin keys.
  static const char* kPadKeys[] = {"paddingLeft", "paddingTop",
                                   "paddingRight", "paddingBottom",
                                   "paddingHorizontal", "paddingVertical"};
  static const int kPadEdges[] = {0, 1, 2, 3, 6, 7};
  for (size_t i = 0; i < 6; i++) {
    if (hasProp(rt, style, kPadKeys[i])) {
      jsi::Value v = jsProp(rt, style, kPadKeys[i]);
      if (v.isNumber())
        yoga_->setPadding(nodeId, kPadEdges[i], (float)v.asNumber());
    }
  }
  static const char* kMarKeys[] = {"marginLeft", "marginTop", "marginRight",
                                   "marginBottom", "marginHorizontal",
                                   "marginVertical"};
  for (size_t i = 0; i < 6; i++) {
    if (hasProp(rt, style, kMarKeys[i])) {
      jsi::Value v = jsProp(rt, style, kMarKeys[i]);
      if (v.isNumber())
        yoga_->setMargin(nodeId, kPadEdges[i], (float)v.asNumber());
    }
  }
  // Position offsets (top/left/bottom/right) for absolute and
  // relative nodes. These were never applied: an absolute node kept
  // its static position, so floating buttons (Tokrah's Go Live
  // button, bottom:92 right:24) landed on top of the first story
  // tile instead of bottom-right.
  static const char* kPosKeys[] = {"top", "left", "bottom", "right"};
  static const int kPosEdges[] = {1, 0, 3, 2}; // YGEdgeTop/Left/Bottom/Right
  for (size_t i = 0; i < 4; i++) {
    if (!hasProp(rt, style, kPosKeys[i]))
      continue;
    jsi::Value v = jsProp(rt, style, kPosKeys[i]);
    if (v.isNumber())
      yoga_->setPosition(nodeId, kPosEdges[i], (float)v.asNumber());
    else if (v.isString()) {
      std::string s = v.asString(rt).utf8(rt);
      if (!s.empty() && s.back() == '%') {
        try {
          yoga_->setPositionPercent(
              nodeId, kPosEdges[i],
              std::stof(s.substr(0, s.size() - 1)));
        } catch (...) {
        }
      }
    }
  }
}

void RnHost::installYoga(jsi::Runtime& rt, jsi::Object& sevyn) {
  // Contract (v2/rn/README.md): FLAT `yoga*` functions on `Sevyn`
  // itself — not a nested `Sevyn.Yoga` object. The renderer calls
  // Sevyn.yogaCreateNode() etc.; installing them nested (as this
  // function used to) leaves every one undefined and the shell dies
  // at the first render with "undefined is not a function"
  // (verified in CI run 42339511336, stack shell.js:10369).
  auto hostFn = [&](const char* name, unsigned params,
                    jsi::HostFunctionType fn) {
    sevyn.setProperty(
        rt, name,
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, name), params, fn));
  };
  hostFn("yogaCreateNode", 0,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*,
                size_t) {
           (void)rt;
           return jsi::Value(yoga_->createNode());
         });
  hostFn("yogaFreeNode", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1)
             yoga_->freeNode((int)args[0].asNumber());
           (void)rt;
           return jsi::Value::undefined();
         });
  hostFn("yogaSetChildren", 2,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 2) {
             int id = (int)args[0].asNumber();
             std::vector<int> kids;
             jsi::Array arr = args[1].asObject(rt).getArray(rt);
             for (size_t i = 0; i < arr.size(rt); i++)
               kids.push_back(
                   (int)arr.getValueAtIndex(rt, i).asNumber());
             yoga_->setChildren(id, kids);
           }
           return jsi::Value::undefined();
         });
  hostFn("yogaSetStyle", 2,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 2 && args[1].isObject())
             applyStyle(rt, (int)args[0].asNumber(), args[1].asObject(rt));
           return jsi::Value::undefined();
         });
  hostFn("yogaSetMeasureFunc", 2,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 2 && args[1].isObject()) {
             int id = (int)args[0].asNumber();
             auto fn = std::make_shared<jsi::Function>(
                 args[1].asObject(rt).asFunction(rt));
             measureFuncs_[id] = fn;
             // The Yoga measure callback runs on this thread during
             // calculateLayout; it calls back into the stored JS fn.
             yoga_->setMeasureFunc(
                 id,
                 [this, id, fn](float w, int wm, float h, int hm, float& outW,
                                float& outH) mutable {
                   jsi::Runtime& r = *runtime_;
                   try {
                     jsi::Value res = fn->call(
                         r, {(double)w, (double)wm, (double)h, (double)hm});
                     if (res.isObject()) {
                       jsi::Object o = res.asObject(r);
                       outW = (float)jsNumber(r, jsProp(r, o, "width"));
                       outH = (float)jsNumber(r, jsProp(r, o, "height"));
                     }
                   } catch (const jsi::JSError& e) {
                     logLine("YOGA measure failed for node %d: %s", id,
                             e.getMessage().c_str());
                     outW = 0;
                     outH = 0;
                   }
                 });
           }
           return jsi::Value::undefined();
         });
  hostFn("yogaClearMeasureFunc", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1) {
             int id = (int)args[0].asNumber();
             measureFuncs_.erase(id);
             yoga_->clearMeasureFunc(id);
           }
           (void)rt;
           return jsi::Value::undefined();
         });
  hostFn("yogaCalculateLayout", 3,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 3)
             yoga_->calculateLayout((int)args[0].asNumber(),
                                    (float)args[1].asNumber(),
                                    (float)args[2].asNumber());
           (void)rt;
           return jsi::Value::undefined();
         });
  hostFn("yogaGetLayout", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           jsi::Object o(rt);
           float x = 0, y = 0, w = 0, h = 0;
           if (count >= 1)
             yoga_->getLayout((int)args[0].asNumber(), x, y, w, h);
           o.setProperty(rt, "x", x);
           o.setProperty(rt, "y", y);
           o.setProperty(rt, "width", w);
           o.setProperty(rt, "height", h);
           return o;
         });
}

std::vector<DrawOp> RnHost::parseOps(jsi::Runtime& rt,
                                     const jsi::Value& opsValue) {
  std::vector<DrawOp> ops;
  if (!opsValue.isObject())
    return ops;
  jsi::Array arr = opsValue.asObject(rt).getArray(rt);
  for (size_t i = 0; i < arr.size(rt); i++) {
    jsi::Value v = arr.getValueAtIndex(rt, i);
    if (!v.isObject())
      continue;
    jsi::Object o = v.asObject(rt);
    DrawOp op;
    std::string type = jsString(rt, jsProp(rt, o, "type"));
    auto num = [&](const char* k, float dflt = 0) {
      return (float)jsNumber(rt, jsProp(rt, o, k), dflt);
    };
    if (type == "rect") {
      op.kind = DrawOp::Kind::Rect;
    } else if (type == "text") {
      op.kind = DrawOp::Kind::Text;
    } else if (type == "image") {
      op.kind = DrawOp::Kind::Image;
    } else if (type == "pushClip") {
      op.kind = DrawOp::Kind::PushClip;
    } else if (type == "popClip") {
      op.kind = DrawOp::Kind::PopClip;
    } else {
      continue;
    }
    op.x = num("x");
    op.y = num("y");
    op.w = num("w");
    op.h = num("h");
    op.radius = num("radius");
    op.nodeId = (int)num("nodeId", -1);
    if (op.kind == DrawOp::Kind::Rect || op.kind == DrawOp::Kind::Text) {
      uint32_t c = 0x000000ff;
      if (hasProp(rt, o, "color"))
        parseColor(jsString(rt, jsProp(rt, o, "color")), c);
      op.color = c;
    }
    if (op.kind == DrawOp::Kind::Text) {
      op.text = jsString(rt, jsProp(rt, o, "text"));
      op.fontSize = num("fontSize", 14);
      op.fontBold = jsBool(rt, jsProp(rt, o, "bold"), false);
      std::string a = jsString(rt, jsProp(rt, o, "align"));
      op.align = a == "center" ? 1 : (a == "right" ? 2 : 0);
    }
    if (op.kind == DrawOp::Kind::Image)
      op.asset = jsString(rt, jsProp(rt, o, "asset"));
    ops.push_back(op);
  }
  return ops;
}

void RnHost::installSevyn(jsi::Runtime& rt) {
  jsi::Object sevyn(rt);
  installYoga(rt, sevyn);
  auto hostFn = [&](const char* name, unsigned params,
                    jsi::HostFunctionType fn) {
    sevyn.setProperty(
        rt, name,
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, name), params, fn));
  };
  hostFn("log", 1,
         [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
            size_t count) {
           if (count >= 1)
             logLine("JS %s", jsString(rt, args[0]).c_str());
           return jsi::Value::undefined();
         });
  hostFn("measureText", 4,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           jsi::Object o(rt);
           float w = 0, h = 0;
           if (count >= 2) {
             std::string text = jsString(rt, args[0]);
             float size = (float)args[1].asNumber();
             bool bold = count >= 3 && jsBool(rt, args[2], false);
             float maxW = count >= 4 ? (float)args[3].asNumber() : 0;
             if (headless_ || !wayland_) {
               // No painter without a surface: approximate with the
               // average glyph width the mock harness uses (0.6em).
               // Headless text is measured for layout, never drawn.
               w = (float)text.size() * size * 0.6f;
               if (maxW > 0 && w > maxW)
                 w = maxW;
               h = size * 1.2f;
             } else {
               w = wayland_->painter().measureTextWidth(text, size, bold);
               h = wayland_->painter().measureTextHeight(text, size, bold,
                                                         maxW);
             }
           }
           o.setProperty(rt, "width", w);
           o.setProperty(rt, "height", h);
           return o;
         });
  hostFn("present", 2,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1) {
             std::vector<DrawOp> ops = parseOps(rt, args[0]);
             uint32_t bg = 0x0b0b0fff;
             if (count >= 2)
               parseColor(jsString(rt, args[1]), bg);
             // Rebuild the hit-test list from the ops (draw order).
             hits_.clear();
             struct Clip {
               float x, y, w, h;
               bool on = false;
             };
             std::vector<Clip> stack;
             for (auto& op : ops) {
               if (op.kind == DrawOp::Kind::PushClip) {
                 Clip c{op.x, op.y, op.w, op.h, true};
                 if (!stack.empty() && stack.back().on) {
                   const Clip& t = stack.back();
                   float x0 = std::max(c.x, t.x), y0 = std::max(c.y, t.y);
                   float x1 = std::min(c.x + c.w, t.x + t.w);
                   float y1 = std::min(c.y + c.h, t.y + t.h);
                   c = {x0, y0, std::max(0.0f, x1 - x0),
                        std::max(0.0f, y1 - y0), true};
                 }
                 stack.push_back(c);
               } else if (op.kind == DrawOp::Kind::PopClip) {
                 if (!stack.empty())
                   stack.pop_back();
               } else if (op.nodeId >= 0) {
                 Hit hit{op.nodeId, op.x, op.y, op.w, op.h, false,
                         0, 0, 0, 0};
                 if (!stack.empty() && stack.back().on) {
                   hit.hasClip = true;
                   hit.cx = stack.back().x;
                   hit.cy = stack.back().y;
                   hit.cw = stack.back().w;
                   hit.ch = stack.back().h;
                 }
                 hits_.push_back(hit);
               }
             }
             if (headless_) {
               // No surface: the ops go to the JSON dump for the
               // check harness instead of a window. Log only the
               // first present (every commit would spam the console);
               // the compact ops log below fires once per screen.
               headlessPresents_++;
               if (headlessPresents_ == 1)
                 logLine("HOST headless first present: %zu ops",
                         ops.size());
               dumpHeadlessOps(ops, bg);
               logHeadlessOps(ops);
             } else {
               wayland_->present(ops, bg);
             }
           }
           return jsi::Value::undefined();
         });
  // Contract (v2/rn/README.md): the renderer registers handlers as
  // Sevyn.onPointer/onKey/onStatus — not set*Handler.
  hostFn("onPointer", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             pointerHandler_ =
                 std::move(args[0].asObject(rt).asFunction(rt));
             hasPointerHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  hostFn("onKey", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             keyHandler_ = std::move(args[0].asObject(rt).asFunction(rt));
             hasKeyHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  hostFn("onScroll", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             scrollHandler_ =
                 std::move(args[0].asObject(rt).asFunction(rt));
             hasScrollHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  hostFn("onStatus", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             statusHandler_ =
                 std::move(args[0].asObject(rt).asFunction(rt));
             hasStatusHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  // M9 surface resize: the renderer subscribes in render() and
  // re-lays out the root at the new size (see dispatchSize).
  hostFn("onWindowResize", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             sizeHandler_ =
                 std::move(args[0].asObject(rt).asFunction(rt));
             hasSizeHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  hostFn("getStatus", 0,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*,
                size_t) {
           jsi::Object o(rt);
           // Permission gate: without status.read an app sees an
           // empty status object (and no subscriber ever runs, so
           // onStatus never fires either).
           if (!hasPermission("status.read"))
             return o;
           std::lock_guard<std::mutex> lk(statusMutex_);
           for (auto& kv : statusSnapshot_)
             o.setProperty(rt, kv.first.c_str(), kv.second.c_str());
           return o;
         });
  hostFn("hasPermission", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1)
             return jsi::Value(hasPermission(jsString(rt, args[0])));
           return jsi::Value(false);
         });
  hostFn("exec", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           // Permission gate: only apps with cli.exec may run the CLI.
           // The shell (empty appId) is always allowed.
           if (!hasPermission("cli.exec"))
             return jsi::String::createFromUtf8(
                 rt, "ERR permission denied: cli.exec");
           if (count < 1)
             return jsi::String::createFromUtf8(
                 rt, "ERR usage: exec(cmdline)");
           return jsi::String::createFromUtf8(
               rt, runSevyn(jsString(rt, args[0])));
         });
  // Sevyn.execAsync: the same CLI run, off the JS thread (see the
  // comment above the ExecCompletion queue). The network path (the
  // shim's XHR/fetch) uses this; the Terminal keeps the synchronous
  // exec above. Returns a Promise<string> with the same
  // "<exit-code>\n<output>" shape.
  hostFn("execAsync", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           auto promiseCtor =
               rt.global().getPropertyAsFunction(rt, "Promise");
           if (!hasPermission("cli.exec")) {
             auto rejectFn = promiseCtor.getPropertyAsFunction(rt, "reject");
             return rejectFn.call(
                 rt, jsi::String::createFromUtf8(
                         rt, "ERR permission denied: cli.exec"));
           }
           if (count < 1) {
             auto rejectFn = promiseCtor.getPropertyAsFunction(rt, "reject");
             return rejectFn.call(
                 rt, jsi::String::createFromUtf8(
                         rt, "ERR usage: execAsync(cmdline)"));
           }
           std::string cmdline = jsString(rt, args[0]);
           auto executor = jsi::Function::createFromHostFunction(
               rt, jsi::PropNameID::forAscii(rt, "sevynExecAsyncExecutor"), 2,
               [cmdline](jsi::Runtime& rt2, const jsi::Value&,
                         const jsi::Value* eargs, size_t ecount) {
                 if (ecount < 1)
                   return jsi::Value::undefined();
                 jsi::Function resolve =
                     eargs[0].asObject(rt2).asFunction(rt2);
                 // Detached worker: runSevyn blocks up to 10 s. It
                 // never touches the runtime, and the completion
                 // queue is file-static, so nothing here can dangle.
                 std::thread([cmdline, resolve = std::move(resolve)]() mutable {
                   std::string result = runSevyn(cmdline);
                   std::lock_guard<std::mutex> lk(g_execMutex);
                   g_execCompletions.push(
                       ExecCompletion{std::move(resolve), std::move(result)});
                 }).detach();
                 return jsi::Value::undefined();
               });
           // Construct (not call): Promise(...) without `new` throws
           // "Promises must be constructed via new" in Hermes.
           jsi::Value executorValue(std::move(executor));
           return promiseCtor.callAsConstructor(rt, {std::move(executorValue)});
         });
  hostFn("listApps", 0,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*,
                size_t) {
           std::vector<AppInfo> apps =
               appClient_ ? appClient_->listApps() : std::vector<AppInfo>{};
           // Diagnostic (icons PR #102): the dock showed 15 apps
           // while appd lists 16 — log what the host returns so the
           // next CI run pins the gap to the host or the shell.
           std::string ids;
           for (const auto& a : apps) {
             if (!ids.empty())
               ids += ",";
             ids += a.id;
           }
           logLine("HOST listApps %zu apps: %s", apps.size(), ids.c_str());
           jsi::Array arr(rt, apps.size());
           for (size_t i = 0; i < apps.size(); i++) {
             jsi::Object o(rt);
             o.setProperty(rt, "id", apps[i].id.c_str());
             o.setProperty(rt, "name", apps[i].name.c_str());
             o.setProperty(rt, "version", apps[i].version.c_str());
             o.setProperty(rt, "color", apps[i].color.c_str());
             o.setProperty(rt, "glyph", apps[i].glyph.c_str());
             o.setProperty(rt, "system", apps[i].system);
             o.setProperty(rt, "protected", apps[i].protected_);
             o.setProperty(rt, "singleInstance", apps[i].singleInstance);
             jsi::Array perms(rt, apps[i].permissions.size());
             for (size_t j = 0; j < apps[i].permissions.size(); j++)
               perms.setValueAtIndex(rt, j,
                                     apps[i].permissions[j].c_str());
             o.setProperty(rt, "permissions", perms);
             arr.setValueAtIndex(rt, i, o);
           }
           return arr;
         });
  hostFn("launchApp", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           // M3: the real app runtime — appd spawns a sandboxed host
           // for the app in its own window. The shell shows
           // "Starting…" until the LAUNCHED/STOPPED event arrives.
           if (count >= 1) {
             std::string id = jsString(rt, args[0]);
             bool ok = appClient_ && appClient_->launchApp(id);
             logLine("LAUNCH %s %s", id.c_str(), ok ? "ok" : "failed");
             return jsi::Value(ok);
           }
           return jsi::Value(false);
         });
  hostFn("focusApp", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           // Window-focus fix: ask appd to focus a running app
           // (EVENT FOCUS to its most recent instance; the target
           // host raises its window). False when not running.
           if (count >= 1) {
             std::string id = jsString(rt, args[0]);
             bool ok = appClient_ && appClient_->focusApp(id);
             logLine("FOCUS %s %s", id.c_str(), ok ? "ok" : "failed");
             return jsi::Value(ok);
           }
           return jsi::Value(false);
         });
  hostFn("onAppEvent", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             appEventHandler_ =
                 std::move(args[0].asObject(rt).asFunction(rt));
             hasAppEventHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  hostFn("closeApp", 0,
         [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*,
                size_t) {
           // Apps close themselves (window X button does the same).
           // The shell is not closable.
           if (!appId_.empty()) {
             exitRequested_.store(true);
             return jsi::Value(true);
           }
           return jsi::Value(false);
         });
  // Window state (app windows only — the fullscreen shell has no
  // minimize/maximize). minimizeApp hides the window; a dock click
  // restores it through the focus path (remap). maximizeApp /
  // unmaximizeApp ask the compositor; the new state is confirmed
  // through the configure states array (see setWindowState).
  hostFn("minimizeApp", 0,
         [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*,
                size_t) {
           if (appId_.empty() || !wayland_)
             return jsi::Value(false);
           wayland_->minimize();
           setWindowState("minimized");
           return jsi::Value(true);
         });
  hostFn("maximizeApp", 0,
         [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*,
                size_t) {
           if (appId_.empty() || !wayland_)
             return jsi::Value(false);
           wayland_->maximize();
           return jsi::Value(true);
         });
  hostFn("unmaximizeApp", 0,
         [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*,
                size_t) {
           if (appId_.empty() || !wayland_)
             return jsi::Value(false);
           wayland_->unmaximize();
           return jsi::Value(true);
         });
  hostFn("onWindowState", 1,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
                size_t count) {
           if (count >= 1 && args[0].isObject()) {
             windowStateHandler_ =
                 std::move(args[0].asObject(rt).asFunction(rt));
             hasWindowStateHandler_ = true;
           }
           return jsi::Value::undefined();
         });
  // App identity, for the app template (the shell reads these too;
  // its own values are the defaults below).
  sevyn.setProperty(rt, "appId",
                    appId_.empty() ? "shell" : appId_.c_str());
  sevyn.setProperty(rt, "appName",
                    appName_.empty() ? "SevynOS" : appName_.c_str());
  sevyn.setProperty(rt, "appColor",
                    appColor_.empty() ? "#111827" : appColor_.c_str());
  sevyn.setProperty(rt, "appGlyph",
                    appGlyph_.empty() ? "S" : appGlyph_.c_str());
  // Window size, so apps lay out to the real window: the headless
  // Tokrah runs use a taller window so the login screen fits
  // without scrolling; the default app window is 800x500.
  sevyn.setProperty(rt, "width", (double)width_);
  sevyn.setProperty(rt, "height", (double)height_);
  // Window state (see setWindowState): "normal" at startup; the
  // renderer subscribes via Sevyn.onWindowState.
  sevyn.setProperty(rt, "windowState", windowState_.c_str());
  // Kept so dispatchSize can update width/height on resize (M9).
  sevynValue_ = jsi::Value(rt, sevyn);
  rt.global().setProperty(rt, "Sevyn", sevyn);
}

double RnHost::nowMs() const {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch())
      .count();
}

void RnHost::installTimers(jsi::Runtime& rt) {
  auto hostFn = [&](const char* name, unsigned params,
                    jsi::HostFunctionType fn) {
    rt.global().setProperty(
        rt, name,
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, name), params, fn));
  };
  jsi::HostFunctionType setTimer =
      [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
             size_t count) {
        if (count < 1 || !args[0].isObject())
          return jsi::Value::undefined();
        double ms = count >= 2 ? jsNumber(rt, args[1], 0) : 0;
        if (ms < 0)
          ms = 0;
        uint32_t id = nextTimerId_++;
        timers_.push_back(Timer{id, nowMs() + ms,
                                args[0].asObject(rt).asFunction(rt)});
        return jsi::Value((double)id);
      };
  jsi::HostFunctionType clearTimer =
      [this](jsi::Runtime&, const jsi::Value&, const jsi::Value* args,
             size_t count) {
        if (count >= 1 && args[0].isNumber()) {
          uint32_t id = (uint32_t)args[0].asNumber();
          timers_.erase(std::remove_if(timers_.begin(), timers_.end(),
                                       [id](const Timer& t) {
                                         return t.id == id;
                                       }),
                        timers_.end());
        }
        return jsi::Value::undefined();
      };
  hostFn("setTimeout", 2, setTimer);
  hostFn("setImmediate", 1, setTimer);
  hostFn("clearTimeout", 1, clearTimer);
  hostFn("clearImmediate", 1, clearTimer);
}

void RnHost::fireDueTimers(jsi::Runtime& rt) {
  double now = nowMs();
  std::vector<Timer> due;
  auto it = timers_.begin();
  while (it != timers_.end()) {
    if (it->fireAtMs <= now) {
      due.push_back(std::move(*it));
      it = timers_.erase(it);
    } else {
      ++it;
    }
  }
  for (auto& t : due) {
    try {
      t.fn.call(rt);
    } catch (const jsi::JSError& e) {
      logLine("HOST timer callback failed: %s", e.getMessage().c_str());
      logLine("HOST timer stack: %s", e.getStack().c_str());
    }
  }
  if (!due.empty())
    rt.drainMicrotasks();
}

void RnHost::dispatchPointer(const std::string& type, double x, double y,
                             uint32_t button, bool pressed) {
  if (!hasPointerHandler_ || !runtime_)
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    jsi::Object ev(rt);
    ev.setProperty(rt, "type", type.c_str());
    ev.setProperty(rt, "x", x);
    ev.setProperty(rt, "y", y);
    ev.setProperty(rt, "button", (double)button);
    ev.setProperty(rt, "pressed", pressed);
    if (type == "button" && pressed) {
      // Hit-test the last presented tree, topmost first.
      int hit = -1;
      for (auto it = hits_.rbegin(); it != hits_.rend(); ++it) {
        if (x < it->x || y < it->y || x >= it->x + it->w ||
            y >= it->y + it->h)
          continue;
        if (it->hasClip &&
            (x < it->cx || y < it->cy || x >= it->cx + it->cw ||
             y >= it->cy + it->ch))
          continue;
        hit = it->nodeId;
        break;
      }
      ev.setProperty(rt, "nodeId", hit);
      // The hit result is the only evidence a tap landed where the
      // driver aimed (M6: a tap on Tokrah's Sign In button silently
      // missed until the viewport grew past the button).
      logLine("HOST pointer down (%.0f,%.0f) -> nodeId %d", x, y, hit);
    }
    pointerHandler_->call(rt, ev);
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS pointer handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::dispatchSize(int width, int height) {
  if (!runtime_)
    return;
  width_ = width;
  height_ = height;
  jsi::Runtime& rt = *runtime_;
  try {
    if (!sevynValue_.isUndefined()) {
      jsi::Object sevyn = sevynValue_.asObject(rt);
      sevyn.setProperty(rt, "width", (double)width);
      sevyn.setProperty(rt, "height", (double)height);
    }
    if (hasSizeHandler_) {
      jsi::Object ev(rt);
      ev.setProperty(rt, "width", (double)width);
      ev.setProperty(rt, "height", (double)height);
      sizeHandler_->call(rt, ev);
      rt.drainMicrotasks();
    }
  } catch (const jsi::JSError& e) {
    logLine("JS size handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::setWindowState(const std::string& state) {
  if (state == windowState_)
    return;
  windowState_ = state;
  if (!runtime_)
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    if (!sevynValue_.isUndefined()) {
      jsi::Object sevyn = sevynValue_.asObject(rt);
      sevyn.setProperty(rt, "windowState", state.c_str());
    }
    if (hasWindowStateHandler_) {
      jsi::Object ev(rt);
      ev.setProperty(rt, "state", state.c_str());
      windowStateHandler_->call(rt, ev);
      rt.drainMicrotasks();
    }
  } catch (const jsi::JSError& e) {
    logLine("JS window-state handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::dispatchKey(uint32_t key, bool pressed, bool shift) {
  if (!hasKeyHandler_ || !runtime_)
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    jsi::Object ev(rt);
    ev.setProperty(rt, "key", (double)key);
    ev.setProperty(rt, "pressed", pressed);
    ev.setProperty(rt, "shift", shift);
    keyHandler_->call(rt, ev);
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS key handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::dispatchScroll(double x, double y, double dx, double dy) {
  if (!hasScrollHandler_ || !runtime_)
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    jsi::Object ev(rt);
    ev.setProperty(rt, "x", x);
    ev.setProperty(rt, "y", y);
    ev.setProperty(rt, "dx", dx);
    ev.setProperty(rt, "dy", dy);
    scrollHandler_->call(rt, ev);
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS scroll handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::drainStatusQueue() {
  if (!hasStatusHandler_ || !runtime_)
    return;
  std::queue<std::pair<std::string, std::string>> q;
  {
    std::lock_guard<std::mutex> lk(statusMutex_);
    q.swap(statusQueue_);
  }
  if (q.empty())
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    while (!q.empty()) {
      auto [key, value] = q.front();
      q.pop();
      jsi::Object ev(rt);
      ev.setProperty(rt, "key", key.c_str());
      ev.setProperty(rt, "value", value.c_str());
      statusHandler_->call(rt, ev);
    }
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS status handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::drainAppEventQueue() {
  // Always drain — app hosts never register a JS onAppEvent handler,
  // so an early return here would let the queue grow forever and the
  // FOCUS interception below would never run. EVENT FOCUS lines are
  // handled in C++ (the target host raises its window by remapping
  // its surface); every other line goes to JS only when a handler
  // exists (the shell's app store).
  if (!runtime_)
    return;
  std::queue<std::string> q;
  {
    std::lock_guard<std::mutex> lk(appEventMutex_);
    q.swap(appEventQueue_);
  }
  if (q.empty())
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    while (!q.empty()) {
      std::string line = q.front();
      q.pop();
      // "EVENT FOCUS <id> <pid>" — only the host whose app id AND
      // pid match raises its window (multi-instance: appd targets
      // the most recently launched instance). The shell and other
      // apps ignore it.
      if (line.rfind("EVENT FOCUS ", 0) == 0 && !appId_.empty() &&
          wayland_) {
        std::string rest = line.substr(12);
        size_t sp = rest.find(' ');
        if (sp != std::string::npos) {
          std::string id = rest.substr(0, sp);
          std::string pidStr = rest.substr(sp + 1);
          long pid = -1;
          try {
            pid = std::stol(pidStr);
          } catch (...) {
            pid = -1;
          }
          if (id == appId_ && pid == (long)getpid()) {
            logLine("HOST FOCUS remap %s (pid %ld)", id.c_str(), pid);
            wayland_->remap();
            // A minimized window comes back as a normal window
            // (remap re-applies maximized when it was maximized).
            if (windowState_ == "minimized")
              setWindowState("normal");
            continue;
          }
        }
      }
      if (hasAppEventHandler_)
        appEventHandler_->call(rt, jsi::String::createFromUtf8(rt, line));
    }
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS app-event handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::drainExecCompletions(jsi::Runtime& rt) {
  std::queue<ExecCompletion> done;
  {
    std::lock_guard<std::mutex> lk(g_execMutex);
    done.swap(g_execCompletions);
  }
  while (!done.empty()) {
    ExecCompletion c = std::move(done.front());
    done.pop();
    try {
      c.resolve.call(rt, jsi::String::createFromUtf8(rt, c.result));
      rt.drainMicrotasks();
    } catch (const jsi::JSError& e) {
      logLine("HOST execAsync resolve failed: %s", e.getMessage().c_str());
    }
  }
}

static std::string jsonEscape(const std::string& s) {
  std::string out;
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

void RnHost::dumpHeadlessOps(const std::vector<DrawOp>& ops, uint32_t bg) {
  if (headlessOut_.empty())
    return;
  std::ostringstream j;
  j << "{\"width\":" << width_ << ",\"height\":" << height_ << ",\"bg\":\"#";
  char bgbuf[16];
  snprintf(bgbuf, sizeof(bgbuf), "%02x%02x%02x", (bg >> 24) & 0xff,
           (bg >> 16) & 0xff, (bg >> 8) & 0xff);
  j << bgbuf << "\",\"ops\":[";
  bool first = true;
  for (const auto& op : ops) {
    if (!first)
      j << ",";
    first = false;
    const char* kind = "rect";
    if (op.kind == DrawOp::Kind::Text)
      kind = "text";
    else if (op.kind == DrawOp::Kind::Image)
      kind = "image";
    else if (op.kind == DrawOp::Kind::PushClip)
      kind = "pushClip";
    else if (op.kind == DrawOp::Kind::PopClip)
      kind = "popClip";
    j << "{\"type\":\"" << kind << "\",\"x\":" << op.x << ",\"y\":" << op.y
      << ",\"w\":" << op.w << ",\"h\":" << op.h << ",\"nodeId\":" << op.nodeId;
    if (op.kind == DrawOp::Kind::Rect || op.kind == DrawOp::Kind::Text) {
      char cbuf[16];
      snprintf(cbuf, sizeof(cbuf), "%02x%02x%02x", (op.color >> 24) & 0xff,
               (op.color >> 16) & 0xff, (op.color >> 8) & 0xff);
      j << ",\"color\":\"#" << cbuf << "\"";
    }
    if (op.kind == DrawOp::Kind::Text) {
      j << ",\"text\":\"" << jsonEscape(op.text)
        << "\",\"fontSize\":" << op.fontSize;
    }
    if (op.kind == DrawOp::Kind::Image)
      j << ",\"asset\":\"" << jsonEscape(op.asset) << "\"";
    j << "}";
  }
  j << "]}";
  std::ofstream out(headlessOut_, std::ios::trunc);
  if (out)
    out << j.str() << "\n";
}

void RnHost::logHeadlessOps(const std::vector<DrawOp>& ops) {
  // Compact ops for the check harness: every text (string + box),
  // every pressable rect (nodeId + box + colour), and every visible
  // coloured rect that is NOT a pressable (a button's colour often
  // lives on an outer View while its Pressable is transparent — the
  // go-live button's #E52B42 is on the Animated.View wrapping the
  // Pressable, so the press list alone never shows it; the check
  // clicks the rect's centre and the hit-test resolves to the
  // Pressable on top). Logged only when the screen's text changes,
  // so the serial log carries one line per screen instead of one
  // per commit. Rects are capped: the log line buffer is 32 KB.
  std::string sig;
  for (const auto& op : ops) {
    if (op.kind == DrawOp::Kind::Text) {
      sig += op.text;
      sig += '\n';
    }
  }
  if (sig == headlessLastOpsSig_)
    return;
  headlessLastOpsSig_ = sig;
  std::ostringstream j;
  j << "{\"texts\":[";
  bool first = true;
  for (const auto& op : ops) {
    if (op.kind != DrawOp::Kind::Text)
      continue;
    if (!first)
      j << ",";
    first = false;
    j << "{\"t\":\"" << jsonEscape(op.text) << "\",\"x\":" << (int)op.x
      << ",\"y\":" << (int)op.y << ",\"w\":" << (int)op.w
      << ",\"h\":" << (int)op.h << "}";
  }
  j << "],\"press\":[";
  first = true;
  for (const auto& op : ops) {
    if (op.nodeId < 0)
      continue;
    if (!first)
      j << ",";
    first = false;
    char cbuf[16];
    snprintf(cbuf, sizeof(cbuf), "%02x%02x%02x", (op.color >> 24) & 0xff,
             (op.color >> 16) & 0xff, (op.color >> 8) & 0xff);
    j << "{\"nodeId\":" << op.nodeId << ",\"x\":" << (int)op.x
      << ",\"y\":" << (int)op.y << ",\"w\":" << (int)op.w
      << ",\"h\":" << (int)op.h << ",\"color\":\"#" << cbuf << "\"}";
  }
  j << "],\"rects\":[";
  first = true;
  int rectCount = 0;
  for (const auto& op : ops) {
    if (op.kind != DrawOp::Kind::Rect || op.nodeId >= 0)
      continue;
    if (((op.color >> 0) & 0xff) == 0)
      continue; // fully transparent
    if (rectCount >= 48)
      break;
    rectCount++;
    if (!first)
      j << ",";
    first = false;
    char cbuf[16];
    snprintf(cbuf, sizeof(cbuf), "%02x%02x%02x", (op.color >> 24) & 0xff,
             (op.color >> 16) & 0xff, (op.color >> 8) & 0xff);
    j << "{\"x\":" << (int)op.x << ",\"y\":" << (int)op.y
      << ",\"w\":" << (int)op.w << ",\"h\":" << (int)op.h
      << ",\"color\":\"#" << cbuf << "\"}";
  }
  j << "]}";
  logLine("HOST headless ops %s", j.str().c_str());
}

// US-layout char -> (evdev keycode, shift). The renderer's key handler
// maps evdev codes back to characters with the same table.
static bool charToKey(char c, uint32_t& code, bool& shift) {
  shift = false;
  if (c >= 'a' && c <= 'z') {
    static const uint32_t map[26] = {30, 48, 46, 32, 18, 33, 34, 35, 23, 36,
                                     37, 38, 50, 49, 24, 25, 16, 19, 31, 20,
                                     22, 47, 17, 45, 21, 44};
    code = map[c - 'a'];
    return true;
  }
  if (c >= 'A' && c <= 'Z') {
    if (!charToKey((char)(c - 'A' + 'a'), code, shift))
      return false;
    shift = true;
    return true;
  }
  if (c >= '1' && c <= '9') {
    code = (uint32_t)(c - '1' + 2);
    return true;
  }
  switch (c) {
    case '0': code = 11; return true;
    case ' ': code = 57; return true;
    case '.': code = 52; return true;
    case ',': code = 51; return true;
    case '/': code = 53; return true;
    case '-': code = 12; return true;
    case '=': code = 13; return true;
    case ';': code = 39; return true;
    case '\'': code = 40; return true;
    case '[': code = 26; return true;
    case ']': code = 27; return true;
    case '\\': code = 43; return true;
    case '`': code = 41; return true;
    case '!': shift = true; code = 2; return true;
    case '@': shift = true; code = 3; return true;
    case '#': shift = true; code = 4; return true;
    case '$': shift = true; code = 5; return true;
    case '%': shift = true; code = 6; return true;
    case '^': shift = true; code = 7; return true;
    case '&': shift = true; code = 8; return true;
    case '*': shift = true; code = 9; return true;
    case '(': shift = true; code = 10; return true;
    case ')': shift = true; code = 11; return true;
    case '_': shift = true; code = 12; return true;
    case '+': shift = true; code = 13; return true;
    case ':': shift = true; code = 39; return true;
    case '"': shift = true; code = 40; return true;
    case '?': shift = true; code = 53; return true;
    case '<': shift = true; code = 51; return true;
    case '>': shift = true; code = 52; return true;
    default: return false;
  }
}

void RnHost::loadHeadlessInput() {
  headlessEvents_.clear();
  headlessEventIdx_ = 0;
  if (headlessInput_.empty())
    return;
  std::ifstream in(headlessInput_);
  if (!in) {
    logLine("HOST cannot open headless input %s", headlessInput_.c_str());
    return;
  }
  // The file is one line per `sevyn files write` (the check writes it
  // through the Terminal, which is single-line): events are separated
  // by ';' (and newlines). A `type` event expands into key down/up
  // pairs, one char per 30 ms, so the check types whole strings in a
  // single event instead of one event per key.
  std::stringstream ss;
  ss << in.rdbuf();
  std::string content = ss.str();
  size_t pos = 0;
  while (pos < content.size()) {
    size_t end = content.find_first_of(";\n", pos);
    std::string ev = content.substr(
        pos, end == std::string::npos ? std::string::npos : end - pos);
    pos = end == std::string::npos ? content.size() : end + 1;
    // Trim leading whitespace.
    size_t first = ev.find_first_not_of(" \t\r");
    if (first == std::string::npos)
      continue;
    ev = ev.substr(first);
    std::istringstream es(ev);
    HeadlessEvent hev;
    std::string kind;
    if (!(es >> hev.atMs >> kind))
      continue;
    if (kind == "pointer") {
      std::string action;
      if (!(es >> action >> hev.x >> hev.y))
        continue;
      hev.isPointer = true;
      // The renderer's pointer handler expects type "button" with
      // pressed=true for a tap; "move" for motion.
      hev.type = action == "move" ? "move" : "button";
      hev.pressed = action == "down";
      headlessEvents_.push_back(hev);
    } else if (kind == "tap") {
      // A tap is a down + an up 120 ms apart (one event, not two).
      double x = 0, y = 0;
      if (!(es >> x >> y))
        continue;
      HeadlessEvent down, up;
      down.atMs = hev.atMs;
      down.isPointer = true;
      down.type = "button";
      down.x = x;
      down.y = y;
      down.pressed = true;
      up.atMs = hev.atMs + 120;
      up.isPointer = true;
      up.type = "button";
      up.x = x;
      up.y = y;
      up.pressed = false;
      headlessEvents_.push_back(down);
      headlessEvents_.push_back(up);
    } else if (kind == "scroll") {
      // Scroll the ScrollView under (x, y) by (dx, dy) — the driver's
      // way to reach below-the-fold controls (Tokrah's Go Live
      // screen flexes its preview, so its Start button is always
      // below the fold). The renderer clamps at the content edge.
      if (!(es >> hev.x >> hev.y >> hev.dx >> hev.dy))
        continue;
      hev.isPointer = false;
      hev.isScroll = true;
      headlessEvents_.push_back(hev);
    } else if (kind == "key") {
      std::string action;
      int shift = 0;
      if (!(es >> hev.code >> action >> shift))
        continue;
      hev.isPointer = false;
      hev.pressed = action == "down";
      hev.shift = shift != 0;
      headlessEvents_.push_back(hev);
    } else if (kind == "type") {
      // The rest of the event (up to ';' or end of line) is the text.
      std::string text;
      std::getline(es, text);
      size_t tfirst = text.find_first_not_of(" \t\r");
      if (tfirst != std::string::npos)
        text = text.substr(tfirst);
      long long t = hev.atMs;
      for (char c : text) {
        uint32_t code = 0;
        bool shift = false;
        if (!charToKey(c, code, shift)) {
          logLine("HOST headless input: no key for %c, skipping", c);
          continue;
        }
        HeadlessEvent down, up;
        down.atMs = t;
        down.isPointer = false;
        down.code = code;
        down.pressed = true;
        down.shift = shift;
        up.atMs = t + 15;
        up.isPointer = false;
        up.code = code;
        up.pressed = false;
        up.shift = shift;
        headlessEvents_.push_back(down);
        headlessEvents_.push_back(up);
        t += 30;
      }
    }
  }
  std::sort(headlessEvents_.begin(), headlessEvents_.end(),
            [](const HeadlessEvent& a, const HeadlessEvent& b) {
              return a.atMs < b.atMs;
            });
  logLine("HOST headless input: %zu events from %s", headlessEvents_.size(),
          headlessInput_.c_str());
}

void RnHost::fireDueHeadlessInput() {
  if (headlessEvents_.empty())
    return;
  long long elapsed = nowMs() - headlessStartMs_;
  while (headlessEventIdx_ < headlessEvents_.size() &&
         headlessEvents_[headlessEventIdx_].atMs <= elapsed) {
    const HeadlessEvent& ev = headlessEvents_[headlessEventIdx_++];
    if (ev.isScroll) {
      dispatchScroll(ev.x, ev.y, ev.dx, ev.dy);
    } else if (ev.isPointer) {
      // A tap is a down + an up; the file carries both lines.
      dispatchPointer(ev.type, ev.x, ev.y, /*button=*/1, ev.pressed);
    } else {
      dispatchKey(ev.code, ev.pressed, ev.shift);
    }
  }
}

int RnHost::run() {
  const bool isApp = !appId_.empty();
  if (headless_) {
    logLine("HOST headless mode: no Wayland surface");
  } else {
  wayland_ = std::make_unique<Wayland>(
      width_, height_, /*fullscreen=*/!isApp,
      isApp ? appName_ : "SevynOS Shell",
      isApp ? appId_ : "sevyn-shell");
  if (!wayland_->ok()) {
    logLine("HOST Wayland setup failed");
    return 1;
  }
  // M9: the Wayland constructor sizes the fullscreen shell to the
  // output's preferred mode (1920x1080 in QEMU, panel native on
  // hardware) — the constructor path never fires the size handler,
  // so sync the host size here, before installSevyn publishes
  // Sevyn.width/height to JS. Without this the shell laid out at
  // the 1024x768 default inside a 1920-wide buffer (top bar 1024
  // wide, desktop colour beyond). App windows keep their
  // --width/--height; headless keeps its --width/--height.
  width_ = wayland_->width();
  height_ = wayland_->height();
  }
  if (isApp && !headless_) {
    // The compositor's close request ends the app (the shell is not
    // closable). Exit code 0: appd reports STOPPED, not CRASHED.
    wayland_->setCloseHandler(
        [this] { exitRequested_.store(true); });
  }
  yoga_ = std::make_unique<YogaBridge>();
  // Status is permission-gated: an app without status.read gets no
  // subscriber, so no broadcasts ever reach it and getStatus() stays
  // empty. The shell always has the permission.
  if (hasPermission("status.read")) {
    status_ = std::make_unique<StatusClient>();
    status_->setHandler([this](const std::string& key,
                               const std::string& value) {
      std::lock_guard<std::mutex> lk(statusMutex_);
      statusSnapshot_[key] = value;
      statusQueue_.push({key, value});
    });
    status_->start();
  }
  // The appd subscriber runs for the shell (dock list + events) and
  // for apps too (an app sees other apps' events; harmless, and the
  // template never subscribes). It retries its connect, so a slow
  // appd start does not fail the host.
  appClient_ = std::make_unique<AppClient>();
  appClient_->setEventHandler([this](const std::string& line) {
    std::lock_guard<std::mutex> lk(appEventMutex_);
    appEventQueue_.push(line);
  });
  appClient_->start();

  if (!headless_) {
  wayland_->setPointerHandler(
      [this](const std::string& type, double x, double y, uint32_t button,
             bool pressed) { dispatchPointer(type, x, y, button, pressed); });
  // GF65 scroll fix: wheel/trackpad axis events reach the
  // renderer's scrollAt through the existing dispatchScroll (the
  // same path the headless `scroll` input lines use).
  wayland_->setScrollHandler(
      [this](double x, double y, double dx, double dy) {
        dispatchScroll(x, y, dx, dy);
      });
  wayland_->setKeyHandler(
      [this](uint32_t key, bool pressed, bool shift) {
        dispatchKey(key, pressed, shift);
      });
  // M9: a configure with a new size (resize drag, output mode)
  // re-lays out JS at the new size.
  wayland_->setSizeHandler(
      [this](int w, int h) { dispatchSize(w, h); });
  // Window-focus fix: a configure that flips the maximized flag
  // (maximize/unmaximize, or a title-bar drag restoring a maximized
  // window) updates the window state for the title bar. A minimized
  // window gets no configures, so its state is never overwritten
  // here — minimizeApp()/the focus remap own it.
  wayland_->setWindowStateHandler([this](bool maximized) {
    if (maximized)
      setWindowState("maximized");
    else if (windowState_ != "minimized")
      setWindowState("normal");
  });
  }

  try {
    runtime_ = facebook::hermes::makeHermesRuntime();
  } catch (const std::exception& e) {
    logLine("HOST Hermes runtime creation failed: %s", e.what());
    return 1;
  }
  jsi::Runtime& rt = *runtime_;
  installSevyn(rt);
  installTimers(rt);

  // Load the bundle (Hermes bytecode). A throwing bundle fails here
  // with exit 1: for an app that is the sandbox working — appd reaps
  // it as APP CRASHED and the shell keeps running.
  std::ifstream in(bundle_, std::ios::binary);
  if (!in) {
    logLine("HOST cannot open bundle %s", bundle_.c_str());
    return 1;
  }
  std::stringstream ss;
  ss << in.rdbuf();
  std::string bytes = ss.str();
  logLine("HOST loading bundle %s (%zu bytes)", bundle_.c_str(),
          bytes.size());
  try {
    auto buf = std::make_shared<jsi::StringBuffer>(bytes);
    auto prepared = rt.prepareJavaScript(buf, bundle_);
    rt.evaluatePreparedJavaScript(prepared);
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("HOST bundle failed: %s", e.getMessage().c_str());
    logLine("HOST bundle stack: %s", e.getStack().c_str());
    return 1;
  }
  if (isApp)
    logLine("HOST app running (SEVYNOS_M3_APP_READY) %s", appId_.c_str());
  else
    logLine("HOST shell running (SEVYNOS_M2_READY)");

  if (headless_) {
    // Headless main loop: no compositor to drive us. Timers, status
    // and app-event updates drain each tick; input arrives from the
    // timed event file. With --headless-seconds the run ends on
    // schedule (exit 0); without it the host runs until killed or the
    // bundle closes itself via Sevyn.closeApp().
    headlessStartMs_ = nowMs();
    loadHeadlessInput();
    // Heartbeat every 5 s: proves the loop is alive even when the app
    // logs nothing. If it stops, the loop is blocked inside a JS call
    // (a spinning microtask/timer) or the process is dead — the two
    // failure modes the navigate flake kept conflating.
    long long lastBeatMs = 0;
    while (true) {
      if (exitRequested_.load()) {
        logLine("HOST %s exiting (close requested)",
                isApp ? "app" : "shell");
        return 0;
      }
      if (headlessSeconds_ > 0 &&
          nowMs() - headlessStartMs_ >= (long long)headlessSeconds_ * 1000) {
        logLine("HOST headless run complete (%d seconds, %lld presents)",
                headlessSeconds_, headlessPresents_);
        return 0;
      }
      // A throwing microtask (e.g. an unhandled promise rejection
      // from a navigation) must not kill the host: drainMicrotasks
      // propagates it, and an uncaught JSError aborts the process
      // with no log. Log it and keep the loop alive instead — the
      // app stays up and the next input event can still land.
      try {
        fireDueHeadlessInput();
        fireDueTimers(rt);
        rt.drainMicrotasks();
        drainStatusQueue();
        drainAppEventQueue();
        drainExecCompletions(rt);
      } catch (const jsi::JSError& e) {
        logLine("HOST headless tick failed: %s", e.getMessage().c_str());
        logLine("HOST headless tick stack: %s", e.getStack().c_str());
      }
      long long elapsed = nowMs() - headlessStartMs_;
      if (elapsed - lastBeatMs >= 5000) {
        lastBeatMs = elapsed;
        logLine("HOST headless beat %llds (%lld presents)", elapsed / 1000,
                headlessPresents_);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    return 0;
  }

  // Main loop: Wayland events drive JS; status + app-event updates
  // drain each tick. A close request (window X or Sevyn.closeApp())
  // exits cleanly with code 0.
  while (true) {
    if (exitRequested_.load()) {
      logLine("HOST %s exiting (close requested)",
              isApp ? "app" : "shell");
      return 0;
    }
    if (!wayland_->dispatch(16)) {
      logLine("HOST Wayland display lost, exiting");
      return 1;
    }
    // Same guard as the headless loop: a throwing microtask must not
    // kill the shell.
    try {
      fireDueTimers(rt);
      rt.drainMicrotasks();
      drainStatusQueue();
      drainAppEventQueue();
      drainExecCompletions(rt);
    } catch (const jsi::JSError& e) {
      logLine("HOST tick failed: %s", e.getMessage().c_str());
      logLine("HOST tick stack: %s", e.getStack().c_str());
    }
  }
  return 0;
}

} // namespace

int main(int argc, char** argv) {
  // A peer closing a socket must never kill the shell (or an app):
  // socket writes then fail with EPIPE and the client's retry /
  // reconnect logic handles it. appd and statusd already do this;
  // the host was the one process that did not, and a write to appd
  // during first contact could kill the shell silently (SIGPIPE
  // leaves no kernel log). See v2-m3 CI run 42360955143.
  signal(SIGPIPE, SIG_IGN);
  // M9: logLine writes every line to stderr as well as /dev/console.
  // For the shell host stderr is a regular file (never blocks), but
  // for a detached headless host stderr is /dev/console — a tty
  // whose output drains through the serial to the harness. When the
  // serial backlogs, a blocking stderr write stalls the host: the
  // main loop blocks inside logLine on its first beat/ops line and
  // the run never presents, never logs ops, never completes (the
  // M9 Tokrah headless hang — the loop stopped right after the
  // bundle mounted, with the guest otherwise idle). Make stderr
  // non-blocking: a write that would block is dropped (logging is
  // best-effort) instead of stalling the host. On a regular file
  // O_NONBLOCK is a no-op, so the shell host's /tmp/sevyn-host.log
  // (which init greps for SEVYNOS_M2_READY) is unaffected.
  {
    int flags = fcntl(STDERR_FILENO, F_GETFL, 0);
    if (flags >= 0)
      (void)fcntl(STDERR_FILENO, F_SETFL, flags | O_NONBLOCK);
  }
  std::string bundle = kDefaultBundle;
  int width = kDefaultWidth, height = kDefaultHeight;
  std::string appId, appName, appColor, appGlyph, permissionsCsv;
  bool headless = false;
  int headlessSeconds = 0;
  std::string headlessOut, headlessInput;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--bundle" && i + 1 < argc)
      bundle = argv[++i];
    else if (a == "--width" && i + 1 < argc)
      width = atoi(argv[++i]);
    else if (a == "--height" && i + 1 < argc)
      height = atoi(argv[++i]);
    else if (a == "--app" && i + 1 < argc)
      appId = argv[++i];
    else if (a == "--name" && i + 1 < argc)
      appName = argv[++i];
    else if (a == "--color" && i + 1 < argc)
      appColor = argv[++i];
    else if (a == "--glyph" && i + 1 < argc)
      appGlyph = argv[++i];
    else if (a == "--permissions" && i + 1 < argc)
      permissionsCsv = argv[++i];
    else if (a == "--headless")
      headless = true;
    else if (a == "--headless-seconds" && i + 1 < argc)
      headlessSeconds = atoi(argv[++i]);
    else if (a == "--headless-out" && i + 1 < argc)
      headlessOut = argv[++i];
    else if (a == "--headless-input" && i + 1 < argc)
      headlessInput = argv[++i];
    else if (a == "--help" || a == "-h") {
      fprintf(stderr,
              "usage: sevyn-rn-host [--bundle <path>] [--width <px>] "
              "[--height <px>] [--app <id>] [--name <name>] "
              "[--color <#rrggbb>] [--glyph <letter>] "
              "[--permissions <csv>] [--headless] "
              "[--headless-seconds <n>] [--headless-out <path>] "
              "[--headless-input <path>]\n");
      return 0;
    }
  }
  std::set<std::string> permissions;
  size_t start = 0;
  while (start < permissionsCsv.size()) {
    size_t comma = permissionsCsv.find(',', start);
    if (comma == std::string::npos) {
      permissions.insert(permissionsCsv.substr(start));
      break;
    }
    permissions.insert(permissionsCsv.substr(start, comma - start));
    start = comma + 1;
  }
  // Shell mode (no --app) writes its pid file so `sevyn shell
  // kill|status` can find it. App hosts do not: their lifecycle is
  // appd's job. A stale file (dead pid) counts as not running — the
  // CLI checks liveness, not just the file.
  if (appId.empty()) {
    std::ofstream pidFile("/run/sevyn-shell.pid");
    if (pidFile)
      pidFile << getpid() << "\n";
  }
  RnHost host(width, height, bundle, appId, appName, appColor, appGlyph,
              permissions, headless, headlessSeconds, headlessOut,
              headlessInput);
  return host.run();
}
