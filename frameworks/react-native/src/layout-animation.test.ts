import { describe, expect, it, vi } from "vitest";
import React from "react";
import type { NativeRuntimeSnapshot } from "./native-types.js";
import {
  LayoutAnimation,
  consumePendingLayoutAnimation,
  driveLayoutAnimation,
} from "./layout-animation.js";
import { SevynApplicationRuntime } from "./application-runtime.js";
import { View } from "./primitives.js";

describe("LayoutAnimation", () => {
  it("provides standard Presets and Types", () => {
    expect(LayoutAnimation.Presets.easeInEaseOut.duration).toBe(300);
    expect(LayoutAnimation.Presets.linear.duration).toBe(500);
    expect(LayoutAnimation.Presets.spring.duration).toBe(700);

    expect(LayoutAnimation.Types.spring).toBe("spring");
    expect(LayoutAnimation.Types.linear).toBe("linear");
    expect(LayoutAnimation.Properties.opacity).toBe("opacity");
    expect(LayoutAnimation.Properties.scaleXY).toBe("scaleXY");
  });

  it("stores and consumes pending layout animation config", () => {
    const onEnd = vi.fn();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut, onEnd);

    const pending = consumePendingLayoutAnimation();
    expect(pending).toBeDefined();
    expect(pending?.config.duration).toBe(300);

    // Calling again should be empty since it was consumed
    expect(consumePendingLayoutAnimation()).toBeUndefined();
  });

  it("creates custom layout animation config with create helper", () => {
    const config = LayoutAnimation.create(400, "spring", "scaleXY");
    expect(config.duration).toBe(400);
    expect(config.create?.type).toBe("spring");
    expect(config.create?.property).toBe("scaleXY");
  });

  it("drives frame-by-frame interpolation with driveLayoutAnimation", async () => {
    const frames: number[] = [];
    const onComplete = vi.fn();
    const onCancel = vi.fn();

    const startSnapshot: NativeRuntimeSnapshot = Object.freeze({
      revision: 1,
      commands: Object.freeze([
        Object.freeze({
          kind: "material" as const,
          id: "box",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          color: "#FF0000",
          radius: 0,
        }),
      ]),
      accessibility: Object.freeze([]),
      overlays: Object.freeze([]),
      changedNodeIds: Object.freeze(["box"]),
    });

    const targetSnapshot: NativeRuntimeSnapshot = Object.freeze({
      revision: 2,
      commands: Object.freeze([
        Object.freeze({
          kind: "material" as const,
          id: "box",
          bounds: { x: 200, y: 200, width: 100, height: 100 },
          color: "#FF0000",
          radius: 0,
        }),
      ]),
      accessibility: Object.freeze([]),
      overlays: Object.freeze([]),
      changedNodeIds: Object.freeze(["box"]),
    });

    const driver = driveLayoutAnimation({
      startSnapshot,
      targetSnapshot,
      config: { duration: 50 },
      onFrame: (snap) => {
        const cmd = snap.commands.find((c) => c.id === "box");
        if (cmd) frames.push(cmd.bounds.x);
      },
      onComplete,
      onCancel,
    });

    expect(driver).toBeDefined();
    expect(typeof driver.stop).toBe("function");

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.at(-1)).toBe(200);
    expect(onComplete).toHaveBeenCalled();
  });

  it("integrates LayoutAnimation.configureNext into SevynApplicationRuntime commits", async () => {
    const onEnd = vi.fn();
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 400, height: 400 },
    });

    runtime.mount(
      React.createElement(View, {
        style: { width: 100, height: 100, backgroundColor: "#FF0000" },
      }),
    );

    expect(runtime.snapshot.commands.length).toBeGreaterThan(0);

    LayoutAnimation.configureNext(
      {
        duration: 40,
        update: { type: "linear" },
      },
      onEnd,
    );

    // Trigger an update with new size
    runtime.update(
      React.createElement(View, {
        style: { width: 250, height: 250, backgroundColor: "#FF0000" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(onEnd).toHaveBeenCalled();

    runtime.unmount();
  });
});
