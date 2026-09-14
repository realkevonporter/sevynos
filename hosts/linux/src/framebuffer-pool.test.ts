import { describe, expect, it } from "vitest";
import { FramebufferPool } from "./framebuffer-pool.js";

describe("framebuffer pool", () => {
  it("reuses released storage without overwriting a submitted buffer", () => {
    const pool = new FramebufferPool(3);
    const first = pool.acquire(1280, 720);
    pool.submit(first);
    const second = pool.acquire(1280, 720);
    expect(second).not.toBe(first);
    pool.release(first);
    pool.submit(second);
    const reused = pool.acquire(1280, 720);
    expect(reused).toBe(first);
    expect(pool.allocationCount).toBe(2);
  });

  it("retires released old-size buffers after resize", () => {
    const pool = new FramebufferPool();
    const large = pool.acquire(1280, 720);
    pool.submit(large);
    const resized = pool.acquire(1024, 640);
    expect(resized.pixels).toHaveLength(1024 * 640 * 4);
    pool.release(large);
    pool.submit(resized);
    pool.release(resized);
    expect(pool.acquire(1024, 640)).toBe(resized);
  });

  it("rejects a fourth busy buffer instead of overwriting owned pixels", () => {
    const pool = new FramebufferPool(3);
    for (let index = 0; index < 3; index += 1) pool.submit(pool.acquire(2, 2));
    expect(() => pool.acquire(2, 2)).toThrow(/No reusable framebuffer/);
    expect(pool.busyCount).toBe(3);
  });
});
