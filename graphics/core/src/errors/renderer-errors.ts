export class RendererNotInitializedError extends Error {
  public constructor() {
    super("Renderer has not been initialized.");

    this.name = "RendererNotInitializedError";
  }
}

export class RendererAlreadyInitializedError extends Error {
  public constructor() {
    super("Renderer has already been initialized.");

    this.name = "RendererAlreadyInitializedError";
  }
}

export class RendererShutdownError extends Error {
  public constructor() {
    super("Renderer has already been shut down.");

    this.name = "RendererShutdownError";
  }
}
