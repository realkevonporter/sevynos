const React = require("react");
// SevynOS M6 — expo-blur stub. Blur is a plain view (no blur in
// the CPU painter).
function BlurView(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
module.exports = { BlurView, default: BlurView };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
