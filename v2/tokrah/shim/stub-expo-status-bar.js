// SevynOS M6 — expo-status-bar stub. No status bar API on the host.
function StatusBar() {
  return null;
}
module.exports = { StatusBar, default: StatusBar };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
