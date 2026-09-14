import { RuntimeError } from "./runtime-error.js";
import type { RuntimeErrorCode } from "./runtime-error-code.js";

export type ApplicationManifestField =
  | "manifestVersion"
  | "id"
  | "name"
  | "version"
  | "hostId"
  | "entrypoint"
  | "permissions"
  | "signature"
  | "system"
  | "manifest";

export class InvalidApplicationManifestError extends RuntimeError {
  public readonly code: RuntimeErrorCode = "INVALID_APPLICATION_MANIFEST";

  public readonly field: ApplicationManifestField;

  public constructor(field: ApplicationManifestField, message: string) {
    super(`Invalid application manifest field "${field}": ${message}`);

    this.name = "InvalidApplicationManifestError";
    this.field = field;
  }
}
