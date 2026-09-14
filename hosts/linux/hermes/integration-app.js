(() => {
  setTimeout(() => __sevynPostMessage(JSON.stringify({ type: "native-timer-fired" })), 5);
  const React = globalThis.__SEVYN_MODULES__.react;
  const { AppRegistry, Text, View } = globalThis.__SEVYN_MODULES__["react-native"];
  function Application() {
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
      const timer = setTimeout(() => setReady(true), 1);
      return () => clearTimeout(timer);
    }, []);
    return React.createElement(
      View,
      { accessibilityRole: "application" },
      React.createElement(Text, null, ready ? "Hermes timer ready" : "Hermes mounted"),
    );
  }
  AppRegistry.registerComponent("main", () => Application);
})();
