// SevynOS v2 M2 — shared types for the RN host.
//
// The host paints a flat draw-op list per commit (see v2/rn/README.md).
// The renderer (JS) emits ops; the painter executes them. Ops are plain
// data — no JS values cross this boundary.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace sevyn {

// One draw operation. Coordinates are in shell pixels (1024x768 surface).
struct DrawOp {
  enum class Kind { Rect, Text, Image, PushClip, PopClip };
  Kind kind = Kind::Rect;
  // Rect / clip / image box.
  float x = 0, y = 0, w = 0, h = 0;
  // Rect: fill colour. Text: glyph colour. 0xRRGGBBAA.
  uint32_t color = 0x000000ff;
  // Rect corner radius (px). Text/image ignore it.
  float radius = 0;
  // Text.
  std::string text;
  float fontSize = 14;
  bool fontBold = false;
  // Text alignment within (x, y, w): 0 left, 1 centre, 2 right.
  int align = 0;
  // Image: absolute path in the image (assets are staged under /usr/share/sevyn/shell/).
  std::string asset;
  // Hit-test id: the renderer tags pressable rects/texts so a pointer
  // event can be routed back to the JS node. -1 = not pressable.
  int nodeId = -1;
};

// Parse "#RRGGBB" / "#RRGGBBAA" / "rgb(r,g,b)" into 0xRRGGBBAA.
// Returns false on parse failure (caller falls back to a default).
bool parseColor(const std::string& s, uint32_t& out);

// Monotonic-ms timestamp, for log prefixes (same shape as the M1 clients).
long long nowMs();

// Log to /dev/console (if open) and stderr. The QEMU harness reads the
// serial stream, so everything the check asserts on goes through here.
void logLine(const char* fmt, ...);

} // namespace sevyn
