// SevynOS M6 — react-native-reanimated stub.
// Reanimated's JS entry installs a native worklet runtime at load, so
// the real package cannot load on the SevynOS host. This stub keeps
// its API surface: shared values hold their value synchronously,
// animations complete instantly, animated components are the host
// components. UI that animates renders its end state.
const React = require("react");

class SharedValue {
  constructor(v) {
    this.value = v;
    this._listeners = new Map();
    this._nextListenerId = 1;
  }
  // The real SharedValue is observable: effects subscribe with
  // addListener and unsubscribe with removeListener. The stub never
  // animates, so listeners are stored but never fired.
  addListener(listener) {
    const id = this._nextListenerId++;
    this._listeners.set(id, listener);
    return id;
  }
  removeListener(id) {
    this._listeners.delete(id);
  }
  modify(modifier) {
    this.value = modifier(this.value);
  }
}
const useSharedValue = (v) => {
  const ref = React.useRef(null);
  if (ref.current === null) ref.current = new SharedValue(v);
  return ref.current;
};
const useDerivedValue = (fn) => {
  const ref = React.useRef(null);
  if (ref.current === null) ref.current = new SharedValue(fn());
  else ref.current.value = fn();
  return ref.current;
};
const useAnimatedStyle = (fn) => fn();
const useAnimatedProps = (fn) => fn();
const useAnimatedReaction = () => {};
const useAnimatedRef = () => React.useRef(null);
const useAnimatedScrollHandler = () => () => {};
const useAnimatedGestureHandler = () => () => {};
const useAnimatedKeyboard = () => ({
  height: new SharedValue(0),
  state: new SharedValue("unknown"),
});
const useAnimatedSensor = () => ({
  sensor: { x: new SharedValue(0), y: new SharedValue(0), z: new SharedValue(0) },
});
const useFrameCallback = () => {};
const useReducedMotion = () => false;
const runOnJS = (fn) => fn;
const runOnUI = (fn) => fn;
const withTiming = (toValue) => toValue;
const withSpring = (toValue) => toValue;
const withDelay = (_d, v) => v;
const withSequence = (...vs) => vs[vs.length - 1];
const withRepeat = (v) => v;
const withDecay = (v) => v;
const cancelAnimation = () => {};
const interpolate = (v, _in, out) => (Array.isArray(out) ? out[0] : v);
const Extrapolation = { EXTEND: "extend", CLAMP: "clamp", IDENTITY: "identity" };
const Easing = {
  linear: (t) => t,
  ease: (t) => t,
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  bezier: () => (t) => t,
  in: (e) => e,
  out: (e) => e,
  inOut: (e) => e,
};
const FadeIn = { duration: () => FadeIn };
const FadeOut = { duration: () => FadeOut };
const SlideInDown = {};
const SlideOutDown = {};

const Animated = {
  View: "View",
  Text: "Text",
  Image: "Image",
  ScrollView: "ScrollView",
  FlatList: "ScrollView",
  createAnimatedComponent: (C) => C,
  useSharedValue,
  useDerivedValue,
  useAnimatedStyle,
};

module.exports = {
  default: Animated,
  Animated,
  useSharedValue,
  useDerivedValue,
  useAnimatedStyle,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedGestureHandler,
  useAnimatedKeyboard,
  useAnimatedSensor,
  useFrameCallback,
  useReducedMotion,
  runOnJS,
  runOnUI,
  withTiming,
  withSpring,
  withDelay,
  withSequence,
  withRepeat,
  withDecay,
  cancelAnimation,
  interpolate,
  Extrapolation,
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
  // Layout animations are inert objects on the stub.
  Layout: {},
  ZoomIn: {},
  ZoomOut: {},
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
