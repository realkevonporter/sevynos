// SevynOS v2 M2 — Yoga bridge (see yoga-bridge.h).
#include "yoga-bridge.h"

#include "common.h"

namespace sevyn {

namespace {
// The Yoga measure callback is a C function pointer, so it reaches the
// bridge through a file-static instance. The host runs exactly one
// bridge in one process; this is that instance.
YogaBridge* g_bridge = nullptr;

YGSize measureThunk(YGNodeConstRef node, float width, YGMeasureMode widthMode,
                    float height, YGMeasureMode heightMode) {
  YGSize out{0, 0};
  if (!g_bridge)
    return out;
  void* ctx = YGNodeGetContext(node);
  int id = (int)(intptr_t)ctx;
  float w = 0, h = 0;
  g_bridge->callMeasure(id, width, (int)widthMode, height, (int)heightMode,
                        w, h);
  out.width = w;
  out.height = h;
  return out;
}
} // namespace

YogaBridge::YogaBridge() { g_bridge = this; }

YogaBridge::~YogaBridge() {
  for (auto& kv : nodes_)
    YGNodeFree(kv.second);
  nodes_.clear();
  if (g_bridge == this)
    g_bridge = nullptr;
}

YGNodeRef YogaBridge::node(int id) {
  auto it = nodes_.find(id);
  return it == nodes_.end() ? nullptr : it->second;
}

int YogaBridge::createNode() {
  int id = nextId_++;
  nodes_[id] = YGNodeNew();
  return id;
}

void YogaBridge::freeNode(int id) {
  auto it = nodes_.find(id);
  if (it == nodes_.end())
    return;
  YGNodeFree(it->second);
  nodes_.erase(it);
  measures_.erase(id);
}

void YogaBridge::setChildren(int id, const std::vector<int>& children) {
  YGNodeRef n = node(id);
  if (!n)
    return;
  while (YGNodeGetChildCount(n) > 0)
    YGNodeRemoveChild(n, YGNodeGetChild(n, 0));
  for (size_t i = 0; i < children.size(); i++) {
    YGNodeRef c = node(children[i]);
    if (c)
      YGNodeInsertChild(n, c, (uint32_t)i);
  }
}

void YogaBridge::setMeasureFunc(int id, MeasureFunc fn) {
  YGNodeRef n = node(id);
  if (!n)
    return;
  measures_[id] = fn;
  YGNodeSetContext(n, (void*)(intptr_t)id);
  YGNodeSetMeasureFunc(n, &measureThunk);
}

void YogaBridge::clearMeasureFunc(int id) {
  YGNodeRef n = node(id);
  if (!n)
    return;
  measures_.erase(id);
  YGNodeSetMeasureFunc(n, nullptr);
}

void YogaBridge::callMeasure(int id, float width, int widthMode,
                             float height, int heightMode, float& w,
                             float& h) {
  auto it = measures_.find(id);
  if (it == measures_.end()) {
    w = 0;
    h = 0;
    return;
  }
  it->second(width, widthMode, height, heightMode, w, h);
}

void YogaBridge::calculateLayout(int rootId, float width, float height) {
  YGNodeRef n = node(rootId);
  if (n)
    YGNodeCalculateLayout(n, width, height, YGDirectionLTR);
}

void YogaBridge::getLayout(int id, float& x, float& y, float& w, float& h) {
  YGNodeRef n = node(id);
  if (!n) {
    x = y = w = h = 0;
    return;
  }
  x = YGNodeLayoutGetLeft(n);
  y = YGNodeLayoutGetTop(n);
  w = YGNodeLayoutGetWidth(n);
  h = YGNodeLayoutGetHeight(n);
}

// --- style setters (each is a one-line Yoga call; the host's JSI
// binding parses the JS style object and calls these) ---
void YogaBridge::setFlexDirection(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexDirection(n, (YGFlexDirection)v);
}
void YogaBridge::setJustifyContent(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetJustifyContent(n, (YGJustify)v);
}
void YogaBridge::setAlignItems(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetAlignItems(n, (YGAlign)v);
}
void YogaBridge::setAlignSelf(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetAlignSelf(n, (YGAlign)v);
}
void YogaBridge::setAlignContent(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetAlignContent(n, (YGAlign)v);
}
void YogaBridge::setFlexWrap(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexWrap(n, (YGWrap)v);
}
void YogaBridge::setPositionType(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetPositionType(n, (YGPositionType)v);
}
void YogaBridge::setPosition(int id, int edge, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetPosition(n, (YGEdge)edge, v);
}
void YogaBridge::setPositionPercent(int id, int edge, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetPositionPercent(n, (YGEdge)edge, v);
}
void YogaBridge::setDisplay(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetDisplay(n, (YGDisplay)v);
}
void YogaBridge::setOverflow(int id, int v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetOverflow(n, (YGOverflow)v);
}
void YogaBridge::setFlex(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlex(n, v);
}
void YogaBridge::setFlexGrow(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexGrow(n, v);
}
void YogaBridge::setFlexShrink(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexShrink(n, v);
}
void YogaBridge::setFlexBasisPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexBasis(n, v);
}
void YogaBridge::setFlexBasisPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexBasisPercent(n, v);
}
void YogaBridge::setFlexBasisAuto(int id) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetFlexBasisAuto(n);
}
void YogaBridge::setWidthPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetWidth(n, v);
}
void YogaBridge::setWidthPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetWidthPercent(n, v);
}
void YogaBridge::setWidthAuto(int id) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetWidthAuto(n);
}
void YogaBridge::setHeightPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetHeight(n, v);
}
void YogaBridge::setHeightPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetHeightPercent(n, v);
}
void YogaBridge::setHeightAuto(int id) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetHeightAuto(n);
}
void YogaBridge::setMinWidthPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMinWidth(n, v);
}
void YogaBridge::setMinWidthPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMinWidthPercent(n, v);
}
void YogaBridge::setMinHeightPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMinHeight(n, v);
}
void YogaBridge::setMinHeightPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMinHeightPercent(n, v);
}
void YogaBridge::setMaxWidthPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMaxWidth(n, v);
}
void YogaBridge::setMaxWidthPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMaxWidthPercent(n, v);
}
void YogaBridge::setMaxHeightPoint(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMaxHeight(n, v);
}
void YogaBridge::setMaxHeightPercent(int id, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMaxHeightPercent(n, v);
}
void YogaBridge::setPadding(int id, int edge, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetPadding(n, (YGEdge)edge, v);
}
void YogaBridge::setPaddingPercent(int id, int edge, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetPaddingPercent(n, (YGEdge)edge, v);
}
void YogaBridge::setMargin(int id, int edge, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMargin(n, (YGEdge)edge, v);
}
void YogaBridge::setMarginPercent(int id, int edge, float v) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMarginPercent(n, (YGEdge)edge, v);
}
void YogaBridge::setMarginAuto(int id, int edge) {
  YGNodeRef n = node(id);
  if (n)
    YGNodeStyleSetMarginAuto(n, (YGEdge)edge);
}

} // namespace sevyn
