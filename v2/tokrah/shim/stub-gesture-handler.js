// SevynOS M6 — react-native-gesture-handler stub.
// Gestures are inert on the SevynOS host (no gesture recogniser in
// the v2 renderer): detectors and swipeables render their children,
// taps still work through the host's Pressable hit-testing.
const React = require("react");

function GestureHandlerRootView(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function GestureDetector(props) {
  return React.createElement(React.Fragment, null, props && props.children);
}
function chainable() {
  const g = {
    onBegin: () => g,
    onStart: () => g,
    onUpdate: () => g,
    onEnd: () => g,
    onFinalize: () => g,
    onChange: () => g,
    enabled: () => g,
    runOnJS: () => g,
    withTestId: () => g,
    minDistance: () => g,
    maxDuration: () => g,
    numberOfTaps: () => g,
    numberOfPointers: () => g,
    direction: () => g,
    activeOffsetX: () => g,
    activeOffsetY: () => g,
    failOffsetX: () => g,
    failOffsetY: () => g,
    simultaneousWithExternalGesture: () => g,
    requireExternalGestureToFail: () => g,
    blocksExternalGesture: () => g,
    averageTouches: () => g,
    enableTrackpadTwoFingerGesture: () => g,
  };
  return g;
}
const Gesture = {
  Tap: () => chainable(),
  Pan: () => chainable(),
  Pinch: () => chainable(),
  Rotation: () => chainable(),
  LongPress: () => chainable(),
  Fling: () => chainable(),
  Native: () => chainable(),
  Manual: () => chainable(),
  Hover: () => chainable(),
  Race: (...gs) => chainable(),
  Simultaneous: (...gs) => chainable(),
  Exclusive: (...gs) => chainable(),
};
function Swipeable(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function ScrollView(props) {
  return React.createElement("ScrollView", props, props && props.children);
}
module.exports = {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  ScrollView,
  Swipeable,
};
