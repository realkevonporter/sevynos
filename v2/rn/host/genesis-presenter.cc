// SevynOS v2 M12 — Genesis: the GPU present path (see genesis-presenter.h).
#include "genesis-presenter.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#ifdef SEVYN_HAVE_EGL
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <wayland-egl.h>
#endif

namespace sevyn {

#ifdef SEVYN_HAVE_EGL

namespace {

// Decode one UTF-8 codepoint. Mirrors painter.cc (file-static there);
// returns bytes consumed (1 on bad input).
size_t utf8DecodeLocal(const std::string& s, size_t i, uint32_t& cp) {
  unsigned char c = static_cast<unsigned char>(s[i]);
  if (c < 0x80) {
    cp = c;
    return 1;
  }
  if ((c & 0xE0) == 0xC0 && i + 1 < s.size()) {
    cp = ((c & 0x1F) << 6) |
        (static_cast<unsigned char>(s[i + 1]) & 0x3F);
    return 2;
  }
  if ((c & 0xF0) == 0xE0 && i + 2 < s.size()) {
    cp = ((c & 0x0F) << 12) |
        ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 6) |
        (static_cast<unsigned char>(s[i + 2]) & 0x3F);
    return 3;
  }
  if ((c & 0xF8) == 0xF0 && i + 3 < s.size()) {
    cp = ((c & 0x07) << 18) |
        ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 12) |
        ((static_cast<unsigned char>(s[i + 2]) & 0x3F) << 6) |
        (static_cast<unsigned char>(s[i + 3]) & 0x3F);
    return 4;
  }
  cp = '?';
  return 1;
}

} // namespace

#endif // SEVYN_HAVE_EGL

GenesisPresenter::GenesisPresenter() = default;

GenesisPresenter::~GenesisPresenter() { shutdown(); }

#ifdef SEVYN_HAVE_EGL

namespace {

// Vertex shader, shared by both programs: pixel coords (y-down) +
// UVs, orthographic projection to clip space.
const char* kVertexShader =
    "attribute vec2 a_pos;\n"
    "attribute vec2 a_uv;\n"
    "uniform mat4 u_proj;\n"
    "varying vec2 v_uv;\n"
    "varying vec2 v_pos;\n"
    "void main() {\n"
    "  gl_Position = u_proj * vec4(a_pos, 0.0, 1.0);\n"
    "  v_uv = a_uv;\n"
    "  v_pos = a_pos;\n"
    "}\n";

// Rect fill: solid color, rounded corners via a signed-distance
// function (radius 0 = plain quad, edge AA over ~1.5px).
const char* kRectFragmentShader =
    "precision mediump float;\n"
    "varying vec2 v_uv;\n"
    "varying vec2 v_pos;\n"
    "uniform vec4 u_color;\n"
    "uniform vec4 u_rect;\n"
    "uniform float u_radius;\n"
    "void main() {\n"
    "  vec2 c = u_rect.xy + u_rect.zw * 0.5;\n"
    "  vec2 q = abs(v_pos - c) - (u_rect.zw * 0.5 - vec2(u_radius));\n"
    "  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;\n"
    "  float a = 1.0 - smoothstep(-0.75, 0.75, d);\n"
    "  gl_FragColor = vec4(u_color.rgb, u_color.a * a);\n"
    "}\n";

// Textured quad: mode 0 = glyph coverage (GL_ALPHA atlas, tinted),
// mode 1 = RGBA image.
const char* kTexFragmentShader =
    "precision mediump float;\n"
    "varying vec2 v_uv;\n"
    "varying vec2 v_pos;\n"
    "uniform sampler2D u_tex;\n"
    "uniform vec4 u_tint;\n"
    "uniform float u_mode;\n"
    "void main() {\n"
    "  if (u_mode < 0.5) {\n"
    "    float cov = texture2D(u_tex, v_uv).a;\n"
    "    gl_FragColor = vec4(u_tint.rgb, u_tint.a * cov);\n"
    "  } else {\n"
    "    vec4 tex = texture2D(u_tex, v_uv);\n"
    "    gl_FragColor = vec4(tex.rgb, tex.a);\n"
    "  }\n"
    "}\n";

GLuint compileShader(GLenum type, const char* src, const char* what) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512];
    glGetShaderInfoLog(s, sizeof(log), nullptr, log);
    logLine("GENESIS shader compile failed (%s): %s", what, log);
    glDeleteShader(s);
    return 0;
  }
  return s;
}

GLuint linkProgram(GLuint vs, GLuint fs, const char* what) {
  GLuint p = glCreateProgram();
  glAttachShader(p, vs);
  glAttachShader(p, fs);
  glLinkProgram(p);
  GLint ok = 0;
  glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[512];
    glGetProgramInfoLog(p, sizeof(log), nullptr, log);
    logLine("GENESIS program link failed (%s): %s", what, log);
    glDeleteProgram(p);
    return 0;
  }
  return p;
}

// Orthographic projection, pixel coords (y-down) to clip space,
// column-major for glUniformMatrix4fv (transpose = false).
void ortho(float w, float h, float* m) {
  m[0] = 2.0f / w;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = -2.0f / h;
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = 1;
  m[11] = 0;
  m[12] = -1;
  m[13] = 1;
  m[14] = 0;
  m[15] = 1;
}

void rgba01(uint32_t c, float& r, float& g, float& b, float& a) {
  r = ((c >> 24) & 0xFF) / 255.0f;
  g = ((c >> 16) & 0xFF) / 255.0f;
  b = ((c >> 8) & 0xFF) / 255.0f;
  a = (c & 0xFF) / 255.0f;
}

} // namespace

bool GenesisPresenter::init(wl_display* display, wl_surface* surface,
                            int width, int height) {
  if (ok_)
    return true;
  display_ = display;
  surface_ = surface;
  width_ = width;
  height_ = height;
  EGLDisplay dpy = eglGetDisplay((EGLNativeDisplayType)display);
  if (dpy == EGL_NO_DISPLAY) {
    logLine("GENESIS EGL unavailable: eglGetDisplay failed");
    return false;
  }
  EGLint major = 0, minor = 0;
  if (!eglInitialize(dpy, &major, &minor)) {
    logLine("GENESIS EGL unavailable: eglInitialize failed (0x%x)",
            eglGetError());
    return false;
  }
  static const EGLint kConfigAttribs[] = {
      EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
      EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
      EGL_RED_SIZE, 8,
      EGL_GREEN_SIZE, 8,
      EGL_BLUE_SIZE, 8,
      EGL_ALPHA_SIZE, 8,
      EGL_NONE,
  };
  EGLConfig config = nullptr;
  EGLint nconfigs = 0;
  if (!eglChooseConfig(dpy, kConfigAttribs, &config, 1, &nconfigs) ||
      nconfigs < 1) {
    logLine("GENESIS EGL unavailable: no suitable config (0x%x)",
            eglGetError());
    eglTerminate(dpy);
    return false;
  }
  wl_egl_window* win = wl_egl_window_create(surface, width, height);
  if (!win) {
    logLine("GENESIS EGL unavailable: wl_egl_window_create failed");
    eglTerminate(dpy);
    return false;
  }
  EGLSurface surf = eglCreateWindowSurface(dpy, config, (EGLNativeWindowType)win, nullptr);
  if (surf == EGL_NO_SURFACE) {
    logLine("GENESIS EGL unavailable: eglCreateWindowSurface failed (0x%x)",
            eglGetError());
    wl_egl_window_destroy(win);
    eglTerminate(dpy);
    return false;
  }
  if (!eglBindAPI(EGL_OPENGL_ES_API)) {
    logLine("GENESIS EGL unavailable: eglBindAPI failed (0x%x)",
            eglGetError());
    eglDestroySurface(dpy, surf);
    wl_egl_window_destroy(win);
    eglTerminate(dpy);
    return false;
  }
  static const EGLint kContextAttribs[] = {EGL_CONTEXT_CLIENT_VERSION, 2,
                                           EGL_NONE};
  EGLContext ctx = eglCreateContext(dpy, config, EGL_NO_CONTEXT, kContextAttribs);
  if (ctx == EGL_NO_CONTEXT) {
    logLine("GENESIS EGL unavailable: eglCreateContext failed (0x%x)",
            eglGetError());
    eglDestroySurface(dpy, surf);
    wl_egl_window_destroy(win);
    eglTerminate(dpy);
    return false;
  }
  if (!eglMakeCurrent(dpy, surf, surf, ctx)) {
    logLine("GENESIS EGL unavailable: eglMakeCurrent failed (0x%x)",
            eglGetError());
    eglDestroyContext(dpy, ctx);
    eglDestroySurface(dpy, surf);
    wl_egl_window_destroy(win);
    eglTerminate(dpy);
    return false;
  }
  eglSwapInterval(dpy, 1);
  eglDisplay_ = (void*)dpy;
  eglSurface_ = (void*)surf;
  eglContext_ = (void*)ctx;
  eglWindow_ = (void*)win;
  const char* renderer = (const char*)glGetString(GL_RENDERER);
  const char* version = (const char*)glGetString(GL_VERSION);
  renderer_ = renderer ? renderer : "?";
  std::string eglVersion = eglQueryString(dpy, EGL_VERSION);
  logLine("GENESIS EGL renderer=%s version=%s egl=%s", renderer_.c_str(),
          version ? version : "?", eglVersion.c_str());
  if (!initGl()) {
    shutdown();
    return false;
  }
  ok_ = true;
  logLine("GENESIS present path=gpu %dx%d", width_, height_);
  return true;
}

bool GenesisPresenter::initGl() {
  GLuint vs = compileShader(GL_VERTEX_SHADER, kVertexShader, "vertex");
  if (!vs)
    return false;
  GLuint fsRect =
      compileShader(GL_FRAGMENT_SHADER, kRectFragmentShader, "rect");
  if (!fsRect) {
    glDeleteShader(vs);
    return false;
  }
  GLuint fsTex = compileShader(GL_FRAGMENT_SHADER, kTexFragmentShader, "tex");
  if (!fsTex) {
    glDeleteShader(vs);
    glDeleteShader(fsRect);
    return false;
  }
  progRect_ = linkProgram(vs, fsRect, "rect");
  progTex_ = linkProgram(vs, fsTex, "tex");
  glDeleteShader(vs);
  glDeleteShader(fsRect);
  glDeleteShader(fsTex);
  if (!progRect_ || !progTex_)
    return false;
  rectProj_ = glGetUniformLocation(progRect_, "u_proj");
  rectColor_ = glGetUniformLocation(progRect_, "u_color");
  rectRect_ = glGetUniformLocation(progRect_, "u_rect");
  rectRadius_ = glGetUniformLocation(progRect_, "u_radius");
  rectPos_ = glGetAttribLocation(progRect_, "a_pos");
  texProj_ = glGetUniformLocation(progTex_, "u_proj");
  texTint_ = glGetUniformLocation(progTex_, "u_tint");
  texMode_ = glGetUniformLocation(progTex_, "u_mode");
  texPos_ = glGetAttribLocation(progTex_, "a_pos");
  texUv_ = glGetAttribLocation(progTex_, "a_uv");
  glGenBuffers(1, &vbo_);
  // Glyph atlas: one GL_ALPHA texture, coverage bytes.
  glGenTextures(1, &atlasTex_);
  glBindTexture(GL_TEXTURE_2D, atlasTex_);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_ALPHA, kAtlasSize, kAtlasSize, 0,
               GL_ALPHA, GL_UNSIGNED_BYTE, nullptr);
  glBindTexture(GL_TEXTURE_2D, 0);
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  glDisable(GL_SCISSOR_TEST);
  glViewport(0, 0, width_, height_);
  return glGetError() == GL_NO_ERROR;
}

void GenesisPresenter::shutdown() {
  if (!eglDisplay_ && !eglSurface_ && !eglContext_ && !eglWindow_ &&
      progRect_ == 0 && progTex_ == 0)
    return;
  clearImageTextures();
  if (atlasTex_) {
    glDeleteTextures(1, &atlasTex_);
    atlasTex_ = 0;
  }
  atlas_.clear();
  if (vbo_) {
    glDeleteBuffers(1, &vbo_);
    vbo_ = 0;
  }
  if (progRect_) {
    glDeleteProgram(progRect_);
    progRect_ = 0;
  }
  if (progTex_) {
    glDeleteProgram(progTex_);
    progTex_ = 0;
  }
  EGLDisplay dpy = (EGLDisplay)eglDisplay_;
  if (dpy != EGL_NO_DISPLAY && dpy) {
    eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (eglSurface_) {
      eglDestroySurface(dpy, (EGLSurface)eglSurface_);
      eglSurface_ = nullptr;
    }
    if (eglContext_) {
      eglDestroyContext(dpy, (EGLContext)eglContext_);
      eglContext_ = nullptr;
    }
    eglTerminate(dpy);
    eglDisplay_ = nullptr;
  }
  if (eglWindow_) {
    wl_egl_window_destroy((wl_egl_window*)eglWindow_);
    eglWindow_ = nullptr;
  }
  display_ = nullptr;
  surface_ = nullptr;
  ok_ = false;
}

void GenesisPresenter::resize(int width, int height) {
  if (!ok_ || (width == width_ && height == height_))
    return;
  width_ = width;
  height_ = height;
  wl_egl_window_resize((wl_egl_window*)eglWindow_, width, height, 0, 0);
  glViewport(0, 0, width_, height_);
}

void GenesisPresenter::clearAtlas() {
  atlas_.clear();
  atlasX_ = 0;
  atlasY_ = 0;
  atlasRowH_ = 0;
  glBindTexture(GL_TEXTURE_2D, atlasTex_);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_ALPHA, kAtlasSize, kAtlasSize, 0,
               GL_ALPHA, GL_UNSIGNED_BYTE, nullptr);
  glBindTexture(GL_TEXTURE_2D, 0);
}

bool GenesisPresenter::atlasGlyph(uint32_t cp, float size, bool bold,
                                 Painter& textSource, float& u0, float& v0,
                                 float& u1, float& v1, int& w, int& h,
                                 int& bitmapLeft, int& bitmapTop,
                                 int& advance) {
  uint64_t key = ((uint64_t)(bold ? 1 : 0) << 56) |
      ((uint64_t)(uint32_t)ceilf(size) << 32) | cp;
  for (auto& e : atlas_) {
    if (e.first == key) {
      const AtlasEntry& a = e.second;
      u0 = a.u0;
      v0 = a.v0;
      u1 = a.u1;
      v1 = a.v1;
      w = a.w;
      h = a.h;
      bitmapLeft = a.bitmapLeft;
      bitmapTop = a.bitmapTop;
      advance = a.advance;
      return true;
    }
  }
  const Painter::GlyphBitmap* g = textSource.glyphBitmap(cp, size, bold);
  if (!g)
    return false;
  advance = g->advance;
  bitmapLeft = g->bitmapLeft;
  bitmapTop = g->bitmapTop;
  w = g->width;
  h = g->height;
  if (w <= 0 || h <= 0) {
    // Space / empty glyph: no pixels, but the advance still applies.
    u0 = v0 = u1 = v1 = 0;
    return true;
  }
  if (w + 1 > kAtlasSize || h + 1 > kAtlasSize)
    return false; // Absurdly large glyph; skip it.
  if (atlasX_ + w + 1 > kAtlasSize) {
    atlasX_ = 0;
    atlasY_ += atlasRowH_ + 1;
    atlasRowH_ = 0;
  }
  if (atlasY_ + h + 1 > kAtlasSize) {
    // Atlas full: clear and retry once from the top.
    clearAtlas();
    if (atlasX_ + w + 1 > kAtlasSize || atlasY_ + h + 1 > kAtlasSize)
      return false;
  }
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glBindTexture(GL_TEXTURE_2D, atlasTex_);
  glTexSubImage2D(GL_TEXTURE_2D, 0, atlasX_, atlasY_, w, h, GL_ALPHA,
                  GL_UNSIGNED_BYTE, g->bitmap);
  glBindTexture(GL_TEXTURE_2D, 0);
  AtlasEntry a;
  a.u0 = (float)atlasX_ / kAtlasSize;
  a.v0 = (float)atlasY_ / kAtlasSize;
  a.u1 = (float)(atlasX_ + w) / kAtlasSize;
  a.v1 = (float)(atlasY_ + h) / kAtlasSize;
  a.w = w;
  a.h = h;
  a.bitmapLeft = bitmapLeft;
  a.bitmapTop = bitmapTop;
  a.advance = advance;
  atlas_.push_back({key, a});
  u0 = a.u0;
  v0 = a.v0;
  u1 = a.u1;
  v1 = a.v1;
  atlasX_ += w + 1;
  atlasRowH_ = std::max(atlasRowH_, h);
  return true;
}

void GenesisPresenter::clearImageTextures() {
  for (auto& it : images_)
    glDeleteTextures(1, &it.tex);
  images_.clear();
}

uint32_t GenesisPresenter::imageTexture(const std::string& path,
                                       Painter& textSource, int& w, int& h) {
  for (auto& it : images_) {
    if (it.path == path) {
      w = it.w;
      h = it.h;
      return it.tex;
    }
  }
  const Painter::ImagePixels* img = textSource.imagePixels(path);
  if (!img || img->w <= 0 || img->h <= 0)
    return 0;
  if (images_.size() >= 64)
    clearImageTextures();
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_2D, tex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, img->w, img->h, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, img->rgba);
  glBindTexture(GL_TEXTURE_2D, 0);
  images_.push_back({path, tex, img->w, img->h});
  w = img->w;
  h = img->h;
  return tex;
}

void GenesisPresenter::applyClip() {
  if (clips_.empty()) {
    glDisable(GL_SCISSOR_TEST);
    return;
  }
  const Clip& c = clips_.back();
  int x0 = (int)floorf(c.x);
  int y0 = (int)floorf(c.y);
  int x1 = (int)ceilf(c.x + c.w);
  int y1 = (int)ceilf(c.y + c.h);
  x0 = std::max(0, x0);
  y0 = std::max(0, y0);
  x1 = std::min(width_, x1);
  y1 = std::min(height_, y1);
  glEnable(GL_SCISSOR_TEST);
  // GL's origin is bottom-left; the clip stack is y-down.
  glScissor(x0, height_ - y1, std::max(0, x1 - x0), std::max(0, y1 - y0));
}

void GenesisPresenter::drawQuad(float x0, float y0, float x1, float y1,
                               float u0, float v0, float u1, float v1) {
  float verts[16] = {x0, y0, u0, v0, x1, y0, u1, v0,
                     x0, y1, u0, v1, x1, y1, u1, v1};
  glBindBuffer(GL_ARRAY_BUFFER, vbo_);
  glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STREAM_DRAW);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

bool GenesisPresenter::present(const std::vector<DrawOp>& ops, uint32_t bg,
                              Painter& textSource) {
  if (!ok_)
    return false;
  float r = 0, g = 0, b = 0, a = 0;
  rgba01(bg, r, g, b, a);
  glViewport(0, 0, width_, height_);
  glClearColor(r, g, b, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  float proj[16];
  ortho((float)width_, (float)height_, proj);
  clips_.clear();
  applyClip();
  for (const DrawOp& op : ops) {
    switch (op.kind) {
      case DrawOp::Kind::Rect: {
        glUseProgram(progRect_);
        glUniformMatrix4fv(rectProj_, 1, GL_FALSE, proj);
        float cr = 0, cg = 0, cb = 0, ca = 0;
        rgba01(op.color, cr, cg, cb, ca);
        glUniform4f(rectColor_, cr, cg, cb, ca);
        glUniform4f(rectRect_, op.x, op.y, op.w, op.h);
        glUniform1f(rectRadius_, op.radius);
        applyClip();
        glBindBuffer(GL_ARRAY_BUFFER, vbo_);
        glEnableVertexAttribArray((GLuint)rectPos_);
        glVertexAttribPointer((GLuint)rectPos_, 2, GL_FLOAT, GL_FALSE,
                              4 * sizeof(float), (void*)0);
        drawQuad(op.x, op.y, op.x + op.w, op.y + op.h, 0, 0, 1, 1);
        glDisableVertexAttribArray((GLuint)rectPos_);
        break;
      }
      case DrawOp::Kind::Text: {
        // Same layout math as Painter::drawText (split on \n, line
        // height 1.25em, baseline = y + line*lineH + fontSize, align
        // within (x, w)) so GPU text lands on the same pixels.
        float lineH = op.fontSize * 1.25f;
        size_t start = 0;
        size_t li = 0;
        for (size_t i = 0; i <= op.text.size(); i++) {
          if (i != op.text.size() && op.text[i] != '\n')
            continue;
          std::string line = op.text.substr(start, i - start);
          start = i + 1;
          float lw =
              textSource.measureTextWidth(line, op.fontSize, op.fontBold);
          float lx = op.x;
          if (op.align == 1)
            lx = op.x + (op.w - lw) / 2;
          else if (op.align == 2)
            lx = op.x + op.w - lw;
          float baseline = op.y + (float)li * lineH + op.fontSize;
          float penX = lx;
          float cr = 0, cg = 0, cb = 0, ca = 0;
          rgba01(op.color, cr, cg, cb, ca);
          size_t j = 0;
          while (j < line.size()) {
            uint32_t cp = 0;
            j += utf8DecodeLocal(line, j, cp);
            float u0 = 0, v0 = 0, u1 = 0, v1 = 0;
            int gw = 0, gh = 0, bl = 0, bt = 0, adv = 0;
            if (!atlasGlyph(cp, op.fontSize, op.fontBold, textSource, u0,
                            v0, u1, v1, gw, gh, bl, bt, adv))
              continue;
            if (gw > 0 && gh > 0) {
              float gx = floorf(penX) + (float)bl;
              float gy = floorf(baseline) - (float)bt;
              glUseProgram(progTex_);
              glUniformMatrix4fv(texProj_, 1, GL_FALSE, proj);
              glUniform4f(texTint_, cr, cg, cb, ca);
              glUniform1f(texMode_, 0.0f);
              glActiveTexture(GL_TEXTURE0);
              glBindTexture(GL_TEXTURE_2D, atlasTex_);
              applyClip();
              glBindBuffer(GL_ARRAY_BUFFER, vbo_);
              glEnableVertexAttribArray((GLuint)texPos_);
              glVertexAttribPointer((GLuint)texPos_, 2, GL_FLOAT, GL_FALSE,
                                    4 * sizeof(float), (void*)0);
              glEnableVertexAttribArray((GLuint)texUv_);
              glVertexAttribPointer((GLuint)texUv_, 2, GL_FLOAT, GL_FALSE,
                                    4 * sizeof(float),
                                    (void*)(2 * sizeof(float)));
              drawQuad(gx, gy, gx + (float)gw, gy + (float)gh, u0, v0, u1,
                       v1);
              glDisableVertexAttribArray((GLuint)texPos_);
              glDisableVertexAttribArray((GLuint)texUv_);
            }
            penX += (float)adv;
          }
          li++;
        }
        break;
      }
      case DrawOp::Kind::Image: {
        int iw = 0, ih = 0;
        uint32_t tex = imageTexture(op.asset, textSource, iw, ih);
        if (!tex)
          break;
        glUseProgram(progTex_);
        glUniformMatrix4fv(texProj_, 1, GL_FALSE, proj);
        glUniform4f(texTint_, 1, 1, 1, 1);
        glUniform1f(texMode_, 1.0f);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, tex);
        applyClip();
        glBindBuffer(GL_ARRAY_BUFFER, vbo_);
        glEnableVertexAttribArray((GLuint)texPos_);
        glVertexAttribPointer((GLuint)texPos_, 2, GL_FLOAT, GL_FALSE,
                              4 * sizeof(float), (void*)0);
        glEnableVertexAttribArray((GLuint)texUv_);
        glVertexAttribPointer((GLuint)texUv_, 2, GL_FLOAT, GL_FALSE,
                              4 * sizeof(float), (void*)(2 * sizeof(float)));
        drawQuad(op.x, op.y, op.x + op.w, op.y + op.h, 0, 0, 1, 1);
        glDisableVertexAttribArray((GLuint)texPos_);
        glDisableVertexAttribArray((GLuint)texUv_);
        break;
      }
      case DrawOp::Kind::PushClip: {
        Clip c{op.x, op.y, op.w, op.h};
        if (!clips_.empty()) {
          const Clip& t = clips_.back();
          float x0 = std::max(c.x, t.x), y0 = std::max(c.y, t.y);
          float x1 = std::min(c.x + c.w, t.x + t.w);
          float y1 = std::min(c.y + c.h, t.y + t.h);
          c = {x0, y0, std::max(0.0f, x1 - x0), std::max(0.0f, y1 - y0)};
        }
        clips_.push_back(c);
        applyClip();
        break;
      }
      case DrawOp::Kind::PopClip: {
        if (!clips_.empty())
          clips_.pop_back();
        applyClip();
        break;
      }
    }
  }
  glUseProgram(0);
  glBindTexture(GL_TEXTURE_2D, 0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  EGLDisplay dpy = (EGLDisplay)eglDisplay_;
  EGLSurface surf = (EGLSurface)eglSurface_;
  if (!eglSwapBuffers(dpy, surf)) {
    logLine("GENESIS eglSwapBuffers failed (0x%x)", eglGetError());
    return false;
  }
  GLenum err = glGetError();
  if (err != GL_NO_ERROR) {
    logLine("GENESIS GL error after present: 0x%x", err);
    return false;
  }
  presents_++;
  long long now = nowMs();
  if (fpsWindowStartMs_ == 0)
    fpsWindowStartMs_ = now;
  fpsWindowPresents_++;
  if (presents_ == 1)
    logLine("GENESIS first present %dx%d", width_, height_);
  // Log a frame-rate sample every 10 presents, or 30 s after the
  // first present in the window — whichever comes first. The shell
  // presents on state changes, not on a timer, so a count-only
  // window might never fill on an idle desktop; the time bound
  // guarantees the check sees a sample whenever frames flow at all.
  // The number is a liveness signal under TCG/llvmpipe, never a bar:
  // only the GF65 proves 60 fps.
  if (fpsWindowPresents_ >= 10 ||
      (fpsWindowPresents_ >= 1 && now - fpsWindowStartMs_ >= 30000)) {
    long long dt = now - fpsWindowStartMs_;
    if (dt > 0)
      fps_ = (double)fpsWindowPresents_ * 1000.0 / (double)dt;
    logLine("GENESIS fps %.1f (presents=%lld)", fps_, presents_);
    fpsWindowStartMs_ = now;
    fpsWindowPresents_ = 0;
  }
  return true;
}

#else // !SEVYN_HAVE_EGL

// Stub build (no EGL headers on the build host): Genesis is never
// available, so every host keeps the CPU painter. The M12 builder
// defines SEVYN_HAVE_EGL; the other image builders do not, and must
// keep linking — which is why this stub exists instead of an #ifdef
// at the Wayland call site.
bool GenesisPresenter::init(wl_display*, wl_surface*, int, int) {
  return false;
}

void GenesisPresenter::resize(int, int) {}

void GenesisPresenter::shutdown() {}

bool GenesisPresenter::present(const std::vector<DrawOp>&, uint32_t,
                              Painter&) {
  return false;
}

#endif // SEVYN_HAVE_EGL

} // namespace sevyn
