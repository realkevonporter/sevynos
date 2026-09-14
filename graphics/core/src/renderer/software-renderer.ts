import type { DisplayRenderPlan } from "../display/display-render-plan.js";
import type { GenesisRenderer, RendererState } from "./genesis-renderer.js";
import { RenderFrame } from "./render-frame.js";
import { RenderResult } from "./render-result.js";
import { RenderTarget } from "./render-target.js";
import {
  RendererAlreadyInitializedError,
  RendererNotInitializedError,
  RendererShutdownError,
} from "../errors/renderer-errors.js";

export interface SoftwareRenderRecord<TScene> {
  readonly frame: RenderFrame<TScene>;

  readonly commands: readonly string[];
}

export interface SoftwareRendererDependencies<TScene> {
  readonly now: () => Date;

  readonly buildCommands?: (scene: TScene) => readonly string[];
}

export class SoftwareRenderer<TScene> implements GenesisRenderer<TScene> {
  readonly #now: () => Date;

  readonly #buildCommands: (scene: TScene) => readonly string[];

  readonly #records: SoftwareRenderRecord<TScene>[] = [];

  #state: RendererState = "created";

  #nextFrameNumber = 1;

  public constructor(dependencies: SoftwareRendererDependencies<TScene>) {
    this.#now = dependencies.now;

    this.#buildCommands = dependencies.buildCommands ?? (() => []);
  }

  public get state(): RendererState {
    return this.#state;
  }

  public initialize(): void {
    if (this.#state === "initialized") {
      throw new RendererAlreadyInitializedError();
    }

    if (this.#state === "shutdown") {
      throw new RendererShutdownError();
    }

    this.#state = "initialized";
  }

  public render(plan: DisplayRenderPlan<TScene>): RenderResult {
    if (this.#state !== "initialized") {
      throw new RendererNotInitializedError();
    }

    const startedAt = this.#now();

    const target = new RenderTarget({
      displayId: plan.displayId,

      width: plan.displayMode.width,

      height: plan.displayMode.height,

      scaleFactor: plan.scaleFactor,
    });

    const frame = new RenderFrame({
      frameNumber: this.#nextFrameNumber,

      plan,

      target,

      startedAt,
    });

    const commands = [...this.#buildCommands(plan.scene)];

    this.#records.push({
      frame,
      commands,
    });

    const completedAt = this.#now();

    const result = new RenderResult({
      frameNumber: frame.frameNumber,

      displayId: frame.displayId,

      status: "rendered",

      startedAt,

      completedAt,

      commandCount: commands.length,
    });

    this.#nextFrameNumber += 1;

    return result;
  }

  public shutdown(): void {
    if (this.#state === "shutdown") {
      throw new RendererShutdownError();
    }

    this.#state = "shutdown";
  }

  public listRecords(): readonly SoftwareRenderRecord<TScene>[] {
    return [...this.#records];
  }
}
