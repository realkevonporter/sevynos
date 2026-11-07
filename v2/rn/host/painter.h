// SevynOS v2 M2 — CPU raster painter for the RN host.
//
// Paints a flat draw-op list into a shared-memory ARGB8888 buffer that
// the Wayland client attaches to the shell surface. CPU only, by design
// (same as M1's pixman compositor); no GL in v1.
#pragma once

#include <memory>
#include <string>
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

  struct Image {
    int w = 0, h = 0;
    std::vector<uint8_t> rgba; // 4 bytes/px
  };
  // Decoded image cache, keyed by absolute path.
  std::vector<std::pair<std::string, std::shared_ptr<Image>>> imageCache_;
  std::shared_ptr<Image> loadImage(const std::string& path);
};

} // namespace sevyn
