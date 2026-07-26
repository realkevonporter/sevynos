export type {
  ApplicationDescriptor,
  ApplicationId,
} from "./application/application-descriptor.js";

export { ApplicationRegistry } from "./application/application-registry.js";

export { DuplicateApplicationError } from "./errors/duplicate-application-error.js";
export { RuntimeError } from "./errors/runtime-error.js";

export { ApplicationSession } from "./application/application-session.js";

export type {
  ApplicationSessionId,
  CreateApplicationSessionOptions,
} from "./application/application-session.js";

export {
  assertApplicationSessionTransition,
  canTransitionApplicationSession,
} from "./application/application-session-state.js";

export type { ApplicationSessionState } from "./application/application-session-state.js";

export { SessionRegistry } from "./application/session-registry.js";

export type { ApplicationHostId } from "./application/application-host-id.js";

export type {
  ApplicationHost,
  ApplicationHostStartResult,
} from "./application/application-host.js";

export { ApplicationHostRegistry } from "./application/application-host-registry.js";

export { ApplicationManager } from "./application/application-manager.js";

export type {
  ApplicationManagerDependencies,
  StartApplicationResult,
} from "./application/application-manager.js";

export { SevynRuntime } from "./runtime.js";
export type { RuntimeState } from "./runtime-state.js";

export {
  JsonRuntimeLogger,
  type LogContext,
  type LogLevel,
  type RuntimeLogger,
} from "./logger.js";

export { RUNTIME_IDENTITY, type RuntimeIdentity } from "./runtime-identity.js";
