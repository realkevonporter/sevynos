import { CapabilityDeniedError } from "../errors/capability-denied-error.js";

export type CapabilityEvaluationState = "granted" | "denied" | "ask" | "restricted";

export type CapabilityName =
  | "filesystem.read"
  | "filesystem.write"
  | "notifications"
  | "clipboard.read"
  | "clipboard.write"
  | "network"
  | "location"
  | "camera"
  | "microphone"
  | (string & {});

export type PermissionPromptHandler = (
  applicationId: string,
  capability: CapabilityName,
) => Promise<boolean> | boolean;

export interface ApplicationManifestRegistration {
  readonly id: string;
  readonly permissions?: readonly string[];
}

export interface CapabilityPolicyManagerOptions {
  readonly promptHandler?: PermissionPromptHandler | undefined;
  readonly systemAppPrefixes?: readonly string[];
  readonly sensitiveCapabilities?: readonly CapabilityName[];
}

const DEFAULT_SYSTEM_PREFIXES: readonly string[] = Object.freeze(["org.sevynos."]);

const DEFAULT_SENSITIVE_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "camera",
  "microphone",
  "location",
  "filesystem.write",
]);

export class CapabilityPolicyManager {
  private readonly appPolicies = new Map<
    string,
    Map<CapabilityName, CapabilityEvaluationState>
  >();
  private readonly declaredManifestPermissions = new Map<string, Set<CapabilityName>>();
  private promptHandler?: PermissionPromptHandler | undefined;
  private readonly systemPrefixes: readonly string[];
  private readonly sensitiveCapabilities: ReadonlySet<CapabilityName>;

  public constructor(options: CapabilityPolicyManagerOptions = {}) {
    this.promptHandler = options.promptHandler;
    this.systemPrefixes = options.systemAppPrefixes ?? DEFAULT_SYSTEM_PREFIXES;
    this.sensitiveCapabilities = new Set(
      options.sensitiveCapabilities ?? DEFAULT_SENSITIVE_CAPABILITIES,
    );
  }

  public setPromptHandler(handler: PermissionPromptHandler | undefined): void {
    this.promptHandler = handler;
  }

  public isSystemApplication(applicationId: string): boolean {
    return this.systemPrefixes.some((prefix) => applicationId.startsWith(prefix));
  }

  public registerApplication(manifest: ApplicationManifestRegistration): void {
    const permissions = new Set<CapabilityName>(manifest.permissions ?? []);
    this.declaredManifestPermissions.set(manifest.id, permissions);

    if (!this.appPolicies.has(manifest.id)) {
      this.appPolicies.set(manifest.id, new Map());
    }
  }

  public setPolicy(
    applicationId: string,
    capability: CapabilityName,
    state: CapabilityEvaluationState,
  ): void {
    let appMap = this.appPolicies.get(applicationId);
    if (!appMap) {
      appMap = new Map();
      this.appPolicies.set(applicationId, appMap);
    }
    appMap.set(capability, state);
  }

  public getExplicitPolicy(
    applicationId: string,
    capability: CapabilityName,
  ): CapabilityEvaluationState | undefined {
    return this.appPolicies.get(applicationId)?.get(capability);
  }

  public evaluate(
    applicationId: string,
    capability: CapabilityName,
  ): CapabilityEvaluationState {
    // 1. Check explicit policy override
    const explicit = this.getExplicitPolicy(applicationId, capability);
    if (explicit) {
      return explicit;
    }

    // 2. System applications have pre-granted permissions for anything declared or standard
    if (this.isSystemApplication(applicationId)) {
      return "granted";
    }

    // 3. Check declared manifest permissions
    const declared = this.declaredManifestPermissions.get(applicationId);
    if (declared?.has(capability)) {
      if (this.sensitiveCapabilities.has(capability)) {
        return "ask";
      }
      return "granted";
    }

    // 4. Undecorated undeclared capability
    return "denied";
  }

  public hasCapability(applicationId: string, capability: CapabilityName): boolean {
    return this.evaluate(applicationId, capability) === "granted";
  }

  public checkCapability(applicationId: string, capability: CapabilityName): void {
    const state = this.evaluate(applicationId, capability);
    if (state !== "granted") {
      throw new CapabilityDeniedError(
        applicationId,
        capability,
        `Application '${applicationId}' does not have permission '${capability}' (state: ${state}).`,
      );
    }
  }

  public async requestCapability(
    applicationId: string,
    capability: CapabilityName,
  ): Promise<boolean> {
    const currentState = this.evaluate(applicationId, capability);

    if (currentState === "granted") {
      return true;
    }

    if (currentState === "denied" || currentState === "restricted") {
      return false;
    }

    // State is "ask"
    if (this.promptHandler) {
      const allowed = await Promise.resolve(
        this.promptHandler(applicationId, capability),
      );
      const newState: CapabilityEvaluationState = allowed ? "granted" : "denied";
      this.setPolicy(applicationId, capability, newState);
      return allowed;
    }

    // No prompt handler available to grant permission
    return false;
  }

  public grant(applicationId: string, capability: CapabilityName): void {
    this.setPolicy(applicationId, capability, "granted");
  }

  public deny(applicationId: string, capability: CapabilityName): void {
    this.setPolicy(applicationId, capability, "denied");
  }

  public restrict(applicationId: string, capability: CapabilityName): void {
    this.setPolicy(applicationId, capability, "restricted");
  }

  public revoke(applicationId: string, capability: CapabilityName): void {
    this.appPolicies.get(applicationId)?.delete(capability);
  }

  public revokeAll(applicationId: string): void {
    this.appPolicies.delete(applicationId);
    this.declaredManifestPermissions.delete(applicationId);
  }
}
