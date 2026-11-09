// SevynOS M6 — `expo-glass-effect` stub (Apple Liquid Glass). There
// is no such native module on the SevynOS host, so the glass
// containers render as plain Views and the availability checks
// answer false.
"use strict";
const React = require("react");

function GlassView(props) {
  return React.createElement("View", props);
}
function GlassContainer(props) {
  return React.createElement("View", props);
}

module.exports = {
  GlassView,
  GlassContainer,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
};
