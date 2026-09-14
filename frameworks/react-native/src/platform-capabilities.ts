import { getNativeAdapters } from "./native-adapter-contracts.js";

export type SevynReactNativeCapability =
  | "view"
  | "text"
  | "image"
  | "text-input"
  | "scroll-view"
  | "pressable"
  | "modal"
  | "switch"
  | "accessibility-metadata"
  | "pointer"
  | "touch"
  | "wheel"
  | "keyboard"
  | "network"
  | "websocket"
  | "clipboard-text"
  | "filesystem"
  | "notifications"
  | "camera"
  | "microphone"
  | "video"
  | "bluetooth"
  | "location"
  | "screen-capture";

const IMPLEMENTED = new Set<SevynReactNativeCapability>([
  "view",
  "text",
  "image",
  "text-input",
  "scroll-view",
  "pressable",
  "modal",
  "switch",
  "accessibility-metadata",
  "pointer",
  "touch",
  "wheel",
  "keyboard",
  "clipboard-text",
  "filesystem",
  "notifications",
]);

const NATIVE_CAPABILITY_ADAPTERS: Partial<
  Record<SevynReactNativeCapability, keyof ReturnType<typeof getNativeAdapters>>
> = {
  network: "networkInfo",
  websocket: "webSocket",
  camera: "camera",
  microphone: "microphone",
  video: "media",
  bluetooth: "bluetooth",
  location: "location",
};

function supported(feature: SevynReactNativeCapability): boolean {
  if (IMPLEMENTED.has(feature)) return true;
  const adapter = NATIVE_CAPABILITY_ADAPTERS[feature];
  return adapter !== undefined && getNativeAdapters()[adapter] !== undefined;
}

export class UnsupportedSevynFeatureError extends Error {
  public readonly code = "UnsupportedFeature" as const;

  public constructor(readonly feature: SevynReactNativeCapability) {
    super(
      `SevynOS does not currently support "${feature}" for React Native applications.`,
    );
    this.name = "UnsupportedSevynFeatureError";
  }
}

export const SevynOS = Object.freeze({
  supports(feature: SevynReactNativeCapability): boolean {
    return supported(feature);
  },
  require(feature: SevynReactNativeCapability): void {
    if (!supported(feature)) throw new UnsupportedSevynFeatureError(feature);
  },
  capabilities(): readonly SevynReactNativeCapability[] {
    return Object.freeze([
      ...IMPLEMENTED,
      ...Object.keys(NATIVE_CAPABILITY_ADAPTERS).filter((feature) =>
        supported(feature as SevynReactNativeCapability),
      ),
    ] as SevynReactNativeCapability[]);
  },
});
