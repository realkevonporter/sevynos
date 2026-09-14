export class RenderLoopSchedulerAlreadyRunningError extends Error {
  public constructor() {
    super("Render-loop scheduler is already running.");

    this.name = "RenderLoopSchedulerAlreadyRunningError";
  }
}

export class RenderLoopSchedulerNotRunningError extends Error {
  public constructor() {
    super("Render-loop scheduler is not running.");

    this.name = "RenderLoopSchedulerNotRunningError";
  }
}

export class RenderLoopSchedulerStoppedError extends Error {
  public constructor() {
    super("Render-loop scheduler has already been stopped.");

    this.name = "RenderLoopSchedulerStoppedError";
  }
}
