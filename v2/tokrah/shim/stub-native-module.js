// Stand-in for real react-native's BatchedBridge NativeModules (and
// BatchedBridge / MessageQueue). On the SevynOS host there is no
// native bridge: any native module is a Proxy whose methods are no-ops
// returning undefined (getConstants returns {}). The real
// NativeModules file exports a `default` object, so this stub does
// too — unlike TurboModuleRegistry, which has no default export (see
// stub-turbo-module-registry.js).
"use strict";

function makeModule() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Real RN's Dimensions module calls
        // NativeDeviceInfo.getConstants().Dimensions at load; the
        // host window is 800x500, so answer with that.
        if (prop === "getConstants")
          return () => ({
            Dimensions: {
              window: { width: 800, height: 500, scale: 1, fontScale: 1 },
              screen: { width: 800, height: 500, scale: 1, fontScale: 1 },
            },
          });
        if (prop === "then") return undefined;
        return () => undefined;
      },
    },
  );
}

module.exports = {
  get: () => makeModule(),
  getEnforcing: () => makeModule(),
  // BatchedBridge NativeModules shape.
  default: makeModule(),
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
