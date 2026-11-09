// SevynOS M6 — expo-constants stub.
const Constants = {
  expoConfig: {},
  expoRuntimeVersion: null,
  deviceName: "SevynOS",
  deviceYearClass: 2026,
  isDevice: true,
  platform: { sevyn: {} },
  systemFonts: [],
  manifest: {},
  manifest2: null,
  sessionId: "sevynos",
  appOwnership: "standalone",
  executionEnvironment: "standalone",
  statusBarHeight: 0,
};
module.exports = { default: Constants, Constants };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
