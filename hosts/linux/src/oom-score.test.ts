import { describe, expect, it } from "vitest";
import {
  OOM_SCORE_ADJ,
  oomScoreAdjForApplication,
  protectCurrentProcessFromOomKiller,
  setOomScoreAdj,
} from "./oom-score.js";

describe("oom score adj", () => {
  it("uses a strongly negative but killable score for session processes", () => {
    expect(OOM_SCORE_ADJ.SESSION_CRITICAL).toBe(-500);
    expect(OOM_SCORE_ADJ.SESSION_CRITICAL).toBeGreaterThan(-1000);
    expect(OOM_SCORE_ADJ.DEFAULT).toBe(0);
  });

  it("protects the recovery-path terminal ahead of ordinary apps", () => {
    expect(oomScoreAdjForApplication("org.sevynos.terminal")).toBe(
      OOM_SCORE_ADJ.SESSION_CRITICAL,
    );
    expect(oomScoreAdjForApplication("org.sevynos.browser")).toBe(OOM_SCORE_ADJ.DEFAULT);
    expect(oomScoreAdjForApplication("org.sevynos.unknown")).toBe(OOM_SCORE_ADJ.DEFAULT);
  });

  it("rejects invalid pids without touching the filesystem", () => {
    expect(setOomScoreAdj(0, -500)).toBe(false);
    expect(setOomScoreAdj(-1, -500)).toBe(false);
    expect(setOomScoreAdj(Number.NaN, -500)).toBe(false);
    expect(setOomScoreAdj(1.5, -500)).toBe(false);
  });

  it("fails gracefully for a pid that does not exist", () => {
    // 2^31 - 1 can never be a live pid; the write must fail closed.
    expect(setOomScoreAdj(2147483647, -500)).toBe(false);
  });

  it("protectCurrentProcessFromOomKiller never throws", () => {
    expect(() => protectCurrentProcessFromOomKiller()).not.toThrow();
  });
});
