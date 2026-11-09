// SevynOS M6 — Metro config for bundling Tokrah.
//
// Tokrah is consumed as-is from its own repo (never copied into this
// one): TOKRAH_SRC is the Tokrah repo root (the dir holding tokrah/ +
// api/). The SevynOS entry + shim live in v2/tokrah and are added as
// watch folders. The resolver aliases react-native to the SevynOS
// compat shim and native modules to stubs where the host has no
// adapter (see v2/tokrah/README.md for the full list and the rules
// for adding one).
//
// Dogfooding rule: Metro resolves against Tokrah's own node_modules
// plus the v2 renderer's react copies — nothing is hoisted into this
// monorepo's pnpm catalog.
const path = require("path");

const TOKRAH_SRC = process.env.TOKRAH_SRC;
if (!TOKRAH_SRC) {
  throw new Error(
    "v2/tokrah/metro.config.js needs TOKRAH_SRC (Tokrah repo root — " +
      "the dir holding tokrah/ + api/). CI clones realkevonporter/tokrah " +
      "with the TOKRAH_READ_TOKEN secret; locally point it at your checkout.",
  );
}
const TOKRAH_ROOT = path.join(TOKRAH_SRC, "tokrah");
// The sevynos repo root (two levels up from v2/tokrah).
const SEVYNOS_ROOT = path.resolve(__dirname, "../..");
const V2_DIR = path.join(SEVYNOS_ROOT, "v2");
const TOKRAH_DIR = __dirname;
// projectRoot is the common ancestor of the two checkouts (Metro joins
// the entry path to it); the crawl is limited to watchFolders below.
const WORKSPACE_ROOT = path.resolve(SEVYNOS_ROOT, "..");

const { getDefaultConfig } = require(
  path.join(TOKRAH_ROOT, "node_modules/@expo/metro-config"),
);

const SHIM_DIR = path.join(TOKRAH_DIR, "shim");
const SHIM = path.join(SHIM_DIR, "react-native.js");
const REACT = path.join(V2_DIR, "apps/node_modules/react");
const RECONCILER = path.join(V2_DIR, "apps/node_modules/react-reconciler");
const GENERIC = path.join(SHIM_DIR, "stub-generic.js");

// Dedicated stubs (the mount path calls these for real).
const DEDICATED = {
  "react-native-reanimated": "stub-reanimated.js",
  "react-native-gesture-handler": "stub-gesture-handler.js",
  "react-native-safe-area-context": "stub-safe-area.js",
  "expo-image": "stub-expo-image.js",
  "@gorhom/bottom-sheet": "stub-bottom-sheet.js",
  "@legendapp/list": "stub-legend-list.js",
  "expo-secure-store": "stub-expo-secure-store.js",
  "expo-constants": "stub-expo-constants.js",
  "expo-linking": "stub-expo-linking.js",
  "expo-widgets": "stub-expo-widgets.js",
  "react-native-vision-camera": "stub-vision-camera.js",
  "expo-glass-effect": "stub-expo-glass-effect.js",
  "expo-font": "stub-expo-font.js",
  "expo-splash-screen": "stub-expo-splash-screen.js",
  "expo-haptics": "stub-expo-haptics.js",
  "expo-crypto": "stub-expo-crypto.js",
  "expo-clipboard": "stub-expo-clipboard.js",
  "expo-device": "stub-expo-device.js",
  "expo-location": "stub-expo-location.js",
  "expo-file-system": "stub-expo-file-system.js",
  "expo-file-system/legacy": "stub-expo-file-system.js",
  "expo-media-library": "stub-expo-media-library.js",
  "expo-media-library/legacy": "stub-expo-media-library.js",
  "expo-image-picker": "stub-expo-image-picker.js",
  "expo-document-picker": "stub-expo-document-picker.js",
  "expo-notifications": "stub-expo-notifications.js",
  "expo-blur": "stub-expo-blur.js",
  "expo-linear-gradient": "stub-expo-linear-gradient.js",
  "expo-symbols": "stub-expo-symbols.js",
  "expo-status-bar": "stub-expo-status-bar.js",
  "expo-video": "stub-expo-video.js",
  "expo-audio": "stub-expo-audio.js",
  "expo-task-manager": "stub-expo-task-manager.js",
  "expo-sharing": "stub-expo-sharing.js",
  "expo-background-task": "stub-expo-background-task.js",
  "expo-tracking-transparency": "stub-expo-tracking-transparency.js",
  "expo-iap": "stub-expo-iap.js",
  "expo-web-browser": "stub-expo-web-browser.js",
  "expo-screen-capture": "stub-expo-screen-capture.js",
  "expo-keep-awake": "stub-expo-keep-awake.js",
  "@expo/vector-icons": "stub-vector-icons.js",
  "@expo/ui": "stub-expo-ui.js",
  "@expo/ui/swift-ui": "stub-expo-ui.js",
  "@expo/ui/swift-ui/modifiers": "stub-expo-ui.js",
  "@expo/ui/community/datetime-picker": "stub-expo-ui.js",
  "@livekit/react-native": "stub-livekit.js",
  "@livekit/react-native-webrtc": "stub-livekit.js",
  "react-native-callkeep": "stub-callkeep.js",
  "react-native-toast-message": "stub-toast-message.js",
  "react-native-google-mobile-ads": "stub-google-mobile-ads.js",
  expo: "stub-expo.js",
  "@react-native-firebase/messaging": "stub-firebase-messaging.js",
};

// Native packages the mount path only touches at load time (or not
// at all): the generic stub (renders children, no-ops calls).
const GENERIC_PKGS = [
  "react-native-webview",
  "react-native-qrcode-svg",
  "@stripe/stripe-react-native",
  "@react-native-community/netinfo",
  "@maplibre/maplibre-react-native",
  "react-native-voip-push-notification",
  "react-native-video-trim",
  "react-native-wallet-manager",
  "react-native-view-shot",
  "react-native-sortables",
  "react-native-pager-view",
  "react-native-image-viewing",
  "react-native-svg",
  "@ptomasroos/react-native-multi-slider",
  "rn-swiper-list",
  "react-native-ar-effects",
  "@react-native-firebase/app",
  "@bsky.app/expo-image-crop-tool",
  // react-native-screens ships .ios/.android files with no .native
  // fallback and native view configs the shim cannot serve; expo-router
  // only needs its Screen/ScreenContainer wrappers (children pass
  // through the generic stub).
  "react-native-screens",
];

const config = getDefaultConfig(WORKSPACE_ROOT);
// The Expo config pre-runs react-native's InitializeCore and ships
// the @react-native/js-polyfills — both assume a native bridge
// (__fbBatchedBridgeConfig) and throw at load on the SevynOS host.
// The shim's env.js replaces them: no pre-modules, no RN polyfills.
// (Metro's own module system polyfill still prepends; that one is
// bridge-free.)
config.serializer.getModulesRunBeforeMainModule = () => [];
config.serializer.getPolyfills = () => [];
config.watchFolders = [
  TOKRAH_ROOT,
  TOKRAH_DIR,
  // The shim requires the v2 renderer + the react/react-reconciler
  // copies the renderer was built against — they must be watched too.
  V2_DIR,
];
config.resolver = config.resolver || {};
config.resolver.platforms = ["sevyn", "native"];
// Files outside the Tokrah tree (the shim, the v2 renderer) resolve
// their deps by walking up from their own location — which never
// reaches Tokrah's node_modules. These extra lookup paths fix that
// (they are also where @babel/runtime's helpers come from).
config.resolver.nodeModulesPaths = [
  path.join(TOKRAH_ROOT, "node_modules"),
  path.join(V2_DIR, "apps/node_modules"),
];
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Tokrah's tsconfig maps `@/*` -> `./*` (project root). Metro has
  // no tsconfig-paths support and neither the Expo config nor the
  // preset rewrites the specifier, so the SevynOS resolver applies
  // the alias itself — the same mapping the typechecker uses.
  if (moduleName === "@" || moduleName.startsWith("@/")) {
    const rel = moduleName === "@" ? "" : moduleName.slice(2);
    const candidate = path.join(TOKRAH_ROOT, rel);
    const resolved = defaultResolve
      ? defaultResolve(context, candidate, platform)
      : context.resolveRequest(context, candidate, platform);
    return resolved;
  }
  if (moduleName === "react-native") {
    return { type: "sourceFile", filePath: SHIM };
  }
  if (moduleName === "react" || moduleName === "react/jsx-runtime") {
    return {
      type: "sourceFile",
      filePath:
        moduleName === "react"
          ? path.join(REACT, "index.js")
          : path.join(REACT, "jsx-runtime.js"),
    };
  }
  if (moduleName === "react-reconciler") {
    return { type: "sourceFile", filePath: path.join(RECONCILER, "index.js") };
  }
  // Deep react-native core-setup paths: @expo/metro-runtime imports
  // 'react-native/Libraries/Core/InitializeCore' explicitly (it does
  // not trust getModulesRunBeforeMainModule). On real RN that runs the
  // bridge setup; on SevynOS it throws (__fbBatchedBridgeConfig) and
  // drags in 200+ real-RN files. The shim provides the environment.
  // NOTE: relative imports (e.g. TurboModuleRegistry's
  // require('../BatchedBridge/NativeModules')) arrive here as relative
  // specifiers, so the substitution happens AFTER resolution below —
  // this bare-name check is only the fast path.
  if (moduleName === "react-native/Libraries/Core/InitializeCore") {
    return { type: "sourceFile", filePath: path.join(SHIM_DIR, "stub-empty.js") };
  }
  if (DEDICATED[moduleName]) {
    return { type: "sourceFile", filePath: path.join(SHIM_DIR, DEDICATED[moduleName]) };
  }
  if (GENERIC_PKGS.includes(moduleName)) {
    return { type: "sourceFile", filePath: GENERIC };
  }
  // Resolve, then substitute deep native-module machinery files:
  // real packages import these by relative path too, so a specifier
  // check alone never matches them. On the host there is no bridge —
  // serve no-op module Proxies so the load never throws
  // (__fbBatchedBridgeConfig) and calls return undefined instead of
  // crashing the mount.
  const resolved = defaultResolve
    ? defaultResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
  const fp = resolved && resolved.filePath ? resolved.filePath : "";
  const rn = "/node_modules/react-native/";
  const tail = fp.includes(rn) ? fp.slice(fp.indexOf(rn) + rn.length) : "";
  if (tail === "Libraries/Core/InitializeCore.js") {
    return { type: "sourceFile", filePath: path.join(SHIM_DIR, "stub-empty.js") };
  }
  if (tail === "Libraries/TurboModule/TurboModuleRegistry.js") {
    return {
      type: "sourceFile",
      filePath: path.join(SHIM_DIR, "stub-turbo-module-registry.js"),
    };
  }
  // The real Fabric renderer: its host config dereferences the
  // `nativeFabricUIManager` global at load, which does not exist on
  // the SevynOS host (the v2 renderer is the only renderer). Any
  // real-RN module that reaches for it gets a no-op stand-in.
  if (
    tail === "Libraries/ReactNative/RendererProxy.js" ||
    tail === "Libraries/ReactNative/RendererImplementation.js" ||
    tail === "Libraries/Renderer/shims/ReactFabric.js"
  ) {
    return {
      type: "sourceFile",
      filePath: path.join(SHIM_DIR, "stub-renderer-proxy.js"),
    };
  }
  if (
    tail === "Libraries/BatchedBridge/NativeModules.js" ||
    tail === "Libraries/BatchedBridge/BatchedBridge.js" ||
    tail === "Libraries/BatchedBridge/MessageQueue.js"
  ) {
    return { type: "sourceFile", filePath: path.join(SHIM_DIR, "stub-native-module.js") };
  }
  // engine.io-client WebSocket transport: the host has no WebSocket
  // (a real host adapter is a later milestone, not M6). engine.io
  // uses transports[0] for the initial connect and never falls back
  // to the next transport when it fails — a present-but-broken WS
  // class makes the socket retry WebSocket forever and never try
  // polling. The stub exports no WS class, so the Socket's filter
  // drops "websocket" and polling (the shim's XHR) is the initial
  // transport. Must run before the .node.js remap below (the
  // transport is required as websocket.node.js and remapped to
  // websocket.js).
  if (
    fp.includes("engine.io-client/") &&
    /\/transports\/websocket(\.node)?\.js$/.test(fp)
  ) {
    return {
      type: "sourceFile",
      filePath: path.join(SHIM_DIR, "stub-engineio-websocket.js"),
    };
  }
  // Browser-field remap for Node-variant files: packages that ship a
  // `.node.js` file (engine.io-client's polling-xhr.node.js,
  // websocket.node.js, globals.node.js) declare the browser sibling
  // in their package.json `browser` field, but Metro does not apply
  // that mapping for the platform here — it bundles the Node variant,
  // whose XHR is xmlhttprequest-ssl (needs Node's `http`, absent in
  // Hermes), so the socket.io handshake never fires and the client
  // times out after 20s with no request ever leaving the host. The
  // SevynOS host is a browser-like environment: prefer the `.js`
  // sibling whenever one exists next to a `.node.js` resolution.
  if (fp.endsWith(".node.js")) {
    const sibling = fp.slice(0, -".node.js".length) + ".js";
    try {
      require("fs").accessSync(sibling);
      return { type: "sourceFile", filePath: sibling };
    } catch (e) {
      // No browser sibling — keep the Node variant.
    }
  }
  return resolved;
};

module.exports = config;
