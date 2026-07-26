import type { RuntimeErrorCode } from "./runtime-error-code.js";

export abstract class RuntimeError extends Error {
  public abstract readonly code: RuntimeErrorCode;

  protected constructor(message: string) {
    super(message);

    this.name = new.target.name;
  }
}
