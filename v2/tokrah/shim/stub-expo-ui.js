const React = require("react");
// SevynOS M6 — @expo/ui stub. SwiftUI views render as plain views.
function V(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function T(props) {
  return React.createElement(
    "Text",
    { style: props && props.style },
    props && props.children,
  );
}
function Button(props) {
  return React.createElement(
    "Pressable",
    { onPress: props && props.onPress, style: props && props.style },
    props && props.children,
  );
}
function DateTimePicker() {
  return null;
}
module.exports = {
  View: V,
  Text: T,
  Button,
  DateTimePicker,
  VStack: V,
  HStack: V,
  Spacer: V,
  Image: V,
  List: V,
  Section: V,
  TextField: V,
  Toggle: V,
  Slider: V,
  ProgressView: V,
  default: V,
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
