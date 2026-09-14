import type { RenderLoopTickResult } from "./genesis-render-loop.js";

/**
 * Narrow internal contract used by render-loop schedulers.
 *
 * Application code should interact with GenesisRenderLoop through
 * requestFrame(). Schedulers use this interface to drive ticks.
 */
export interface RenderLoopFrameDriver {
  tick(): RenderLoopTickResult;
}
