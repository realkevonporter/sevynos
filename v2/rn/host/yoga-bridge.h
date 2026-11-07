// SevynOS v2 M2 — Yoga bridge for the RN host.
//
// Integer-id wrapper over the Yoga C API. The host's JSI bindings parse
// JS style objects and call the granular setters here; the renderer
// never touches Yoga directly. Layout is Yoga (C++), driven from JS.
#pragma once

#include <functional>
#include <map>
#include <memory>
#include <vector>

#include <yoga/Yoga.h>

namespace sevyn {

class YogaBridge {
 public:
  // Measure callback: (width, widthMode, height, heightMode) -> {w, h}.
  // Modes are YGMeasureMode values (0 undefined, 1 exactly, 2 at-most).
  using MeasureFunc =
      std::function<void(float, int, float, int, float&, float&)>;

  YogaBridge();
  ~YogaBridge();

  YogaBridge(const YogaBridge&) = delete;
  YogaBridge& operator=(const YogaBridge&) = delete;

  int createNode();
  void freeNode(int id);
  void setChildren(int id, const std::vector<int>& children);
  void setMeasureFunc(int id, MeasureFunc fn);
  void clearMeasureFunc(int id);

  // Style setters (enum values are the YG* enum ints from yoga/Yoga.h).
  void setFlexDirection(int id, int v);
  void setJustifyContent(int id, int v);
  void setAlignItems(int id, int v);
  void setAlignSelf(int id, int v);
  void setAlignContent(int id, int v);
  void setFlexWrap(int id, int v);
  void setPositionType(int id, int v);
  void setDisplay(int id, int v);
  void setOverflow(int id, int v);
  void setFlex(int id, float v);
  void setFlexGrow(int id, float v);
  void setFlexShrink(int id, float v);
  void setFlexBasisPoint(int id, float v);
  void setFlexBasisPercent(int id, float v);
  void setFlexBasisAuto(int id);
  void setWidthPoint(int id, float v);
  void setWidthPercent(int id, float v);
  void setWidthAuto(int id);
  void setHeightPoint(int id, float v);
  void setHeightPercent(int id, float v);
  void setHeightAuto(int id);
  void setMinWidthPoint(int id, float v);
  void setMinWidthPercent(int id, float v);
  void setMinHeightPoint(int id, float v);
  void setMinHeightPercent(int id, float v);
  void setMaxWidthPoint(int id, float v);
  void setMaxWidthPercent(int id, float v);
  void setMaxHeightPoint(int id, float v);
  void setMaxHeightPercent(int id, float v);
  // edge: YGEdge int (0 left, 1 top, 2 right, 3 bottom, 8 all).
  void setPadding(int id, int edge, float v);
  void setPaddingPercent(int id, int edge, float v);
  void setMargin(int id, int edge, float v);
  void setMarginPercent(int id, int edge, float v);
  void setMarginAuto(int id, int edge);

  void calculateLayout(int rootId, float width, float height);
  void getLayout(int id, float& x, float& y, float& w, float& h);

  // Called by the Yoga measure thunk (C callback) for a measured node.
  void callMeasure(int id, float width, int widthMode, float height,
                   int heightMode, float& w, float& h);

 private:
  YGNodeRef node(int id);
  std::map<int, YGNodeRef> nodes_;
  std::map<int, MeasureFunc> measures_;
  int nextId_ = 1;
};

} // namespace sevyn
