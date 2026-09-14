import {
  RenderResult,
  type DisplayRenderPlan,
  type GenesisRenderer,
  type RendererState,
} from "@sevynos/graphics";
import type { DesktopScene } from "@sevynos/desktop-shell";

export interface HeadlessFrameSnapshot {
  readonly displays: readonly Readonly<{
    displayId: string;
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
    nodeKinds: readonly string[];
  }>[];
}

export class HeadlessGenesisRenderer implements GenesisRenderer<DesktopScene> {
  public state: RendererState = "created";
  readonly #displays = new Map<
    string,
    HeadlessFrameSnapshot["displays"][number]
  >();
  #frameNumber = 0;
  public initialize(): void {
    this.state = "initialized";
  }
  public render(plan: DisplayRenderPlan<DesktopScene>): RenderResult {
    if (this.state !== "initialized")
      throw new Error("Headless renderer is not initialized.");
    this.#frameNumber += 1;
    this.#displays.set(
      plan.displayId,
      Object.freeze({
        displayId: plan.displayId,
        bounds: Object.freeze({ ...plan.displayBounds }),
        nodeKinds: Object.freeze(plan.scene.nodes.map((node) => node.kind)),
      }),
    );
    return new RenderResult({
      frameNumber: this.#frameNumber,
      displayId: plan.displayId,
      status: "rendered",
      startedAt: new Date(0),
      completedAt: new Date(0),
      commandCount: plan.scene.nodes.length,
    });
  }
  public shutdown(): void {
    this.state = "shutdown";
  }
  public snapshot(): HeadlessFrameSnapshot {
    return Object.freeze({
      displays: Object.freeze([...this.#displays.values()]),
    });
  }
}
