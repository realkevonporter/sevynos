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

export type { ApplicationLifecycleController } from "./application/application-lifecycle-controller.js";

export type {
  ApplicationManagerDependencies,
  StartApplicationResult,
} from "./application/application-manager.js";

export { APPLICATION_MANIFEST_VERSION } from "./application/application-manifest.js";
export type {
  ApplicationId,
  ApplicationManifest,
  SupportedManifestVersion,
} from "./application/application-manifest.js";

export type { ApplicationPackage } from "./application/application-package.js";
export { ApplicationPackageRegistry } from "./application/application-package-registry.js";

export type {
  ApplicationModule,
  ApplicationModuleContext,
  ApplicationModuleInstance,
} from "./application/application-module.js";

export {
  InvalidApplicationManifestError,
  type ApplicationManifestField,
} from "./errors/invalid-application-manifest-error.js";

export { SevynRuntime } from "./runtime.js";
export type { RuntimeState } from "./runtime-state.js";

export {
  SevynRuntimeLogger,
  type LogContext,
  type LogLevel,
  type RuntimeLogger,
} from "./logger.js";

export { RUNTIME_IDENTITY, type RuntimeIdentity } from "./runtime-identity.js";

export { CapabilityDeniedError } from "./errors/capability-denied-error.js";
export { ProtectedApplicationError } from "./errors/protected-application-error.js";
export { InvalidSignatureError } from "./errors/invalid-signature-error.js";

export {
  createSevynBundle,
  extractSevynBundle,
  computeCrc32,
  type ExtractedSevynBundle,
  type SevynBundleInput,
} from "./application/application-bundle.js";

export {
  ApplicationInstaller,
  isOfficialSevynSignature,
  SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX,
  type InstalledApplicationRecord,
  type ApplicationInstallerOptions,
} from "./application/application-installer.js";

export {
  CapabilityPolicyManager,
  type CapabilityEvaluationState,
  type CapabilityName,
  type PermissionPromptHandler,
  type ApplicationManifestRegistration,
  type CapabilityPolicyManagerOptions,
} from "./security/capability-policy-manager.js";
