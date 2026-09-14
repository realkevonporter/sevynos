/** Public Sevyn application API. Additions are backward compatible within a major version. */
export const SEVYN_APPLICATION_API_VERSION = "1.1.0" as const;
export const SEVYN_APPLICATION_API_MAJOR = 1 as const;

export * from "./lifecycle.js";
export * from "./motion.js";
export * from "./primitives.js";
export * from "./sdk.js";
export * from "./tokens.js";
export * from "./stylesheet.js";
export * from "./application-platform.js";
export * from "./animated.js";
export * from "./utilities.js";
export * from "./vector-icons.js";
export * from "./context-menu.js";
export * from "./app-registry.js";
export * from "./platform-capabilities.js";
export * from "./pixel-ratio.js";
export * from "./appearance.js";
export * from "./accessibility.js";
export * from "./native-modules.js";
export * from "./native-adapter-contracts.js";
export * from "./websocket.js";
export * from "./upstream-compat.js";
export * from "./fabric.js";
export * from "./error-boundary.js";
export * from "./expo-modules-core.js";
export * from "./expo-compat.js";
export * from "./community-compat.js";

// Explicit re-exports to resolve ambiguity with standard React Native modules
export { Image, StatusBar } from "./primitives.js";
export { Clipboard, Linking } from "./utilities.js";
export { EventEmitter } from "./upstream-compat.js";
export { NetInfo } from "./native-modules.js";
export { CommunityNetInfo, useReducedMotion } from "./community-compat.js";
export { Platform } from "./expo-modules-core.js";
export {
  Image as ExpoImage,
  StatusBar as ExpoStatusBar,
  Clipboard as ExpoClipboard,
  Linking as ExpoLinking,
} from "./expo-compat.js";
export { EventEmitter as ExpoEventEmitter } from "./expo-modules-core.js";
