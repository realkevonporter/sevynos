const React = require("react");
// SevynOS M6 — react-native-toast-message stub.
function Toast() {
  return null;
}
Toast.show = () => {};
Toast.hide = () => {};
module.exports = { default: Toast, Toast };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
