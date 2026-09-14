export class RenderLoopAlreadyRunningError extends Error {
  public constructor() {
    super("Render loop is already running.");

    this.name = "RenderLoopAlreadyRunningError";
  }
}

export class RenderLoopNotRunningError extends Error {
  public constructor() {
    super("Render loop is not running.");

    this.name = "RenderLoopNotRunningError";
  }
}

export class RenderLoopStoppedError extends Error {
  public constructor() {
    super("Render loop has already been stopped.");

    this.name = "RenderLoopStoppedError";
  }
}
