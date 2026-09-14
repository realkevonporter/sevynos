import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WindowAnimationController } from "./window-animation-controller.js";

describe("WindowAnimationController", () => {
  let controller: WindowAnimationController;

  beforeEach(() => {
    controller = new WindowAnimationController(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("animateOpen", () => {
    it("should start an animation for the window", () => {
      controller.animateOpen("win-1");
      expect(controller.isAnimating("win-1")).toBe(true);
      expect(controller.hasActiveAnimations).toBe(true);
    });

    it("should provide a transform with reduced opacity and scale at start", () => {
      controller.animateOpen("win-1");
      const transform = controller.getTransform("win-1");
      expect(transform).toBeDefined();
      expect(transform?.opacity).toBeLessThan(1);
      expect(transform?.scaleX).toBeLessThan(1);
    });

    it("should complete and call onComplete after duration", () => {
      const onComplete = vi.fn();
      controller.animateOpen("win-1", onComplete);

      // Advance past animation duration (standard = 190ms)
      vi.advanceTimersByTime(250);

      expect(onComplete).toHaveBeenCalledOnce();
      expect(controller.isAnimating("win-1")).toBe(false);
    });

    it("should return undefined transform after completion", () => {
      controller.animateOpen("win-1");
      vi.advanceTimersByTime(250);
      expect(controller.getTransform("win-1")).toBeUndefined();
    });
  });

  describe("animateClose", () => {
    it("should animate from visible to faded/scaled", () => {
      controller.animateClose("win-2");
      const transform = controller.getTransform("win-2");
      expect(transform).toBeDefined();
      // At start of close, window should still be mostly visible
      expect(transform?.opacity).toBeGreaterThan(0.5);
    });

    it("should complete and fire callback", () => {
      const onComplete = vi.fn();
      controller.animateClose("win-2", onComplete);
      vi.advanceTimersByTime(200);
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  describe("animateMinimize", () => {
    it("should start minimize animation with translateY toward dock", () => {
      const bounds = { x: 100, y: 100, width: 800, height: 600 };
      controller.animateMinimize("win-3", bounds, 900);
      expect(controller.isAnimating("win-3")).toBe(true);
    });

    it("should complete after duration", () => {
      const onComplete = vi.fn();
      const bounds = { x: 100, y: 100, width: 800, height: 600 };
      controller.animateMinimize("win-3", bounds, 900, onComplete);
      vi.advanceTimersByTime(250);
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  describe("animateRestore", () => {
    it("should animate from small/faded to full", () => {
      controller.animateRestore("win-4");
      const transform = controller.getTransform("win-4");
      expect(transform).toBeDefined();
      expect(transform?.scaleX).toBeLessThan(1);
      expect(transform?.opacity).toBeLessThan(1);
    });
  });

  describe("reduced motion", () => {
    it("should skip animation and fire onComplete immediately", () => {
      const reducedController = new WindowAnimationController(true);
      const onComplete = vi.fn();
      reducedController.animateOpen("win-5", onComplete);
      expect(onComplete).toHaveBeenCalledOnce();
      expect(reducedController.isAnimating("win-5")).toBe(false);
      reducedController.dispose();
    });

    it("should respect setReducedMotion", () => {
      controller.setReducedMotion(true);
      const onComplete = vi.fn();
      controller.animateClose("win-6", onComplete);
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  describe("cancel", () => {
    it("should stop a running animation", () => {
      controller.animateOpen("win-7");
      expect(controller.isAnimating("win-7")).toBe(true);
      controller.cancel("win-7");
      expect(controller.isAnimating("win-7")).toBe(false);
    });

    it("should clear all animations with cancelAll", () => {
      controller.animateOpen("win-a");
      controller.animateOpen("win-b");
      controller.animateOpen("win-c");
      expect(controller.hasActiveAnimations).toBe(true);
      controller.cancelAll();
      expect(controller.hasActiveAnimations).toBe(false);
    });
  });

  describe("subscribe", () => {
    it("should notify listeners during animation ticks", () => {
      const listener = vi.fn();
      controller.subscribe(listener);
      controller.animateOpen("win-8");
      vi.advanceTimersByTime(32); // Two ticks
      expect(listener).toHaveBeenCalled();
    });

    it("should stop notifying after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = controller.subscribe(listener);
      unsubscribe();
      controller.animateOpen("win-9");
      vi.advanceTimersByTime(50);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("concurrent animations", () => {
    it("should handle multiple windows animating simultaneously", () => {
      controller.animateOpen("win-x");
      controller.animateClose("win-y");
      expect(controller.isAnimating("win-x")).toBe(true);
      expect(controller.isAnimating("win-y")).toBe(true);
    });

    it("should replace animation if same window starts a new one", () => {
      const firstComplete = vi.fn();
      const secondComplete = vi.fn();
      controller.animateOpen("win-z", firstComplete);
      controller.animateClose("win-z", secondComplete);
      vi.advanceTimersByTime(250);
      // First animation should have been replaced, not completed
      expect(firstComplete).not.toHaveBeenCalled();
      expect(secondComplete).toHaveBeenCalledOnce();
    });
  });
});
