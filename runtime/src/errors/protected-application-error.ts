import { RuntimeError } from "./runtime-error.js";

export class ProtectedApplicationError extends RuntimeError {
  public readonly code = "PROTECTED_APPLICATION" as const;

  public constructor(applicationId: string, reason?: string) {
    super(
      reason ??
        `Cannot uninstall protected system application "${applicationId}". Core system applications are protected to preserve system integrity and recovery.`,
    );
  }
}
