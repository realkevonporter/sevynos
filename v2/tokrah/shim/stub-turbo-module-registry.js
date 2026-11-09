// Stand-in for real react-native's TurboModuleRegistry. The real file
// has ONLY named exports (get / getEnforcing) — no default export — so
// this stub must not define one either: Babel's _interopNamespace
// copies `default` as a getter and then assigns it, which throws.
// Any turbo module resolves to a no-op Proxy module.
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
};
