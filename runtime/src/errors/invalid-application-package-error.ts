import type { RuntimeErrorCode } from "./runtime-error-code.js";
import { RuntimeError } from "./runtime-error.js";

export class InvalidApplicationPackageError extends RuntimeError {
  public readonly code: RuntimeErrorCode = "INVALID_APPLICATION_PACKAGE";

  public constructor(message: string) {
    super(`Invalid application package: ${message}`);
  }
}
