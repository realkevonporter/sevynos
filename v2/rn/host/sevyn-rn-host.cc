// SevynOS v2 M2 — the React Native host (sevyn-rn-host).
//
// One process, one app (the shell in M2). Embeds Hermes, lays out with
// Yoga, paints to a Wayland surface, forwards pointer/keyboard input and
// statusd broadcasts to JS. See v2/rn/README.md for the host ↔ JS
// contract.
//
// Usage: sevyn-rn-host [--bundle <path>] [--width <px>] [--height <px>]
//   bundle default: /usr/share/sevyn/shell/shell.hbc
//   size default: 1024x768 (the Weston output mode)
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include <hermes/hermes.h>
#include <jsi/jsi.h>

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

// --- the host ---
class RnHost {
 public:
  RnHost(int width, int height, std::string bundle)
      : width_(width), height_(height), bundle_(std::move(bundle)) {}

  // Stop the status subscriber thread FIRST, while every member its
  // handler touches (statusMutex_/statusQueue_/statusSnapshot_) is
  // still alive. Members are destroyed in reverse declaration order,
  // so without this the thread could fire its handler on already
  // destroyed members during teardown — seen in CI as a segfault when
  // a STATUS broadcast arrived while the host was exiting.
  ~RnHost() {
    if (status_)
      status_->stop();
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
  void dispatchKey(uint32_t key, bool pressed);
  void drainStatusQueue();

  int width_, height_;
  std::string bundle_;
  std::unique_ptr<Wayland> wayland_;
  std::unique_ptr<YogaBridge> yoga_;
  std::unique_ptr<StatusClient> status_;
  std::unique_ptr<jsi::Runtime> runtime_;
  std::unordered_map<std::string, std::string> statusSnapshot_;
  std::mutex statusMutex_;
  std::queue<std::pair<std::string, std::string>> statusQueue_;

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
  bool hasPointerHandler_ = false;
  bool hasKeyHandler_ = false;
  bool hasStatusHandler_ = false;

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
             w = wayland_->painter().measureTextWidth(text, size, bold);
             h = wayland_->painter().measureTextHeight(text, size, bold,
                                                       maxW);
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
             wayland_->present(ops, bg);
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
  hostFn("getStatus", 0,
         [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*,
                size_t) {
           jsi::Object o(rt);
           std::lock_guard<std::mutex> lk(statusMutex_);
           for (auto& kv : statusSnapshot_)
             o.setProperty(rt, kv.first.c_str(), kv.second.c_str());
           return o;
         });
  hostFn("launchApp", 1,
         [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args,
            size_t count) {
           // M2: launching is M3's app runtime. Record the attempt so
           // the check can assert the click reached the shell.
           if (count >= 1)
             logLine("LAUNCH %s", jsString(rt, args[0]).c_str());
           return jsi::Value(true);
         });
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
    }
    pointerHandler_->call(rt, ev);
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS pointer handler failed: %s", e.getMessage().c_str());
  }
}

void RnHost::dispatchKey(uint32_t key, bool pressed) {
  if (!hasKeyHandler_ || !runtime_)
    return;
  jsi::Runtime& rt = *runtime_;
  try {
    jsi::Object ev(rt);
    ev.setProperty(rt, "key", (double)key);
    ev.setProperty(rt, "pressed", pressed);
    keyHandler_->call(rt, ev);
    rt.drainMicrotasks();
  } catch (const jsi::JSError& e) {
    logLine("JS key handler failed: %s", e.getMessage().c_str());
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

int RnHost::run() {
  wayland_ = std::make_unique<Wayland>(width_, height_);
  if (!wayland_->ok()) {
    logLine("HOST Wayland setup failed");
    return 1;
  }
  yoga_ = std::make_unique<YogaBridge>();
  status_ = std::make_unique<StatusClient>();
  status_->setHandler([this](const std::string& key,
                             const std::string& value) {
    std::lock_guard<std::mutex> lk(statusMutex_);
    statusSnapshot_[key] = value;
    statusQueue_.push({key, value});
  });
  status_->start();

  wayland_->setPointerHandler(
      [this](const std::string& type, double x, double y, uint32_t button,
             bool pressed) { dispatchPointer(type, x, y, button, pressed); });
  wayland_->setKeyHandler(
      [this](uint32_t key, bool pressed) { dispatchKey(key, pressed); });

  try {
    runtime_ = facebook::hermes::makeHermesRuntime();
  } catch (const std::exception& e) {
    logLine("HOST Hermes runtime creation failed: %s", e.what());
    return 1;
  }
  jsi::Runtime& rt = *runtime_;
  installSevyn(rt);
  installTimers(rt);

  // Load the shell bundle (Hermes bytecode).
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
  logLine("HOST shell running (SEVYNOS_M2_READY)");

  // Main loop: Wayland events drive JS; status updates drain each tick.
  while (true) {
    if (!wayland_->dispatch(16)) {
      logLine("HOST Wayland display lost, exiting");
      return 1;
    }
    fireDueTimers(rt);
    rt.drainMicrotasks();
    drainStatusQueue();
  }
  return 0;
}

} // namespace

int main(int argc, char** argv) {
  std::string bundle = kDefaultBundle;
  int width = kDefaultWidth, height = kDefaultHeight;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--bundle" && i + 1 < argc)
      bundle = argv[++i];
    else if (a == "--width" && i + 1 < argc)
      width = atoi(argv[++i]);
    else if (a == "--height" && i + 1 < argc)
      height = atoi(argv[++i]);
    else if (a == "--help" || a == "-h") {
      fprintf(stderr,
              "usage: sevyn-rn-host [--bundle <path>] [--width <px>] "
              "[--height <px>]\n");
      return 0;
    }
  }
  RnHost host(width, height, bundle);
  return host.run();
}
