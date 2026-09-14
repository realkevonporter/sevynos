export type BuiltInDeviceClass =
  "desktop" | "laptop" | "tablet" | "mobile" | "tv" | "watch" | "automotive" | "xr";

export type DeviceClass = BuiltInDeviceClass | (string & {});

export interface DeviceDescriptor {
  readonly deviceClass: DeviceClass;
  readonly width: number;
  readonly height: number;
  readonly pointer: "none" | "coarse" | "fine";
  readonly keyboard: boolean;
  readonly touch: boolean;
  readonly capabilities?: readonly string[];
}

export interface DeviceProfileMatch {
  readonly deviceClasses: readonly DeviceClass[];
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
  readonly requiredCapabilities?: readonly string[];
}

export interface SystemApplicationMount {
  readonly applicationId: string;
  readonly slot: string;
  readonly layer: number;
  readonly optional?: boolean;
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface DeviceProfile {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly match: DeviceProfileMatch;
  readonly applications: readonly SystemApplicationMount[];
}

export function defineDeviceProfile(profile: DeviceProfile): DeviceProfile {
  requireIdentifier(profile.id, "profile");
  if (profile.name.trim() === "") throw new TypeError("A profile name is required.");
  if (!Number.isFinite(profile.priority))
    throw new TypeError("A profile priority must be finite.");
  if (profile.match.deviceClasses.length === 0)
    throw new TypeError(`Device profile "${profile.id}" must match a device class.`);

  const mountIds = new Set<string>();
  for (const mount of profile.applications) {
    requireIdentifier(mount.applicationId, "system application");
    requireIdentifier(mount.slot, "shell slot");
    if (!Number.isFinite(mount.layer))
      throw new TypeError(`Shell slot "${mount.slot}" must have a finite layer.`);
    if (mountIds.has(mount.applicationId))
      throw new TypeError(
        `Device profile "${profile.id}" mounts "${mount.applicationId}" more than once.`,
      );
    mountIds.add(mount.applicationId);
  }

  return Object.freeze({
    ...profile,
    match: Object.freeze({
      ...profile.match,
      deviceClasses: Object.freeze([...profile.match.deviceClasses]),
      ...(profile.match.requiredCapabilities === undefined
        ? {}
        : {
            requiredCapabilities: Object.freeze([...profile.match.requiredCapabilities]),
          }),
    }),
    applications: Object.freeze(
      profile.applications.map((mount) =>
        Object.freeze({
          ...mount,
          ...(mount.configuration === undefined
            ? {}
            : { configuration: Object.freeze({ ...mount.configuration }) }),
        }),
      ),
    ),
  });
}

export class DeviceProfileRegistry {
  readonly #profiles = new Map<string, DeviceProfile>();

  public register(profile: DeviceProfile): void {
    if (this.#profiles.has(profile.id))
      throw new Error(`Device profile "${profile.id}" is already registered.`);
    this.#profiles.set(profile.id, defineDeviceProfile(profile));
  }

  public get(profileId: string): DeviceProfile | undefined {
    return this.#profiles.get(profileId);
  }

  public list(): readonly DeviceProfile[] {
    return Object.freeze([...this.#profiles.values()]);
  }

  public select(device: DeviceDescriptor, requestedProfileId?: string): DeviceProfile {
    validateDevice(device);
    if (requestedProfileId !== undefined) {
      const requested = this.#profiles.get(requestedProfileId);
      if (requested === undefined)
        throw new Error(`Device profile "${requestedProfileId}" is not registered.`);
      return requested;
    }

    const selected = [...this.#profiles.values()]
      .filter((profile) => matchesDevice(profile.match, device))
      .sort((first, second) => second.priority - first.priority)[0];
    if (selected === undefined)
      throw new Error(`No shell profile supports device class "${device.deviceClass}".`);
    return selected;
  }
}

function matchesDevice(match: DeviceProfileMatch, device: DeviceDescriptor): boolean {
  if (!match.deviceClasses.includes(device.deviceClass)) return false;
  if (match.minimumWidth !== undefined && device.width < match.minimumWidth) return false;
  if (match.maximumWidth !== undefined && device.width > match.maximumWidth) return false;
  const capabilities = new Set(device.capabilities ?? []);
  return (match.requiredCapabilities ?? []).every((value) => capabilities.has(value));
}

function validateDevice(device: DeviceDescriptor): void {
  requireIdentifier(device.deviceClass, "device class");
  if (!Number.isFinite(device.width) || device.width <= 0)
    throw new TypeError("Device width must be positive and finite.");
  if (!Number.isFinite(device.height) || device.height <= 0)
    throw new TypeError("Device height must be positive and finite.");
}

function requireIdentifier(value: string, kind: string): void {
  if (value.trim() === "") throw new TypeError(`A ${kind} identifier is required.`);
}
