// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Scene protocol: serializable draw commands sent from Node.js to Rust.
//!
//! This is the API boundary for the Rust compositor. Node.js composes the
//! scene graph and serializes it as a list of commands; Rust deserializes
//! and rasterizes them. Pixel buffers (bitmaps) are transferred as raw
//! bytes, never held in the V8 heap longer than serialization.

use serde::{Deserialize, Serialize};

/// A 2D rectangle in logical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// RGBA color with components in 0.0–1.0.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

/// A complete scene: a list of draw commands in z-order (back to front).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub width: u32,
    pub height: u32,
    pub commands: Vec<SceneCommand>,
}

/// A single draw command. Variants mirror the TypeScript NativeRenderCommand
/// kinds so the Node.js side can serialize directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SceneCommand {
    /// Solid color rectangle, optionally rounded.
    Color {
        bounds: Rect,
        color: Color,
        radius: f32,
        opacity: f32,
    },
    /// Linear gradient rectangle.
    Gradient {
        bounds: Rect,
        start: Color,
        end: Color,
        angle: f32,
        opacity: f32,
    },
    /// Bitmap image. Pixels are raw RGBA8888 bytes, base64-encoded for JSON.
    Bitmap {
        bounds: Rect,
        width: u32,
        height: u32,
        pixels_base64: String,
        opacity: f32,
    },
    /// Text run.
    Text {
        bounds: Rect,
        text: String,
        size: f32,
        color: Color,
        align: TextAlign,
        opacity: f32,
    },
    /// Icon glyph.
    Icon {
        bounds: Rect,
        name: String,
        size: f32,
        color: Color,
        opacity: f32,
    },
    /// Frosted-glass material.
    Material {
        bounds: Rect,
        material: MaterialKind,
        radius: f32,
        opacity: f32,
    },
    /// Thin separator line.
    Separator {
        bounds: Rect,
        color: Color,
        vertical: bool,
    },
    /// Push a clip rectangle.
    ClipStart { bounds: Rect, radius: f32 },
    /// Pop the most recent clip rectangle.
    ClipEnd,
    /// Desktop background (wallpaper / solid).
    DesktopBackground { bounds: Rect, color: Color },
    /// Status bar at the top of the screen.
    DesktopStatusBar { bounds: Rect },
    /// Application window frame.
    DesktopWindow {
        bounds: Rect,
        title: String,
        focused: bool,
    },
    /// Taskbar / dock.
    DesktopTaskbar { bounds: Rect },
    /// Cursor.
    DesktopCursor { x: f32, y: f32, cursor_kind: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Start,
    Center,
    End,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaterialKind {
    UltraThin,
    Thin,
    Regular,
    Thick,
}
