const React = require("react");
// SevynOS M6 — expo-symbols stub. SF Symbols are text glyphs.
function SymbolView(props) {
  return React.createElement(
    "Text",
    { style: [{ fontSize: (props && props.size) || 20 }, props && props.style] },
    (props && props.name) || "?",
  );
}
const SymbolWeight = {
  Ultralight: "ultralight",
  Thin: "thin",
  Light: "light",
  Regular: "regular",
  Medium: "medium",
  Semibold: "semibold",
  Bold: "bold",
  Heavy: "heavy",
  Black: "black",
};
module.exports = { SymbolView, SymbolWeight, default: SymbolView };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
