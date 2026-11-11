// SevynOS v2 M2 — CPU raster painter for the RN host.
//
// Paints a flat draw-op list into a shared-memory ARGB8888 buffer that
// the Wayland client attaches to the shell surface. CPU only, by design
// (same as M1's pixman compositor); no GL in v1.
#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "common.h"

namespace sevyn {

class Painter {
 public:
  Painter(int width, int height);
  ~Painter();

  Painter(const Painter&) = delete;
  Painter& operator=(const Painter&) = delete;

  int width() const { return width_; }
  int height() const { return height_; }
  int stride() const { return width_ * 4; }
  // Recreate the SHM backing at a new size (M9 window resize /
  // fullscreen output mode). Fonts survive; the pixel buffer does
  // not — the caller repaints after resizing.
  bool resize(int width, int height);
  // Anonymous SHM fd backing the pixel buffer (memfd).
  int shmFd() const { return shmFd_; }
  uint8_t* pixels() { return pixels_; }

  bool fontReady() const { return fontReady_; }

  // Fill the whole buffer with a background colour, reset the clip stack.
  void beginFrame(uint32_t bg);
  // Execute a draw-op list (see common.h).
  void paint(const std::vector<DrawOp>& ops);

  // FreeType text metrics: width of a UTF-8 string at the given size,
  // wrapping at maxWidth (<= 0 means no wrap). Height is the line height
  // for one line (or the wrapped height when wrapping).
  float measureTextWidth(const std::string& text, float size, bool bold);
  float measureTextHeight(const std::string& text, float size, bool bold,
                          float maxWidth);

 private:
  void fillRect(float x, float y, float w, float h, uint32_t color,
                float radius);
  void drawText(const DrawOp& op);
  void drawImage(const DrawOp& op);
  // Blend one source pixel over the destination (both 0xAARRGGBB in
  // memory order B,G,R,A on little-endian — we store XRGB via SHM
  // format WL_SHM_FORMAT_XRGB8888, so alpha is ignored by the
  // compositor; we pre-multiply coverage into the colour channels).
  void blendPixel(int px, int py, uint32_t color, uint8_t coverage);

  int width_, height_;
  int shmFd_ = -1;
  uint8_t* pixels_ = nullptr;
  size_t size_ = 0;

  // Clip stack: each entry is {x, y, w, h} in surface pixels.
  struct Clip {
    float x, y, w, h;
  };
  std::vector<Clip> clips_;

  void* ftLibrary_ = nullptr; // FT_Library (void* to keep freetype out of the header)
  void* ftFace_ = nullptr;    // FT_Face regular
  void* ftFaceBold_ = nullptr; // FT_Face bold
  bool fontReady_ = false;

  // Rasterized glyph cache, keyed by (face, pixel size, codepoint).
  // Without it every present re-rasterizes every glyph of every text
  // line (drawText) and re-loads every glyph for measuring
  // (measureTextWidth) — O(total characters) FreeType work per
  // present. That made Terminal typing slow down linearly with
  // scrollback lines under TCG (PR #98: hundreds of ms native per
  // present at 100 lines, seconds under TCG, one present per
  // keystroke), which timed out the M7/M9 QEMU checks. Distinct
  // glyphs are few (ASCII x 2 faces x a handful of sizes), so the
  // cache stays tiny.
  struct Glyph {
    int advance = 0;    // advance.x >> 6, pixels
    int bitmapLeft = 0; // bitmap_left
    int bitmapTop = 0;  // bitmap_top
    int width = 0;      // bitmap.width
    int height = 0;     // bitmap.rows
    std::vector<uint8_t> bitmap; // width*height coverage bytes, row-major
  };
  std::unordered_map<uint64_t, Glyph> glyphCache_;
  // Pixel size last set on each face; FT_Set_Pixel_Sizes runs only
  // when the size changes for that face.
  float glyphSizeRegular_ = -1;
  float glyphSizeBold_ = -1;
  // Rasterized glyph for (codepoint, size, bold), loading it on first
  // use. The returned pointer is valid only until the next glyphFor
  // call (a cache insert may rehash); use it immediately.
  // Returns nullptr only when no font is available.
  const Glyph* glyphFor(uint32_t cp, float size, bool bold);

  struct Image {
    int w = 0, h = 0;
    std::vector<uint8_t> rgba; // 4 bytes/px
  };
  // Decoded image cache, keyed by absolute path.
  std::vector<std::pair<std::string, std::shared_ptr<Image>>> imageCache_;
  std::shared_ptr<Image> loadImage(const std::string& path);
};

} // namespace sevyn
