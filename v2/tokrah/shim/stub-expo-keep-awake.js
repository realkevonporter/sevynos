// SevynOS M6 — expo-keep-awake stub.
function useKeepAwake() {}
module.exports = {
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => {},
  useKeepAwake,
  default: useKeepAwake,
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
