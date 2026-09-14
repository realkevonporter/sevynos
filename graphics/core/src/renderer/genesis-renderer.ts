import type { DisplayRenderPlan } from "../display/display-render-plan.js";
import type { RenderResult } from "./render-result.js";

export type RendererState = "created" | "initialized" | "shutdown";

export interface GenesisRenderer<TScene> {
  readonly state: RendererState;

  initialize(): void;

  render(plan: DisplayRenderPlan<TScene>): RenderResult;

  shutdown(): void;
}
