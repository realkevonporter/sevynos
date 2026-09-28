// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Compositor smoke test: render a scene and verify output.

#[cfg(test)]
mod tests {
    use crate::compositor::protocol::{Color, Rect, TextAlign};
    use crate::compositor::{FramebufferPool, Rasterizer, Scene, SceneCommand};

    #[test]
    fn renders_color_rect() {
        let mut pool = FramebufferPool::new(3);
        let idx = pool.acquire(100, 100).unwrap();
        let fb = pool.get_mut(idx).unwrap();
        let mut r = Rasterizer::new();

        let scene = Scene {
            width: 100,
            height: 100,
            commands: vec![SceneCommand::Color {
                bounds: Rect {
                    x: 10.0,
                    y: 10.0,
                    width: 80.0,
                    height: 80.0,
                },
                color: Color {
                    r: 1.0,
                    g: 0.0,
                    b: 0.0,
                    a: 1.0,
                },
                radius: 0.0,
                opacity: 1.0,
            }],
        };
        r.render(&scene, fb);

        // Center should be red.
        let cidx = ((50 * 100 + 50) * 4) as usize;
        assert_eq!(fb.pixels[cidx], 255);
        assert_eq!(fb.pixels[cidx + 1], 0);
        assert_eq!(fb.pixels[cidx + 2], 0);

        // Corner should be black (cleared).
        assert_eq!(fb.pixels[0], 0);
        pool.release(idx);
    }

    #[test]
    fn framebuffer_pool_bounds_memory() {
        let mut pool = FramebufferPool::new(2);
        let a = pool.acquire(10, 10).unwrap();
        let b = pool.acquire(10, 10).unwrap();
        // Third acquire should fail (pool is bounded).
        assert!(pool.acquire(10, 10).is_err());
        pool.release(a);
        pool.release(b);
        // After release, acquire works again.
        assert!(pool.acquire(10, 10).is_ok());
    }

    #[test]
    fn clip_restricts_drawing() {
        let mut pool = FramebufferPool::new(3);
        let idx = pool.acquire(100, 100).unwrap();
        let fb = pool.get_mut(idx).unwrap();
        let mut r = Rasterizer::new();

        let scene = Scene {
            width: 100,
            height: 100,
            commands: vec![
                SceneCommand::ClipStart {
                    bounds: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 50.0,
                        height: 50.0,
                    },
                    radius: 0.0,
                },
                SceneCommand::Color {
                    bounds: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 100.0,
                    },
                    color: Color {
                        r: 0.0,
                        g: 1.0,
                        b: 0.0,
                        a: 1.0,
                    },
                    radius: 0.0,
                    opacity: 1.0,
                },
                SceneCommand::ClipEnd,
            ],
        };
        r.render(&scene, fb);

        // Inside clip: green.
        let inside = ((25 * 100 + 25) * 4) as usize;
        assert_eq!(fb.pixels[inside + 1], 255);
        // Outside clip: black.
        let outside = ((75 * 100 + 75) * 4) as usize;
        assert_eq!(fb.pixels[outside + 1], 0);
        pool.release(idx);
    }
}
