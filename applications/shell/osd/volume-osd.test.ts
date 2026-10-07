/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it } from "vitest";
import { computeFilledSegments } from "./volume-osd-math.js";

describe("computeFilledSegments", () => {
  it("fills proportionally to the volume", () => {
    expect(computeFilledSegments(0, false)).toBe(0);
    expect(computeFilledSegments(50, false)).toBe(8);
    expect(computeFilledSegments(100, false)).toBe(16);
    expect(computeFilledSegments(25, false)).toBe(4);
  });

  it("shows no segments when muted", () => {
    expect(computeFilledSegments(80, true)).toBe(0);
    expect(computeFilledSegments(100, true)).toBe(0);
  });

  it("clamps out-of-range volumes", () => {
    expect(computeFilledSegments(-10, false)).toBe(0);
    expect(computeFilledSegments(250, false)).toBe(16);
  });

  it("supports a custom segment count", () => {
    expect(computeFilledSegments(50, false, 10)).toBe(5);
  });
});
