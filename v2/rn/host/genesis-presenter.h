// SevynOS v2 M12 — Genesis: the GPU present path for the RN host.
//
// The host renders the same DrawOp list two ways: the CPU Painter
// (raster into a SHM buffer, unchanged since M2) and — when EGL is
// available — this presenter, which draws the ops as GLES2 quads into
// an EGL window surface on the host's wl_surface. Text still rasterizes
// on the CPU (FreeType, once, into the painter's glyph cache); the
// presenter uploads each glyph bitmap to a texture atlas and draws
// textured quads, so font rendering stays pixel-identical and only the
// compositing moves to the GPU. Images upload once per path to GL
// textures. Rounded rects are a signed-distance function in the rect
// shader. Clips become glScissor rects, intersected the same way the
// CPU painter intersects them.
//
// Compiled only when SEVYN_HAVE_EGL is defined (the image builder
// defines it when pkg-config finds egl + glesv2 + wayland-egl). Without
// it this is a stub whose init() always returns false, so every other
// image builder keeps linking and the CPU path is the only path.
// Any EGL failure at runtime (no GPU, no DRI driver, headless) also
// returns false and the host keeps the CPU painter for the life of the
// process — a GPU failure can never brick the desktop.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <wayland-client.h>

#include "common.h"
#include "painter.h"

namespace sevyn {

class GenesisPresenter {
 public:
  GenesisPresenter();
  ~GenesisPresenter();

  GenesisPresenter(const GenesisPresenter&) = delete;
  GenesisPresenter& operator=(const GenesisPresenter&) = delete;

  // Create the EGL context + window surface on the given wl_surface.
  // Logs the EGL renderer string on success, the failing step on
  // failure. False = unavailable; the caller falls back to the CPU
  // painter and must not call present().
  bool init(wl_display* display, wl_surface* surface, int width,
            int height);
  bool ok() const { return ok_; }
  // Resize the EGL window surface + viewport (Wayland resize/remap).
  void resize(int width, int height);
  // Destroy the EGL surface/context (Wayland remap destroys the
  // wl_surface; a later present re-inits on the new one).
  void shutdown();

  // Render one frame: clear to bg, draw ops, eglSwapBuffers.
  // Returns false if the GL context is lost — the caller must fall
  // back to the CPU painter permanently.
  bool present(const std::vector<DrawOp>& ops, uint32_t bg,
               Painter& textSource);

  const std::string& renderer() const { return renderer_; }
  long long presents() const { return presents_; }
  // Rolling frames-per-second over the last sample window (10
  // presents, or 30 s — whichever comes first). Only meaningful on
  // hardware — under TCG/llvmpipe it is a liveness signal, never a bar.
  double fps() const { return fps_; }

 private:
  bool initGl();
  // Upload one glyph bitmap into the atlas; returns its UV rect, or
  // false when the atlas is full (the caller clears it and retries
  // once).
  bool atlasGlyph(uint32_t cp, float size, bool bold, Painter& textSource,
                  float& u0, float& v0, float& u1, float& v1, int& w, int& h,
                  int& bitmapLeft, int& bitmapTop, int& advance);
  void clearAtlas();
  // GL texture for an image path (uploads on first use).
  uint32_t imageTexture(const std::string& path, Painter& textSource,
                        int& w, int& h);
  void clearImageTextures();
  void drawQuad(float x0, float y0, float x1, float y1, float u0, float v0,
                float u1, float v1);
  void applyClip();

  bool ok_ = false;
  wl_display* display_ = nullptr;
  wl_surface* surface_ = nullptr;
  int width_ = 0, height_ = 0;
  std::string renderer_;

  // EGL/GL handles are void* so this header needs no EGL headers —
  // the .cc includes them only under SEVYN_HAVE_EGL.
  void* eglDisplay_ = nullptr;
  void* eglSurface_ = nullptr;
  void* eglContext_ = nullptr;
  void* eglWindow_ = nullptr;
  uint32_t progRect_ = 0;
  uint32_t progTex_ = 0;
  uint32_t vbo_ = 0;
  // Uniform/attribute locations, -1 until the programs compile.
  int rectProj_ = -1, rectColor_ = -1, rectRect_ = -1, rectRadius_ = -1;
  int rectPos_ = -1;
  int texProj_ = -1, texTint_ = -1, texMode_ = -1;
  int texPos_ = -1, texUv_ = -1;

  // Glyph atlas (GL_ALPHA, one byte per texel = coverage).
  static constexpr int kAtlasSize = 1024;
  uint32_t atlasTex_ = 0;
  int atlasX_ = 0, atlasY_ = 0, atlasRowH_ = 0;
  struct AtlasEntry {
    float u0, v0, u1, v1;
    int w, h, bitmapLeft, bitmapTop, advance;
  };
  // Key: (bold << 56) | (ceil(size) << 32) | codepoint — same key
  // shape as Painter::glyphFor, so the two caches agree.
  std::vector<std::pair<uint64_t, AtlasEntry>> atlas_;
  // Image textures, keyed by absolute path.
  struct ImageTex {
    std::string path;
    uint32_t tex = 0;
    int w = 0, h = 0;
  };
  std::vector<ImageTex> images_;

  // Clip stack (surface pixels, y-down), intersected on push.
  struct Clip {
    float x, y, w, h;
  };
  std::vector<Clip> clips_;

  long long presents_ = 0;
  long long fpsWindowStartMs_ = 0;
  long long fpsWindowPresents_ = 0;
  double fps_ = 0;
  bool fpsLogged_ = false;
};

} // namespace sevyn
