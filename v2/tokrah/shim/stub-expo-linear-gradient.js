const React = require("react");
// SevynOS M6 — expo-linear-gradient stub. Gradients are their first
// color as a solid fill (no gradient in the CPU painter).
function LinearGradient(props) {
  const colors = (props && props.colors) || ["#000000"];
  return React.createElement(
    "View",
    { style: [{ backgroundColor: colors[0] }, props && props.style] },
    props && props.children,
  );
}
module.exports = { LinearGradient, default: LinearGradient };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
