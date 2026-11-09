// SevynOS M6 experiment — hello-world entry through the shim.
// Renders a View + Text through the v2 renderer into the mock Sevyn
// (Node harness) or the real host (Hermes).
const React = require("react");
const { AppRegistry, View, Text, StyleSheet } = require("react-native");

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: "#ffffff", fontSize: 28 },
});

function Hello() {
  return React.createElement(
    View,
    { style: styles.root },
    React.createElement(Text, { style: styles.title }, "Hello from SevynOS M6"),
  );
}

AppRegistry.registerComponent("main", () => Hello);
AppRegistry.runApplication("main", {});
