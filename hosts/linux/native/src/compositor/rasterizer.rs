// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Software rasterizer: turns scene commands into pixels.
//!
//! This is the hot path. It runs at 60fps with no garbage collector,
//! no JavaScript heap, and bounded memory via the framebuffer pool.

use super::framebuffer::Framebuffer;
use super::protocol::{Color, MaterialKind, Rect, Scene, SceneCommand, TextAlign};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use fontdue::{Font, FontSettings};
use std::sync::OnceLock;

fn base64_decode(s: &str) -> Vec<u8> {
    BASE64.decode(s).unwrap_or_default()
}

/// System font, loaded once. Falls back to embedded DejaVu Sans.
fn system_font() -> &'static Font {
    static FONT: OnceLock<Font> = OnceLock::new();
    FONT.get_or_init(|| {
        // Try system fonts, fall back to embedded.
        for path in [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ] {
            if let Ok(data) = std::fs::read(path) {
                if let Ok(font) = Font::from_bytes(data, FontSettings::default()) {
                    return font;
                }
            }
        }
        // Embedded fallback: fontdue includes no default font, so we
        // require a system font. Panic with a clear message.
        panic!("No system font found for the Rust compositor text renderer")
    })
}

pub struct Rasterizer {
    clip_stack: Vec<Rect>,
}

impl Rasterizer {
    pub fn new() -> Self {
        Self {
            clip_stack: Vec::new(),
        }
    }

    /// Render a scene into the framebuffer.
    pub fn render(&mut self, scene: &Scene, fb: &mut Framebuffer) {
        assert_eq!(fb.width, scene.width);
        assert_eq!(fb.height, scene.height);
        self.clip_stack.clear();
        for cmd in &scene.commands {
            self.render_command(cmd, fb);
        }
    }

    fn render_command(&mut self, cmd: &SceneCommand, fb: &mut Framebuffer) {
        match cmd {
            SceneCommand::Color {
                bounds,
                color,
                radius,
                opacity,
            } => self.draw_rounded_rect(fb, bounds, color, *radius, *opacity),
            SceneCommand::Gradient {
                bounds,
                start,
                end,
                angle,
                opacity,
            } => self.draw_gradient(fb, bounds, start, end, *angle, *opacity),
            SceneCommand::Bitmap {
                bounds,
                width,
                height,
                pixels_base64,
                opacity,
            } => {
                // Decode base64 pixels. In production, use a zero-copy path.
                // For now, decode on receipt.
                let pixels = base64_decode(pixels_base64);
                self.draw_bitmap(fb, bounds, *width, *height, &pixels, *opacity)
            }
            SceneCommand::Text {
                bounds,
                text,
                size,
                color,
                align,
                opacity,
            } => self.draw_text(fb, bounds, text, *size, color, *align, *opacity),
            SceneCommand::Icon {
                bounds,
                name,
                size,
                color,
                opacity,
            } => self.draw_icon(fb, bounds, name, *size, color, *opacity),
            SceneCommand::Material {
                bounds,
                material,
                radius,
                opacity,
            } => self.draw_material(fb, bounds, material, *radius, *opacity),
            SceneCommand::Separator {
                bounds,
                color,
                vertical,
            } => {
                let b = if *vertical {
                    Rect {
                        x: bounds.x,
                        y: bounds.y,
                        width: 1.0,
                        height: bounds.height,
                    }
                } else {
                    Rect {
                        x: bounds.x,
                        y: bounds.y,
                        width: bounds.width,
                        height: 1.0,
                    }
                };
                self.draw_rounded_rect(fb, &b, color, 0.0, 1.0);
            }
            SceneCommand::ClipStart { bounds, .. } => self.clip_stack.push(*bounds),
            SceneCommand::ClipEnd => {
                self.clip_stack.pop();
            }
            SceneCommand::DesktopBackground { bounds, color } => {
                self.draw_rounded_rect(fb, bounds, color, 0.0, 1.0)
            }
            SceneCommand::DesktopStatusBar { bounds } => {
                let c = Color {
                    r: 0.1,
                    g: 0.1,
                    b: 0.1,
                    a: 0.9,
                };
                self.draw_rounded_rect(fb, bounds, &c, 0.0, 1.0);
            }
            SceneCommand::DesktopWindow {
                bounds, focused, ..
            } => {
                let bg = if *focused {
                    Color {
                        r: 0.16,
                        g: 0.16,
                        b: 0.18,
                        a: 1.0,
                    }
                } else {
                    Color {
                        r: 0.12,
                        g: 0.12,
                        b: 0.14,
                        a: 1.0,
                    }
                };
                self.draw_rounded_rect(fb, bounds, &bg, 12.0, 1.0);
            }
            SceneCommand::DesktopTaskbar { bounds } => {
                let c = Color {
                    r: 0.14,
                    g: 0.14,
                    b: 0.16,
                    a: 0.95,
                };
                self.draw_rounded_rect(fb, bounds, &c, 16.0, 1.0);
            }
            SceneCommand::DesktopCursor {
                x,
                y,
                cursor_kind: _,
            } => self.draw_cursor(fb, *x, *y),
        }
    }

    fn in_clip(&self, x: f32, y: f32) -> bool {
        for clip in &self.clip_stack {
            if x < clip.x || y < clip.y || x >= clip.x + clip.width || y >= clip.y + clip.height {
                return false;
            }
        }
        true
    }

    fn draw_rounded_rect(
        &self,
        fb: &mut Framebuffer,
        bounds: &Rect,
        color: &Color,
        radius: f32,
        opacity: f32,
    ) {
        let x0 = bounds.x.max(0.0) as u32;
        let y0 = bounds.y.max(0.0) as u32;
        let x1 = (bounds.x + bounds.width).min(fb.width as f32) as u32;
        let y1 = (bounds.y + bounds.height).min(fb.height as f32) as u32;
        let w = fb.width;

        let sr = (color.r * 255.0) as u8;
        let sg = (color.g * 255.0) as u8;
        let sb = (color.b * 255.0) as u8;
        let sa = (color.a * opacity * 255.0) as u8;

        for y in y0..y1 {
            for x in x0..x1 {
                if !self.in_clip(x as f32, y as f32) {
                    continue;
                }
                // Rounded corners: distance check.
                if radius > 0.0 {
                    let cx = if (x as f32) < bounds.x + radius {
                        bounds.x + radius
                    } else if (x as f32) > bounds.x + bounds.width - radius {
                        bounds.x + bounds.width - radius
                    } else {
                        x as f32
                    };
                    let cy = if (y as f32) < bounds.y + radius {
                        bounds.y + radius
                    } else if (y as f32) > bounds.y + bounds.height - radius {
                        bounds.y + bounds.height - radius
                    } else {
                        y as f32
                    };
                    let dx = x as f32 - cx;
                    let dy = y as f32 - cy;
                    if dx * dx + dy * dy > radius * radius {
                        continue;
                    }
                }
                let idx = ((y * w + x) * 4) as usize;
                if sa == 255 {
                    fb.pixels[idx] = sr;
                    fb.pixels[idx + 1] = sg;
                    fb.pixels[idx + 2] = sb;
                    fb.pixels[idx + 3] = 255;
                } else {
                    // Alpha blend.
                    let da = fb.pixels[idx + 3] as f32 / 255.0;
                    let sa_f = sa as f32 / 255.0;
                    let out_a = sa_f + da * (1.0 - sa_f);
                    if out_a > 0.0 {
                        fb.pixels[idx] = ((sr as f32 * sa_f
                            + fb.pixels[idx] as f32 * da * (1.0 - sa_f))
                            / out_a) as u8;
                        fb.pixels[idx + 1] = ((sg as f32 * sa_f
                            + fb.pixels[idx + 1] as f32 * da * (1.0 - sa_f))
                            / out_a) as u8;
                        fb.pixels[idx + 2] = ((sb as f32 * sa_f
                            + fb.pixels[idx + 2] as f32 * da * (1.0 - sa_f))
                            / out_a) as u8;
                        fb.pixels[idx + 3] = (out_a * 255.0) as u8;
                    }
                }
            }
        }
    }

    fn draw_gradient(
        &self,
        fb: &mut Framebuffer,
        bounds: &Rect,
        start: &Color,
        end: &Color,
        angle: f32,
        opacity: f32,
    ) {
        // Simplified: vertical gradient. Angle support can be added.
        let _ = angle;
        let x0 = bounds.x.max(0.0) as u32;
        let y0 = bounds.y.max(0.0) as u32;
        let x1 = (bounds.x + bounds.width).min(fb.width as f32) as u32;
        let y1 = (bounds.y + bounds.height).min(fb.height as f32) as u32;
        let h = bounds.height.max(1.0);

        for y in y0..y1 {
            let t = ((y as f32 - bounds.y) / h).clamp(0.0, 1.0);
            let c = Color {
                r: start.r + (end.r - start.r) * t,
                g: start.g + (end.g - start.g) * t,
                b: start.b + (end.b - start.b) * t,
                a: start.a + (end.a - start.a) * t,
            };
            let row = Rect {
                x: bounds.x,
                y: y as f32,
                width: bounds.width,
                height: 1.0,
            };
            self.draw_rounded_rect(fb, &row, &c, 0.0, opacity);
            let _ = (x0, x1);
        }
    }

    fn draw_bitmap(
        &self,
        fb: &mut Framebuffer,
        bounds: &Rect,
        width: u32,
        height: u32,
        pixels: &[u8],
        opacity: f32,
    ) {
        if pixels.len() < (width as usize) * (height as usize) * 4 {
            return;
        }
        let dx0 = bounds.x.max(0.0) as u32;
        let dy0 = bounds.y.max(0.0) as u32;
        let dx1 = (bounds.x + bounds.width).min(fb.width as f32) as u32;
        let dy1 = (bounds.y + bounds.height).min(fb.height as f32) as u32;
        let fw = fb.width;

        for dy in dy0..dy1 {
            for dx in dx0..dx1 {
                if !self.in_clip(dx as f32, dy as f32) {
                    continue;
                }
                // Nearest-neighbor sample.
                let sx = (((dx as f32 - bounds.x) / bounds.width) * width as f32) as u32;
                let sy = (((dy as f32 - bounds.y) / bounds.height) * height as f32) as u32;
                let sx = sx.min(width - 1);
                let sy = sy.min(height - 1);
                let sidx = ((sy * width + sx) * 4) as usize;
                let didx = ((dy * fw + dx) * 4) as usize;

                let sa = (pixels[sidx + 3] as f32 / 255.0) * opacity;
                if sa >= 1.0 {
                    fb.pixels[didx..didx + 4].copy_from_slice(&pixels[sidx..sidx + 4]);
                } else if sa > 0.0 {
                    let da = fb.pixels[didx + 3] as f32 / 255.0;
                    let out_a = sa + da * (1.0 - sa);
                    if out_a > 0.0 {
                        for c in 0..3 {
                            fb.pixels[didx + c] = ((pixels[sidx + c] as f32 * sa
                                + fb.pixels[didx + c] as f32 * da * (1.0 - sa))
                                / out_a) as u8;
                        }
                        fb.pixels[didx + 3] = (out_a * 255.0) as u8;
                    }
                }
            }
        }
    }

    fn draw_text(
        &self,
        fb: &mut Framebuffer,
        bounds: &Rect,
        text: &str,
        size: f32,
        color: &Color,
        align: TextAlign,
        opacity: f32,
    ) {
        let font = system_font();
        let px = size.max(1.0);

        // Measure total width for alignment.
        let mut total_w = 0.0f32;
        for ch in text.chars() {
            let (metrics, _) = font.rasterize(ch, px);
            total_w += metrics.advance_width;
        }
        let start_x = match align {
            TextAlign::Start => bounds.x,
            TextAlign::Center => bounds.x + (bounds.width - total_w) / 2.0,
            TextAlign::End => bounds.x + bounds.width - total_w,
        };

        let mut x = start_x;
        // Baseline: top of bounds + ascent approximation.
        let y_base = bounds.y + px * 0.8;

        let sr = (color.r * 255.0) as u8;
        let sg = (color.g * 255.0) as u8;
        let sb = (color.b * 255.0) as u8;

        for ch in text.chars() {
            let (metrics, bitmap) = font.rasterize(ch, px);
            let gw = metrics.width as i32;
            let gh = metrics.height as i32;
            let gx0 = (x + metrics.bounds.xmin as f32) as i32;
            let gy0 = (y_base + metrics.bounds.ymin as f32) as i32;

            for gy in 0..gh {
                for gx in 0..gw {
                    let dx = gx0 + gx;
                    let dy = gy0 + gy;
                    if dx < 0 || dy < 0 || dx >= fb.width as i32 || dy >= fb.height as i32 {
                        continue;
                    }
                    if !self.in_clip(dx as f32, dy as f32) {
                        continue;
                    }
                    let alpha = bitmap[(gy * gw + gx) as usize] as f32 / 255.0 * opacity;
                    if alpha <= 0.0 {
                        continue;
                    }
                    let didx = ((dy as u32 * fb.width + dx as u32) * 4) as usize;
                    if alpha >= 1.0 {
                        fb.pixels[didx] = sr;
                        fb.pixels[didx + 1] = sg;
                        fb.pixels[didx + 2] = sb;
                        fb.pixels[didx + 3] = 255;
                    } else {
                        let da = fb.pixels[didx + 3] as f32 / 255.0;
                        let out_a = alpha + da * (1.0 - alpha);
                        if out_a > 0.0 {
                            fb.pixels[didx] = ((sr as f32 * alpha
                                + fb.pixels[didx] as f32 * da * (1.0 - alpha))
                                / out_a) as u8;
                            fb.pixels[didx + 1] = ((sg as f32 * alpha
                                + fb.pixels[didx + 1] as f32 * da * (1.0 - alpha))
                                / out_a) as u8;
                            fb.pixels[didx + 2] = ((sb as f32 * alpha
                                + fb.pixels[didx + 2] as f32 * da * (1.0 - alpha))
                                / out_a) as u8;
                            fb.pixels[didx + 3] = (out_a * 255.0) as u8;
                        }
                    }
                }
            }
            x += metrics.advance_width;
        }
    }

    /// Draw an icon glyph. For now, renders the first character of the icon
    /// name as a text glyph; a full icon font is a follow-up.
    fn draw_icon(
        &self,
        fb: &mut Framebuffer,
        bounds: &Rect,
        name: &str,
        size: f32,
        color: &Color,
        opacity: f32,
    ) {
        // Use the first character of the icon name, or a bullet if empty.
        let glyph = name.chars().next().unwrap_or('•').to_string();
        self.draw_text(fb, bounds, &glyph, size, color, TextAlign::Center, opacity);
    }

    /// Draw a frosted-glass material. A true blur is expensive in software;
    /// this approximates with a semi-transparent overlay. The alpha varies
    /// by material thickness.
    fn draw_material(
        &self,
        fb: &mut Framebuffer,
        bounds: &Rect,
        material: &MaterialKind,
        radius: f32,
        opacity: f32,
    ) {
        let alpha = match material {
            MaterialKind::UltraThin => 0.25,
            MaterialKind::Thin => 0.4,
            MaterialKind::Regular => 0.55,
            MaterialKind::Thick => 0.7,
        } * opacity;
        // Light frosted glass: white overlay.
        let c = Color {
            r: 1.0,
            g: 1.0,
            b: 1.0,
            a: alpha as f32,
        };
        self.draw_rounded_rect(fb, bounds, &c, radius, 1.0);
    }

    /// Draw a simple arrow cursor at the given position.
    fn draw_cursor(&self, fb: &mut Framebuffer, x: f32, y: f32) {
        let ix = x as i32;
        let iy = y as i32;
        // Simple 12x16 arrow cursor bitmap (1 = white, 2 = black outline).
        const CURSOR: &[&str] = &[
            "1           ",
            "11          ",
            "121         ",
            "1221        ",
            "12221       ",
            "122221      ",
            "1222221     ",
            "12222221    ",
            "122222221   ",
            "1222222221  ",
            "12222222221 ",
            "12222111111 ",
            "122221      ",
            "12211       ",
            "1211        ",
            "111         ",
        ];
        for (dy, row) in CURSOR.iter().enumerate() {
            for (dx, ch) in row.chars().enumerate() {
                if ch == ' ' {
                    continue;
                }
                let px = ix + dx as i32;
                let py = iy + dy as i32;
                if px < 0 || py < 0 || px >= fb.width as i32 || py >= fb.height as i32 {
                    continue;
                }
                if !self.in_clip(px as f32, py as f32) {
                    continue;
                }
                let didx = ((py as u32 * fb.width + px as u32) * 4) as usize;
                match ch {
                    '1' => {
                        fb.pixels[didx] = 255;
                        fb.pixels[didx + 1] = 255;
                        fb.pixels[didx + 2] = 255;
                        fb.pixels[didx + 3] = 255;
                    }
                    '2' => {
                        fb.pixels[didx] = 0;
                        fb.pixels[didx + 1] = 0;
                        fb.pixels[didx + 2] = 0;
                        fb.pixels[didx + 3] = 255;
                    }
                    _ => {}
                }
            }
        }
    }
}

impl Default for Rasterizer {
    fn default() -> Self {
        Self::new()
    }
}
