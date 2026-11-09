// SevynOS M6 — react-native-safe-area-context stub.
// No insets on the SevynOS host yet (the shell is fullscreen, apps
// are windowed with their own chrome): insets are zero, so content
// lays out against the full window.
const React = require("react");

const ZERO = { top: 0, bottom: 0, left: 0, right: 0 };
const FRAME = { x: 0, y: 0, width: 800, height: 500 };
// The real package exposes these contexts; @react-navigation/elements
// reads SafeAreaInsetsContext with React.use() — it must be a real
// context (use(undefined) throws React #438), not an absent export.
const SafeAreaInsetsContext = React.createContext(ZERO);
const SafeAreaFrameContext = React.createContext(FRAME);
const initialWindowMetrics = { insets: ZERO, frame: FRAME };
function SafeAreaProvider({ children }) {
  return React.createElement(
    SafeAreaFrameContext.Provider,
    { value: FRAME },
    React.createElement(SafeAreaInsetsContext.Provider, { value: ZERO }, children),
  );
}
function SafeAreaView(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function useSafeAreaInsets() {
  return React.useContext(SafeAreaInsetsContext) || ZERO;
}
function useSafeAreaFrame() {
  return React.useContext(SafeAreaFrameContext) || FRAME;
}
module.exports = {
  SafeAreaProvider,
  SafeAreaView,
  SafeAreaInsetsContext,
  SafeAreaFrameContext,
  initialWindowMetrics,
  useSafeAreaInsets,
  useSafeAreaFrame,
  default: SafeAreaProvider,
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
