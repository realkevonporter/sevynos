import { describe, expect, it, vi } from "vitest";
import { AnimatedValue, timing } from "./animated.js";
import { InteractionManager } from "./interaction-manager.js";

describe("InteractionManager (upstream React Native specification)", () => {
  it("runs task in microtask when no interactions are in flight", async () => {
    const task = vi.fn(() => "result-value");
    const promise = InteractionManager.runAfterInteractions(task);
    const result = await promise;
    expect(task).toHaveBeenCalledTimes(1);
    expect(result).toBe("result-value");
  });

  it("holds task until all interaction handles are cleared", async () => {
    const handle1 = InteractionManager.createInteractionHandle();
    const handle2 = InteractionManager.createInteractionHandle();
    expect(InteractionManager.activeCount).toBe(2);

    const task = vi.fn(() => 42);
    let resolved = false;
    const promise = InteractionManager.runAfterInteractions(task);
    void promise.then(() => {
      resolved = true;
    });

    // Wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(task).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    // Clear handle1 - handle2 is still active
    InteractionManager.clearInteractionHandle(handle1);
    expect(InteractionManager.activeCount).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(task).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    // Clear handle2 - all handles cleared, task should run
    InteractionManager.clearInteractionHandle(handle2);
    expect(InteractionManager.activeCount).toBe(0);

    const result = await promise;
    expect(task).toHaveBeenCalledTimes(1);
    expect(result).toBe(42);
    expect(resolved).toBe(true);
  });

  it("allows cancelling scheduled tasks before they execute", async () => {
    const handle = InteractionManager.createInteractionHandle();
    const task = vi.fn(() => "cancelled");
    const promise = InteractionManager.runAfterInteractions(task);

    // Cancel before clearing handle
    promise.cancel();
    InteractionManager.clearInteractionHandle(handle);

    await new Promise((r) => setTimeout(r, 10));
    expect(task).not.toHaveBeenCalled();
  });

  it("notifies listeners on interaction start and complete", () => {
    const startListener = vi.fn();
    const completeListener = vi.fn();

    const subStart = InteractionManager.addListener("interactionStart", startListener);
    const subComplete = InteractionManager.addListener(
      "interactionComplete",
      completeListener,
    );

    const handle = InteractionManager.createInteractionHandle();
    expect(startListener).toHaveBeenCalledTimes(1);
    expect(completeListener).not.toHaveBeenCalled();

    InteractionManager.clearInteractionHandle(handle);
    expect(completeListener).toHaveBeenCalledTimes(1);

    subStart.remove();
    subComplete.remove();
  });

  it("automatically tracks Animated animations as active interactions", async () => {
    const animVal = new AnimatedValue(0);
    const anim = timing(animVal, { toValue: 100, duration: 150 });

    expect(InteractionManager.activeCount).toBe(0);
    anim.start();
    expect(InteractionManager.activeCount).toBeGreaterThanOrEqual(1);

    const afterTask = vi.fn(() => "anim-finished");
    const promise = InteractionManager.runAfterInteractions(afterTask);

    await new Promise((r) => setTimeout(r, 20));
    expect(afterTask).not.toHaveBeenCalled();

    // Wait for animation to finish
    await new Promise((r) => setTimeout(r, 200));
    const res = await promise;
    expect(afterTask).toHaveBeenCalledTimes(1);
    expect(res).toBe("anim-finished");
    expect(InteractionManager.activeCount).toBe(0);
  });
});
