#include "hermes/hermes.h"

#include <algorithm>
#include <fstream>
#include <chrono>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <poll.h>
#include <sstream>
#include <string>
#include <vector>
#include <unistd.h>

using facebook::hermes::makeHermesRuntime;
using facebook::jsi::Function;
using facebook::jsi::JSError;
using facebook::jsi::PropNameID;
using facebook::jsi::Runtime;
using facebook::jsi::String;
using facebook::jsi::Value;

namespace {
constexpr size_t kMaximumBridgeMessageBytes = 256 * 1024;
using Clock = std::chrono::steady_clock;
struct Timer {
  facebook::jsi::Function callback;
  Clock::time_point due;
  int delay;
  bool repeat;
};
struct HostState {
  std::map<int, Timer> timers;
  int nextTimer = 0;
  bool running = true;
};

class BytecodeBuffer final : public facebook::jsi::Buffer {
 public:
  explicit BytecodeBuffer(std::vector<uint8_t> bytes) : bytes_(std::move(bytes)) {}
  size_t size() const override { return bytes_.size(); }
  const uint8_t *data() const override { return bytes_.data(); }

 private:
  std::vector<uint8_t> bytes_;
};

std::shared_ptr<const facebook::jsi::Buffer> readBytecode(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) throw std::runtime_error("Hermes bytecode could not be opened.");
  std::vector<uint8_t> bytes(
      (std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
  if (bytes.empty()) throw std::runtime_error("Hermes bytecode is empty.");
  return std::make_shared<BytecodeBuffer>(std::move(bytes));
}

void installBridge(Runtime &runtime, HostState &state) {
  auto postMessage = Function::createFromHostFunction(
      runtime,
      PropNameID::forAscii(runtime, "__sevynPostMessage"),
      1,
      [](Runtime &runtime, const Value &, const Value *arguments, size_t count) {
        if (count != 1 || !arguments[0].isString())
          throw JSError(runtime, "__sevynPostMessage expects one JSON string.");
        const auto message = arguments[0].asString(runtime).utf8(runtime);
        if (message.size() > kMaximumBridgeMessageBytes)
          throw JSError(runtime, "__sevynPostMessage payload exceeds 256 KiB.");
        std::cout << message << std::endl;
        return Value::undefined();
      });
  runtime.global().setProperty(runtime, "__sevynPostMessage", std::move(postMessage));

  auto engine = Function::createFromHostFunction(
      runtime,
      PropNameID::forAscii(runtime, "__sevynEngine"),
      0,
      [](Runtime &runtime, const Value &, const Value *, size_t) {
        return String::createFromAscii(runtime, "hermes");
      });
  runtime.global().setProperty(runtime, "__sevynEngine", std::move(engine));

  auto readBinaryFile = Function::createFromHostFunction(
      runtime, PropNameID::forAscii(runtime, "__sevynReadBinaryFile"), 1,
      [](Runtime &runtime, const Value &, const Value *arguments, size_t count) {
        if (count != 1 || !arguments[0].isString())
          throw JSError(runtime, "__sevynReadBinaryFile expects one path.");
        const auto path = arguments[0].asString(runtime).utf8(runtime);
        const std::string prefix = "/tmp/sevynos-native/webview-";
        if (path.rfind(prefix, 0) != 0 || path.find("..") != std::string::npos ||
            path.size() < 5 || path.substr(path.size() - 5) != ".rgba")
          throw JSError(runtime, "Binary file path is outside the WebView frame directory.");
        std::ifstream stream(path, std::ios::binary | std::ios::ate);
        if (!stream) throw JSError(runtime, "WebView frame could not be opened.");
        const auto size = stream.tellg();
        if (size < 0 || size > 32 * 1024 * 1024)
          throw JSError(runtime, "WebView frame exceeds the 32 MiB limit.");
        stream.seekg(0);
        std::vector<uint8_t> bytes(static_cast<size_t>(size));
        stream.read(reinterpret_cast<char *>(bytes.data()), size);
        auto constructor = runtime.global().getPropertyAsFunction(runtime, "ArrayBuffer");
        auto object = constructor.callAsConstructor(runtime, static_cast<double>(bytes.size()));
        auto buffer = object.asObject(runtime).getArrayBuffer(runtime);
        std::memcpy(buffer.data(runtime), bytes.data(), bytes.size());
        return object;
      });
  runtime.global().setProperty(runtime, "__sevynReadBinaryFile", std::move(readBinaryFile));

  auto setTimer = Function::createFromHostFunction(
      runtime, PropNameID::forAscii(runtime, "__sevynSetTimer"), 3,
      [&state](Runtime &runtime, const Value &, const Value *arguments, size_t count) {
        if (count < 2 || !arguments[0].isObject() ||
            !arguments[0].asObject(runtime).isFunction(runtime) || !arguments[1].isNumber())
          throw JSError(runtime, "__sevynSetTimer expects a function and delay.");
        const int delay = std::max(0, static_cast<int>(arguments[1].asNumber()));
        const int id = ++state.nextTimer;
        state.timers.emplace(id, Timer{
            arguments[0].asObject(runtime).asFunction(runtime),
            Clock::now() + std::chrono::milliseconds(delay), delay,
            count >= 3 && arguments[2].getBool()});
        return Value(id);
      });
  runtime.global().setProperty(runtime, "__sevynSetTimer", std::move(setTimer));
  for (const auto *name : {"setTimeout", "setImmediate"}) {
    auto timer = Function::createFromHostFunction(
        runtime, PropNameID::forAscii(runtime, name), 2,
        [&state](Runtime &runtime, const Value &, const Value *arguments, size_t count) {
          if (count < 1 || !arguments[0].isObject() ||
              !arguments[0].asObject(runtime).isFunction(runtime))
            throw JSError(runtime, "Timer expects a callback.");
          const int delay = count > 1 && arguments[1].isNumber()
              ? std::max(0, static_cast<int>(arguments[1].asNumber())) : 0;
          const int id = ++state.nextTimer;
          state.timers.emplace(id, Timer{arguments[0].asObject(runtime).asFunction(runtime),
              Clock::now() + std::chrono::milliseconds(delay), delay, false});
          return Value(id);
        });
    runtime.global().setProperty(runtime, name, std::move(timer));
  }
  auto clearTimer = Function::createFromHostFunction(
      runtime, PropNameID::forAscii(runtime, "__sevynClearTimer"), 1,
      [&state](Runtime &, const Value &, const Value *arguments, size_t count) {
        if (count > 0 && arguments[0].isNumber())
          state.timers.erase(static_cast<int>(arguments[0].asNumber()));
        return Value::undefined();
      });
  runtime.global().setProperty(runtime, "__sevynClearTimer", std::move(clearTimer));
  for (const auto *name : {"clearTimeout", "clearImmediate"}) {
    auto clear = Function::createFromHostFunction(
        runtime, PropNameID::forAscii(runtime, name), 1,
        [&state](Runtime &, const Value &, const Value *arguments, size_t count) {
          if (count > 0 && arguments[0].isNumber()) state.timers.erase(static_cast<int>(arguments[0].asNumber()));
          return Value::undefined();
        });
    runtime.global().setProperty(runtime, name, std::move(clear));
  }
  auto terminate = Function::createFromHostFunction(
      runtime, PropNameID::forAscii(runtime, "__sevynTerminate"), 0,
      [&state](Runtime &, const Value &, const Value *, size_t) {
        state.running = false;
        return Value::undefined();
      });
  runtime.global().setProperty(runtime, "__sevynTerminate", std::move(terminate));
}

int timerWait(const HostState &state) {
  if (state.timers.empty()) return -1;
  auto due = state.timers.begin()->second.due;
  for (const auto &[_, timer] : state.timers) due = std::min(due, timer.due);
  return std::max(0, static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(due - Clock::now()).count()));
}
void fireTimers(Runtime &runtime, HostState &state) {
  const auto now = Clock::now();
  std::vector<int> ready;
  for (const auto &[id, timer] : state.timers) if (timer.due <= now) ready.push_back(id);
  for (const int id : ready) {
    auto found = state.timers.find(id);
    if (found == state.timers.end()) continue;
    const bool repeat = found->second.repeat;
    const int delay = found->second.delay;
    found->second.callback.call(runtime);
    if (repeat && state.timers.find(id) != state.timers.end()) state.timers.at(id).due = Clock::now() + std::chrono::milliseconds(delay);
    else state.timers.erase(id);
    runtime.drainMicrotasks();
  }
}
} // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: sevyn-hermes-host <runtime.hbc> <application.hbc>" << std::endl;
    return 64;
  }
  try {
    auto runtime = makeHermesRuntime();
    HostState state;
    installBridge(*runtime, state);
    runtime->evaluateJavaScript(readBytecode(argv[1]), "sevynapp://runtime/index.js");
    runtime->evaluateJavaScript(readBytecode(argv[2]), "sevynapp://application/index.js");
    runtime->drainMicrotasks();
    std::string line;
    while (state.running) {
      pollfd input{STDIN_FILENO, POLLIN, 0};
      const int result = poll(&input, 1, timerWait(state));
      if (result < 0) throw std::runtime_error("Hermes event loop poll failed.");
      fireTimers(*runtime, state);
      if (result == 0 || !(input.revents & (POLLIN | POLLHUP))) continue;
      if (!std::getline(std::cin, line)) break;
      if (line.size() > kMaximumBridgeMessageBytes) {
        std::cerr << "Host message exceeds 256 KiB." << std::endl;
        return 66;
      }
      auto receiver = runtime->global().getProperty(*runtime, "__sevynReceiveHostMessage");
      if (!receiver.isObject() || !receiver.asObject(*runtime).isFunction(*runtime)) {
        std::cerr << "Application did not install __sevynReceiveHostMessage." << std::endl;
        return 65;
      }
      receiver.asObject(*runtime)
          .asFunction(*runtime)
          .call(*runtime, String::createFromUtf8(*runtime, line));
      runtime->drainMicrotasks();
    }
    return 0;
  } catch (const JSError &error) {
    std::cerr << error.getStack() << std::endl;
  } catch (const std::exception &error) {
    std::cerr << error.what() << std::endl;
  }
  return 1;
}
