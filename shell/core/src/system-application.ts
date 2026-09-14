import type {
  DeviceDescriptor,
  DeviceProfile,
  SystemApplicationMount,
} from "./device-profile.js";

export type SystemApplicationStopReason =
  "profile-changed" | "hot-reload" | "shell-shutdown";

export interface ShellServiceClient {
  request<Result = unknown>(service: string, payload: unknown): Promise<Result>;
}

export interface SystemApplicationManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly roles: readonly string[];
  readonly supportedDeviceClasses: readonly string[];
}

export interface SystemApplicationContext {
  readonly device: DeviceDescriptor;
  readonly profile: DeviceProfile;
  readonly mount: SystemApplicationMount;
  readonly services: ShellServiceClient;
  readonly invalidate: () => void;
}

export interface SystemApplicationInstance<State = unknown> {
  start?(): void | Promise<void>;
  stop?(reason: SystemApplicationStopReason): void | Promise<void>;
  captureState?(): State;
  render?(input: unknown): unknown;
  readonly component?: unknown;
}

export interface SystemApplicationModule<State = unknown> {
  readonly manifest: SystemApplicationManifest;
  create(
    context: SystemApplicationContext,
    preservedState: State | undefined,
  ): SystemApplicationInstance<State>;
}

export function defineSystemApplication<State>(
  application: SystemApplicationModule<State>,
): SystemApplicationModule<State> {
  const { manifest } = application;
  if (manifest.id.trim() === "")
    throw new TypeError("A system application identifier is required.");
  if (manifest.name.trim() === "")
    throw new TypeError(`System application "${manifest.id}" requires a name.`);
  if (manifest.version.trim() === "")
    throw new TypeError(`System application "${manifest.id}" requires a version.`);
  if (manifest.roles.length === 0)
    throw new TypeError(`System application "${manifest.id}" requires a shell role.`);
  if (manifest.supportedDeviceClasses.length === 0)
    throw new TypeError(
      `System application "${manifest.id}" must support a device class.`,
    );

  const create: SystemApplicationModule<State>["create"] = (context, preservedState) =>
    application.create(context, preservedState);

  return Object.freeze({
    manifest: Object.freeze({
      ...manifest,
      roles: Object.freeze([...manifest.roles]),
      supportedDeviceClasses: Object.freeze([...manifest.supportedDeviceClasses]),
    }),
    create,
  });
}
