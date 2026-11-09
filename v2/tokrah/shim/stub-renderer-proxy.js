// Stand-in for real react-native's RendererProxy / RendererImplementation
// / ReactFabric shim. On the SevynOS host there is no Fabric renderer:
// the v2 renderer (react-reconciler) is the only renderer, so any
// real-RN module that reaches for the Fabric host config gets a
// no-op stand-in instead of a module whose top level dereferences
// the `nativeFabricUIManager` global (which does not exist here).
// Finder methods answer null (matching the shim's findNodeHandle);
// command methods are no-ops.
"use strict";

function makeRendererProxy() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "__esModule") return undefined;
        if (prop === "then") return undefined;
        if (
          prop === "findNodeHandle" ||
          prop === "getNodeFromInternalInstanceHandle" ||
          prop === "getPublicInstanceFromInternalInstanceHandle" ||
          prop === "getNodeFromPublicInstance" ||
          prop === "findHostInstance_DEPRECATED"
        ) {
          return () => null;
        }
        return () => undefined;
      },
    },
  );
}

const proxy = makeRendererProxy();
module.exports = proxy;
module.exports.default = proxy;
