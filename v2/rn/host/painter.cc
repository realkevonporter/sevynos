// SevynOS v2 M2 — CPU raster painter (see painter.h).
#include "painter.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <ft2build.h>
#include FT_FREETYPE_H
#include <png.h>

namespace sevyn {

namespace {

// DejaVu ships in the M1 image (fonts-dejavu-core, staged by
// build-m1-image.sh). Same paths in the M2 image.
const char* kFontRegular = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const char* kFontBold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Decode one UTF-8 codepoint. Returns bytes consumed (1 on bad input).
size_t utf8Decode(const std::string& s, size_t i, uint32_t& cp) {
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

Painter::Painter(int width, int height) : width_(width), height_(height) {
  size_ = (size_t)stride() * (size_t)height_;
  shmFd_ = memfd_create("sevyn-shell-surface", MFD_CLOEXEC);
  if (shmFd_ < 0) {
    logLine("PAINTER memfd_create failed (%s)", strerror(errno));
    return;
  }
  if (ftruncate(shmFd_, (off_t)size_) != 0) {
    logLine("PAINTER ftruncate failed (%s)", strerror(errno));
    close(shmFd_);
    shmFd_ = -1;
    return;
  }
  pixels_ = static_cast<uint8_t*>(
      mmap(nullptr, size_, PROT_READ | PROT_WRITE, MAP_SHARED, shmFd_, 0));
  if (pixels_ == MAP_FAILED) {
    logLine("PAINTER mmap failed (%s)", strerror(errno));
    pixels_ = nullptr;
    close(shmFd_);
    shmFd_ = -1;
    return;
  }
  FT_Library lib = nullptr;
  if (FT_Init_FreeType(&lib) == 0) {
    ftLibrary_ = lib;
    FT_Face face = nullptr;
    if (FT_New_Face(lib, kFontRegular, 0, &face) == 0)
      ftFace_ = face;
    FT_Face bold = nullptr;
    if (FT_New_Face(lib, kFontBold, 0, &bold) == 0)
      ftFaceBold_ = bold;
    fontReady_ = ftFace_ != nullptr;
    if (!fontReady_)
      logLine("PAINTER no usable font (regular face failed to load)");
  } else {
    logLine("PAINTER FreeType init failed");
  }
}

Painter::~Painter() {
  if (ftFaceBold_)
    FT_Done_Face(static_cast<FT_Face>(ftFaceBold_));
  if (ftFace_)
    FT_Done_Face(static_cast<FT_Face>(ftFace_));
  if (ftLibrary_)
    FT_Done_FreeType(static_cast<FT_Library>(ftLibrary_));
  if (pixels_)
    munmap(pixels_, size_);
  if (shmFd_ >= 0)
    close(shmFd_);
}

void Painter::blendPixel(int px, int py, uint32_t color, uint8_t coverage) {
  if (px < 0 || py < 0 || px >= width_ || py >= height_ || !pixels_)
    return;
  if (!clips_.empty()) {
    const Clip& c = clips_.back();
    if (px < c.x || py < c.y || px >= c.x + c.w || py >= c.y + c.h)
      return;
  }
  uint8_t ca = (uint8_t)(color & 0xff);
  uint32_t eff = (uint32_t)ca * coverage / 255;
  if (eff == 0)
    return;
  uint32_t* dst = reinterpret_cast<uint32_t*>(pixels_ + (size_t)py * stride() +
                                               (size_t)px * 4);
  uint8_t sr = (uint8_t)((color >> 24) & 0xff);
  uint8_t sg = (uint8_t)((color >> 16) & 0xff);
  uint8_t sb = (uint8_t)((color >> 8) & 0xff);
  if (eff == 255) {
    *dst = ((uint32_t)sr << 16) | ((uint32_t)sg << 8) | sb;
    return;
  }
  uint32_t cur = *dst;
  uint8_t dr = (uint8_t)((cur >> 16) & 0xff);
  uint8_t dg = (uint8_t)((cur >> 8) & 0xff);
  uint8_t db = (uint8_t)(cur & 0xff);
  uint8_t r = (uint8_t)((sr * eff + dr * (255 - eff)) / 255);
  uint8_t g = (uint8_t)((sg * eff + dg * (255 - eff)) / 255);
  uint8_t b = (uint8_t)((sb * eff + db * (255 - eff)) / 255);
  *dst = ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

void Painter::fillRect(float fx, float fy, float fw, float fh, uint32_t color,
                       float radius) {
  if (fw <= 0 || fh <= 0 || !pixels_)
    return;
  int x0 = std::max(0, (int)floorf(fx));
  int y0 = std::max(0, (int)floorf(fy));
  int x1 = std::min(width_, (int)ceilf(fx + fw));
  int y1 = std::min(height_, (int)ceilf(fy + fh));
  if (radius <= 0) {
    for (int y = y0; y < y1; y++)
      for (int x = x0; x < x1; x++)
        blendPixel(x, y, color, 255);
    return;
  }
  float cx = fx + fw / 2, cy = fy + fh / 2;
  float rx = fw / 2 - radius, ry = fh / 2 - radius;
  for (int y = y0; y < y1; y++) {
    for (int x = x0; x < x1; x++) {
      float px = x + 0.5f, py = y + 0.5f;
      float dx = std::max(std::fabs(px - cx) - rx, 0.0f);
      float dy = std::max(std::fabs(py - cy) - ry, 0.0f);
      float d = sqrtf(dx * dx + dy * dy) - radius;
      if (d >= 0.5f)
        continue;
      uint8_t cov = d <= -0.5f ? 255 : (uint8_t)((0.5f - d) * 255.0f);
      blendPixel(x, y, color, cov);
    }
  }
}

void Painter::beginFrame(uint32_t bg) {
  clips_.clear();
  if (!pixels_)
    return;
  uint8_t r = (uint8_t)((bg >> 24) & 0xff);
  uint8_t g = (uint8_t)((bg >> 16) & 0xff);
  uint8_t b = (uint8_t)((bg >> 8) & 0xff);
  uint32_t px = ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
  for (int y = 0; y < height_; y++) {
    uint32_t* row =
        reinterpret_cast<uint32_t*>(pixels_ + (size_t)y * stride());
    for (int x = 0; x < width_; x++)
      row[x] = px;
  }
}

float Painter::measureTextWidth(const std::string& text, float size,
                                bool bold) {
  FT_Face face = static_cast<FT_Face>(bold ? ftFaceBold_ : ftFace_);
  if (!face)
    face = static_cast<FT_Face>(ftFace_);
  if (!face)
    return 0;
  FT_Set_Pixel_Sizes(face, 0, (FT_UInt)ceilf(size));
  float w = 0;
  size_t i = 0;
  while (i < text.size()) {
    uint32_t cp = 0;
    i += utf8Decode(text, i, cp);
    if (cp == '\n')
      break;
    if (FT_Load_Char(face, cp, FT_LOAD_DEFAULT) != 0)
      continue;
    w += (float)(face->glyph->advance.x >> 6);
  }
  return w;
}

float Painter::measureTextHeight(const std::string& text, float size,
                                 bool bold, float maxWidth) {
  // One line height, or the wrapped height when maxWidth wraps.
  float lineH = size * 1.25f;
  if (maxWidth <= 0)
    return lineH;
  // Greedy word wrap count.
  float w = 0;
  int lines = 1;
  size_t i = 0;
  std::string word;
  auto flushWord = [&](bool last) {
    float ww = measureTextWidth(word, size, bold);
    if (w > 0 && w + ww > maxWidth) {
      lines++;
      w = ww;
    } else {
      w += ww;
    }
    word.clear();
    (void)last;
  };
  while (i < text.size()) {
    uint32_t cp = 0;
    size_t n = utf8Decode(text, i, cp);
    if (cp == '\n') {
      flushWord(false);
      lines++;
      w = 0;
      i += n;
      continue;
    }
    if (cp == ' ') {
      flushWord(false);
      w += measureTextWidth(" ", size, bold);
      i += n;
      continue;
    }
    word.append(text, i, n);
    i += n;
  }
  flushWord(true);
  return lineH * lines;
}

void Painter::drawText(const DrawOp& op) {
  FT_Face face = static_cast<FT_Face>(op.fontBold ? ftFaceBold_ : ftFace_);
  if (!face)
    face = static_cast<FT_Face>(ftFace_);
  if (!face || !pixels_)
    return;
  FT_Set_Pixel_Sizes(face, 0, (FT_UInt)ceilf(op.fontSize));
  float lineH = op.fontSize * 1.25f;
  // Split into lines on \n.
  std::vector<std::string> lines;
  {
    size_t start = 0;
    for (size_t i = 0; i <= op.text.size(); i++) {
      if (i == op.text.size() || op.text[i] == '\n') {
        lines.push_back(op.text.substr(start, i - start));
        start = i + 1;
      }
    }
  }
  for (size_t li = 0; li < lines.size(); li++) {
    const std::string& line = lines[li];
    float lw = measureTextWidth(line, op.fontSize, op.fontBold);
    float lx = op.x;
    if (op.align == 1)
      lx = op.x + (op.w - lw) / 2;
    else if (op.align == 2)
      lx = op.x + op.w - lw;
    float baseline = op.y + li * lineH + op.fontSize; // approx ascent
    float penX = lx;
    size_t i = 0;
    while (i < line.size()) {
      uint32_t cp = 0;
      i += utf8Decode(line, i, cp);
      if (FT_Load_Char(face, cp, FT_LOAD_RENDER) != 0)
        continue;
      FT_GlyphSlot g = face->glyph;
      FT_Bitmap& bm = g->bitmap;
      int gx = (int)floorf(penX) + g->bitmap_left;
      int gy = (int)floorf(baseline) - g->bitmap_top;
      for (unsigned row = 0; row < bm.rows; row++) {
        for (unsigned col = 0; col < bm.width; col++) {
          uint8_t cov = bm.buffer[row * bm.pitch + col];
          if (cov)
            blendPixel(gx + (int)col, gy + (int)row, op.color, cov);
        }
      }
      penX += (float)(g->advance.x >> 6);
    }
  }
}

std::shared_ptr<Painter::Image> Painter::loadImage(const std::string& path) {
  for (auto& e : imageCache_)
    if (e.first == path)
      return e.second;
  auto img = std::make_shared<Image>();
  FILE* fp = fopen(path.c_str(), "rb");
  if (!fp)
    return nullptr;
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr,
                                           nullptr, nullptr);
  if (!png) {
    fclose(fp);
    return nullptr;
  }
  png_infop info = png_create_info_struct(png);
  if (!info) {
    png_destroy_read_struct(&png, nullptr, nullptr);
    fclose(fp);
    return nullptr;
  }
  if (setjmp(png_jmpbuf(png))) {
    png_destroy_read_struct(&png, &info, nullptr);
    fclose(fp);
    return nullptr;
  }
  png_init_io(png, fp);
  png_read_info(png, info);
  png_set_expand(png);
  png_set_strip_16(png);
  png_set_gray_to_rgb(png);
  png_set_add_alpha(png, 0xff, PNG_FILLER_AFTER);
  png_read_update_info(png, info);
  img->w = (int)png_get_image_width(png, info);
  img->h = (int)png_get_image_height(png, info);
  img->rgba.resize((size_t)img->w * img->h * 4);
  std::vector<png_bytep> rows(img->h);
  for (int y = 0; y < img->h; y++)
    rows[y] = img->rgba.data() + (size_t)y * img->w * 4;
  png_read_image(png, rows.data());
  png_destroy_read_struct(&png, &info, nullptr);
  fclose(fp);
  imageCache_.push_back({path, img});
  return img;
}

void Painter::drawImage(const DrawOp& op) {
  auto img = loadImage(op.asset);
  if (!img || img->w <= 0 || img->h <= 0 || !pixels_)
    return;
  int x0 = std::max(0, (int)floorf(op.x));
  int y0 = std::max(0, (int)floorf(op.y));
  int x1 = std::min(width_, (int)ceilf(op.x + op.w));
  int y1 = std::min(height_, (int)ceilf(op.y + op.h));
  for (int y = y0; y < y1; y++) {
    for (int x = x0; x < x1; x++) {
      float sx = (x + 0.5f - op.x) / op.w * img->w - 0.5f;
      float sy = (y + 0.5f - op.y) / op.h * img->h - 0.5f;
      int ix = std::min(std::max((int)floorf(sx), 0), img->w - 1);
      int iy = std::min(std::max((int)floorf(sy), 0), img->h - 1);
      const uint8_t* px =
          img->rgba.data() + ((size_t)iy * img->w + ix) * 4;
      uint32_t color = ((uint32_t)px[0] << 24) | ((uint32_t)px[1] << 16) |
          ((uint32_t)px[2] << 8) | px[3];
      blendPixel(x, y, color, 255);
    }
  }
}

void Painter::paint(const std::vector<DrawOp>& ops) {
  if (!pixels_)
    return;
  for (const auto& op : ops) {
    switch (op.kind) {
      case DrawOp::Kind::Rect:
        fillRect(op.x, op.y, op.w, op.h, op.color, op.radius);
        break;
      case DrawOp::Kind::Text:
        drawText(op);
        break;
      case DrawOp::Kind::Image:
        drawImage(op);
        break;
      case DrawOp::Kind::PushClip: {
        Clip c{op.x, op.y, op.w, op.h};
        if (!clips_.empty()) {
          // Intersect with the current clip so nesting composes.
          const Clip& t = clips_.back();
          float x0 = std::max(c.x, t.x), y0 = std::max(c.y, t.y);
          float x1 = std::min(c.x + c.w, t.x + t.w);
          float y1 = std::min(c.y + c.h, t.y + t.h);
          c = {x0, y0, std::max(0.0f, x1 - x0), std::max(0.0f, y1 - y0)};
        }
        clips_.push_back(c);
        break;
      }
      case DrawOp::Kind::PopClip:
        if (!clips_.empty())
          clips_.pop_back();
        break;
    }
  }
}

} // namespace sevyn
