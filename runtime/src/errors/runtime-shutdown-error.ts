// runtime/src/errors/runtime-shutdown-error.ts

import type { ApplicationSessionId } from "../application/application-session.js";
import { RuntimeError } from "./runtime-error.js";

export interface RuntimeShutdownFailure {
  readonly sessionId: ApplicationSessionId;
  readonly error: unknown;
}

export class RuntimeShutdownError extends RuntimeError {
  public readonly code = "RUNTIME_SHUTDOWN_FAILED" as const;

  public readonly failures: readonly RuntimeShutdownFailure[];

  public constructor(failures: readonly RuntimeShutdownFailure[]) {
    super(
      `Runtime shutdown failed for ${String(failures.length)} application session(s).`,
    );

    this.failures = [...failures];
  }
}
