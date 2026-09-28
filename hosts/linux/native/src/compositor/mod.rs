// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Rust compositor for SevynOS.
//!
//! This module implements the production compositor hot path in Rust,
//! replacing the Node.js software renderer. Node.js sends scene descriptions
//! (draw commands); Rust rasterizes them into framebuffers and presents.
//!
//! Architecture:
//! - `protocol`: Serializable scene command definitions (the Node ↔ Rust API)
//! - `framebuffer`: Pooled RGBA framebuffer management
//! - `rasterizer`: Software rasterization of all command types

pub mod framebuffer;
pub mod protocol;
pub mod rasterizer;

#[cfg(test)]
mod tests;

pub use framebuffer::{Framebuffer, FramebufferPool};
pub use protocol::{Scene, SceneCommand};
pub use rasterizer::Rasterizer;
