import { describe, expect, it } from "vitest";
import { FrameMetrics } from "./frame-metrics.js";

describe("frame metrics", () => {
  it("summarizes raster percentiles and damage means", () => {
    const metrics = new FrameMetrics();
    metrics.recordRaster({
      frameId: 1,
      displayId: "display-0",
      rasterMs: 4,
      damageRectCount: 2,
      damagePixelCount: 8000,
    });
    metrics.recordRaster({
      frameId: 2,
      displayId: "display-0",
      rasterMs: 12,
      damageRectCount: 4,
      damagePixelCount: 16000,
    });

    const summary = metrics.summarize({
      invalidationCount: 2,
      submittedFrameCount: 2,
    });
    expect(summary.rasterMs.count).toBe(2);
    expect(summary.rasterMs.max).toBe(12);
    expect(summary.damageRectsPerFrame).toBe(3);
    expect(summary.damagePixelsPerFrame).toBe(12000);
    expect(summary.emptyFrames).toBe(0);
    expect(summary.coalescedInvalidations).toBe(0);
  });

  it("counts zero-damage frames as empty", () => {
    const metrics = new FrameMetrics();
    metrics.recordRaster({
      frameId: 1,
      displayId: "display-0",
      rasterMs: 0.2,
      damageRectCount: 0,
      damagePixelCount: 0,
    });

    const summary = metrics.summarize({
      invalidationCount: 1,
      submittedFrameCount: 0,
    });
    expect(summary.emptyFrames).toBe(1);
    expect(summary.coalescedInvalidations).toBe(1);
  });

  it("pairs submits with presents by frameId for pipe latency", () => {
    const metrics = new FrameMetrics();
    metrics.recordSubmitted(7, 1000);
    metrics.recordSubmitted(8, 1016);
    metrics.recordPresented(7, 1008);
    metrics.recordPresented(8, 1030);

    const summary = metrics.summarize({
      invalidationCount: 2,
      submittedFrameCount: 2,
    });
    expect(summary.pipeLatencyMs.count).toBe(2);
    expect(summary.pipeLatencyMs.p50).toBe(8);
    expect(summary.pipeLatencyMs.max).toBe(14);
    // One interval between the two presents: 22ms -> ~45.5 fps.
    expect(summary.frameIntervalMs.count).toBe(1);
    expect(summary.fps).toBeCloseTo(45.5, 1);
  });

  it("ignores pipe latency for presents without a matching submit", () => {
    const metrics = new FrameMetrics();
    metrics.recordPresented(99, 2000);

    const summary = metrics.summarize({
      invalidationCount: 0,
      submittedFrameCount: 0,
    });
    expect(summary.pipeLatencyMs.count).toBe(0);
    expect(summary.frameIntervalMs.count).toBe(0);
    expect(summary.fps).toBe(0);
  });

  it("caps ring buffers so long runs stay bounded", () => {
    const metrics = new FrameMetrics();
    for (let i = 0; i < 500; i += 1) {
      metrics.recordRaster({
        frameId: i,
        displayId: "display-0",
        rasterMs: i,
        damageRectCount: 1,
        damagePixelCount: 100,
      });
    }

    const summary = metrics.summarize({
      invalidationCount: 500,
      submittedFrameCount: 500,
    });
    expect(summary.rasterMs.count).toBe(240);
    expect(summary.rasterMs.max).toBe(499);
  });
});
