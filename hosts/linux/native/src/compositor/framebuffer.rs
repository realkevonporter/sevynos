// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Pooled RGBA framebuffer management.
//!
//! Framebuffers are reused across frames to avoid allocation pressure.
//! The pool is bounded: acquiring beyond the maximum returns an error
//! instead of growing without bound (the failure mode that OOM'd the
//! Node.js compositor).

use std::collections::VecDeque;

#[derive(Debug)]
pub struct Framebuffer {
    pub id: u64,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Framebuffer {
    fn new(id: u64, width: u32, height: u32) -> Self {
        let size = (width as usize) * (height as usize) * 4;
        Self {
            id,
            width,
            height,
            pixels: vec![0u8; size],
        }
    }

    pub fn clear(&mut self) {
        self.pixels.fill(0);
    }
}

#[derive(Debug)]
pub struct FramebufferPool {
    buffers: Vec<Framebuffer>,
    available: VecDeque<usize>,
    max_buffers: usize,
    next_id: u64,
}

impl FramebufferPool {
    pub fn new(max_buffers: usize) -> Self {
        assert!(max_buffers >= 2, "pool requires at least two buffers");
        Self {
            buffers: Vec::new(),
            available: VecDeque::new(),
            max_buffers,
            next_id: 0,
        }
    }

    /// Acquire a framebuffer of the given size. Reuses an available buffer
    /// when possible; allocates a new one up to the maximum.
    pub fn acquire(&mut self, width: u32, height: u32) -> Result<usize, String> {
        // Prefer an available buffer of matching size.
        if let Some(pos) = self
            .available
            .iter()
            .position(|&i| self.buffers[i].width == width && self.buffers[i].height == height)
        {
            let idx = self.available.remove(pos).expect("position valid");
            self.buffers[idx].clear();
            return Ok(idx);
        }
        // Discard available buffers of other sizes to make room.
        while self.buffers.len() >= self.max_buffers {
            match self.available.pop_front() {
                Some(idx) => {
                    self.buffers.swap_remove(idx);
                    // Fix up indices after swap_remove.
                    for i in self.available.iter_mut() {
                        if *i == self.buffers.len() {
                            *i = idx;
                        }
                    }
                }
                None => return Err("no reusable framebuffer available".to_string()),
            }
        }
        self.next_id += 1;
        let fb = Framebuffer::new(self.next_id, width, height);
        self.buffers.push(fb);
        Ok(self.buffers.len() - 1)
    }

    /// Release a framebuffer back to the pool.
    pub fn release(&mut self, idx: usize) {
        if idx < self.buffers.len() && !self.available.contains(&idx) {
            self.available.push_back(idx);
        }
    }

    pub fn get(&self, idx: usize) -> Option<&Framebuffer> {
        self.buffers.get(idx)
    }

    pub fn get_mut(&mut self, idx: usize) -> Option<&mut Framebuffer> {
        self.buffers.get_mut(idx)
    }
}
