// SevynOS M6 — react-native compatibility shim (v1).
//
// Implements the React Native API surface Tokrah's mount path uses,
// backed by the v2 renderer's host components (View/Text/Image/
// Pressable/ScrollView/TextInput — the same string tags the stock
// apps use; see v2/apps/src/host.ts). Anything the renderer does not
// implement is a functional stub: it renders as the closest host
// component (or nothing) and never throws at load or call time, so
// Tokrah's code can mount. Real behaviour for a surface lands when a
// flow needs it — the harness's next crash decides what that is.
//
// A Proxy fallback covers exports the shim forgot: any unknown named
// import resolves to a stub function (a component that renders null),
// so a missing export is a visible gap, never a load failure.
const renderer = require("../../rn/renderer/sevyn-renderer.js");
const React = require("react");

// ---------------------------------------------------------------- AppRegistry
const registered = new Map();
let wrapperProvider = null;
const AppRegistry = {
  registerComponent(name, getComponent) {
    registered.set(name, getComponent);
    return name;
  },
  getComponent(name) {
    return registered.get(name);
  },
  setWrapperComponentProvider(provider) {
    wrapperProvider = provider;
  },
  runApplication(name, { initialProps = {} } = {}) {
    const getComponent = registered.get(name);
    if (!getComponent) throw new Error(`AppRegistry: no component '${name}'`);
    let Component = getComponent();
    if (wrapperProvider) {
      const Wrap = wrapperProvider({ appKey: name });
      const Inner = Component;
      Component = (props) =>
        React.createElement(Wrap, null, React.createElement(Inner, props));
    }
    renderer.render(React.createElement(Component, initialProps), {
      width: windowWidth(),
      height: windowHeight(),
      backgroundColor: "#f9fafb",
    });
    return { rootTag: 1 };
  },
};

// Window size: the host publishes its real window on Sevyn.width /
// Sevyn.height (the headless Tokrah runs use a taller window so the
// login screen fits without scrolling). The Node harness has no
// Sevyn global, so fall back to the default 800x500 window.
function windowWidth() {
  const s = typeof Sevyn !== "undefined" ? Sevyn : null;
  return s && typeof s.width === "number" ? s.width : 800;
}
function windowHeight() {
  const s = typeof Sevyn !== "undefined" ? Sevyn : null;
  return s && typeof s.height === "number" ? s.height : 500;
}

// ---------------------------------------------------------------- StyleSheet
function flattenStyle(style) {
  if (style == null) return {};
  if (Array.isArray(style)) {
    const out = {};
    for (const s of style) Object.assign(out, flattenStyle(s));
    return out;
  }
  return style;
}
const StyleSheet = {
  create(styles) {
    return styles;
  },
  flatten: flattenStyle,
  compose(a, b) {
    return [flattenStyle(a), flattenStyle(b)];
  },
  hairlineWidth: 1,
  absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFillObject: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};

const Platform = {
  OS: "sevyn",
  Version: 1,
  select(obj) {
    if (obj == null) return undefined;
    if ("sevyn" in obj) return obj.sevyn;
    if ("native" in obj) return obj.native;
    if ("default" in obj) return obj.default;
    return obj.ios;
  },
};

const Dimensions = {
  get() {
    return {
      width: windowWidth(),
      height: windowHeight(),
      scale: 1,
      fontScale: 1,
    };
  },
  addEventListener() {
    return { remove() {} };
  },
  removeEventListener() {},
};
const PixelRatio = {
  get: () => 1,
  getFontScale: () => 1,
  getPixelSizeForLayoutSize: (n) => Math.round(n),
  roundToNearestPixel: (n) => Math.round(n),
};
const Appearance = {
  getColorScheme: () => "light",
  addChangeListener: () => ({ remove() {} }),
  removeChangeListener: () => {},
};
const useColorScheme = () => "light";
const useWindowDimensions = () => ({
  width: windowWidth(),
  height: windowHeight(),
  scale: 1,
  fontScale: 1,
});

function stubFn(name) {
  const fn = () => undefined;
  // Non-enumerable: Object.keys() on a stub must be [] — expo-modules-
  // core enumerates NativeUnimoduleProxy.exportedMethods at load, and
  // an enumerable marker property made it iterate a phantom module
  // whose .forEach is not a function.
  Object.defineProperty(fn, "__sevynStub", { value: name, enumerable: false });
  return fn;
}

// One native module stand-in: property access returns a no-op
// function, so `NativeModules.Foo.bar()` never throws at load or
// call time.
function makeNativeModuleProxy(moduleName) {
  return new Proxy(
    {},
    {
      get(_t2, prop) {
        if (prop === "__esModule" || (typeof prop === "string" && prop.startsWith("$$")))
          return undefined;
        return stubFn(`NativeModules.${String(moduleName)}.${String(prop)}`);
      },
    },
  );
}

// Any native module: property access returns a no-op function, so
// `NativeModules.Foo.bar()` never throws at load or call time.
const NativeModules = new Proxy(
  {},
  {
    get(_t, moduleName) {
      if (moduleName === "__esModule") return undefined;
      return makeNativeModuleProxy(moduleName);
    },
  },
);

class NativeEventEmitter {
  constructor() {}
  addListener() {
    return { remove() {} };
  }
  removeListener() {}
  removeAllListeners() {}
}

const UIManager = {
  hasViewManagerConfig: () => false,
  getViewManagerConfig: () => undefined,
  measure: (_node, cb) => cb && cb(0, 0, 0, 0, 0, 0),
  measureInWindow: (_node, cb) => cb && cb(0, 0, 0, 0),
  measureLayout: (_node, _rel, _err, cb) => cb && cb(0, 0, 0, 0),
};
const findNodeHandle = () => null;

const Alert = {
  alert: (title, message) => {
    if (typeof Sevyn !== "undefined" && Sevyn.log)
      Sevyn.log(`[alert] ${title}: ${message || ""}`);
  },
  prompt: () => {},
};
const Linking = {
  openURL: () => Promise.resolve(),
  canOpenURL: () => Promise.resolve(false),
  getInitialURL: () => Promise.resolve(null),
  addEventListener: () => ({ remove() {} }),
  removeEventListener: () => {},
};
const Share = {
  share: () => Promise.resolve({ action: "dismissedActivity" }),
  dismiss: () => {},
};
const BackHandler = {
  addEventListener: () => ({ remove() {} }),
  removeEventListener: () => {},
  exitApp: () => {},
};
const AppState = {
  currentState: "active",
  addEventListener: () => ({ remove() {} }),
  removeEventListener: () => {},
};
const Keyboard = {
  addListener: () => ({ remove() {} }),
  removeListener: () => {},
  dismiss: () => {},
  isVisible: () => false,
};
const I18nManager = {
  isRTL: false,
  allowRTL: () => {},
  forceRTL: () => {},
  swapLeftAndRightInRTL: (v) => v,
  doLeftAndRightSwapInRTL: false,
  // @react-navigation/native reads the RTL constants through
  // getConstants() at NavigationContainer render time.
  getConstants: () => ({ isRTL: false, doLeftAndRightSwapInRTL: false }),
};
const LogBox = { ignoreLogs: () => {}, ignoreAllLogs: () => {} };
const AccessibilityInfo = {
  isScreenReaderEnabled: () => Promise.resolve(false),
  isReduceMotionEnabled: () => Promise.resolve(false),
  addEventListener: () => ({ remove() {} }),
  removeEventListener: () => {},
  announceForAccessibility: () => {},
};
const PanResponder = {
  create: () => ({ panHandlers: {} }),
};
const Easing = {
  linear: (t) => t,
  ease: (t) => t,
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  poly: (n) => (t) => Math.pow(t, n),
  sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
  circle: (t) => 1 - Math.sqrt(1 - t * t),
  exp: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  elastic: (b) => (t) => t,
  back: (s) => (t) => t,
  bounce: (t) => t,
  bezier: () => (t) => t,
  in: (e) => e,
  out: (e) => e,
  inOut: (e) => e,
};

// Animated: values resolve to their initial value immediately; every
// animation completes synchronously. UI that animates simply renders
// its end state — correct for the mount proof, wrong for motion.
class AnimatedValue {
  constructor(v) {
    this._value = v;
    this._offset = 0;
    this.__isAnimated = true;
    this._listeners = new Map();
    this._nextListenerId = 1;
  }
  setValue(v) {
    this._value = v;
  }
  setOffset(o) {
    this._offset = o;
  }
  flattenOffset() {
    this._value += this._offset;
    this._offset = 0;
  }
  extractOffset() {
    this._offset = this._value;
    this._value = 0;
  }
  stopAnimation() {}
  resetAnimation() {
    this._value = 0;
    this._offset = 0;
  }
  addListener(cb) {
    const id = String(this._nextListenerId++);
    this._listeners.set(id, cb);
    return id;
  }
  removeListener(id) {
    this._listeners.delete(id);
  }
  removeAllListeners() {
    this._listeners.clear();
  }
  __getValue() {
    return this._value + this._offset;
  }
  interpolate(config) {
    return new AnimatedValue(config.outputRange ? config.outputRange[0] : this._value);
  }
}
function animEnd(v) {
  return {
    start(cb) {
      if (typeof cb === "function") cb({ finished: true });
    },
    stop() {},
    reset() {},
  };
}
// Numeric value of an Animated node or a plain number (composition
// helpers evaluate once against the current static value).
function numOf(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v.__getValue === "function") return v.__getValue();
  if (typeof v._value === "number") return v._value;
  return 0;
}
const Animated = {
  Value: AnimatedValue,
  ValueXY: class {
    constructor(v) {
      this.x = new AnimatedValue(v ? v.x : 0);
      this.y = new AnimatedValue(v ? v.y : 0);
    }
    setValue(v) {
      if (v) {
        this.x.setValue(v.x);
        this.y.setValue(v.y);
      }
    }
    setOffset(o) {
      if (o) {
        this.x.setOffset(o.x);
        this.y.setOffset(o.y);
      }
    }
    flattenOffset() {
      this.x.flattenOffset();
      this.y.flattenOffset();
    }
    extractOffset() {
      this.x.extractOffset();
      this.y.extractOffset();
    }
    stopAnimation() {
      this.x.stopAnimation();
      this.y.stopAnimation();
    }
    resetAnimation() {
      this.x.resetAnimation();
      this.y.resetAnimation();
    }
    addListener(cb) {
      const id = `xy:${this.x.addListener(({ value }) => cb({ x: value, y: this.y._value }))}`;
      this.y.addListener(({ value }) => cb({ x: this.x._value, y: value }));
      return id;
    }
    removeListener() {}
    removeAllListeners() {
      this.x.removeAllListeners();
      this.y.removeAllListeners();
    }
    getLayout() {
      return { left: this.x, top: this.y };
    }
    getTranslateTransform() {
      return [{ translateX: this.x }, { translateY: this.y }];
    }
  },
  timing: (value, config) => {
    if (
      value &&
      typeof value.setValue === "function" &&
      config &&
      config.toValue !== undefined
    )
      value.setValue(config.toValue);
    return animEnd();
  },
  spring: (value, config) => {
    if (
      value &&
      typeof value.setValue === "function" &&
      config &&
      config.toValue !== undefined
    )
      value.setValue(config.toValue);
    return animEnd();
  },
  decay: () => animEnd(),
  sequence: (anims) => animEnd(),
  parallel: (anims, _config) => animEnd(),
  stagger: (_t, anims) => animEnd(),
  delay: () => animEnd(),
  loop: (anim) => anim,
  event: () => () => {},
  // Composition: navigation interpolates screen progress with these.
  // The stub evaluates them once against the current static values
  // (animations complete instantly on the host), returning a plain
  // AnimatedValue the caller can interpolate.
  add: (a, b) => new AnimatedValue(numOf(a) + numOf(b)),
  subtract: (a, b) => new AnimatedValue(numOf(a) - numOf(b)),
  multiply: (a, b) => new AnimatedValue(numOf(a) * numOf(b)),
  divide: (a, b) => new AnimatedValue(numOf(b) === 0 ? 0 : numOf(a) / numOf(b)),
  modulo: (a, b) => new AnimatedValue(numOf(b) === 0 ? 0 : numOf(a) % numOf(b)),
  diffClamp: (a, min, max) => {
    const v = numOf(a);
    return new AnimatedValue(Math.min(max, Math.max(min, v)));
  },
  createAnimatedComponent: (C) => C,
  View: "View",
  Text: "Text",
  Image: "Image",
  ScrollView: "ScrollView",
};

// Components the renderer does not implement, mapped to the closest
// host component. They render statically; interaction is a later
// milestone.
function NullComponent() {
  return null;
}
function ActivityIndicator(props) {
  return React.createElement(
    "Text",
    { style: [{ color: "#9ca3af", fontSize: 20 }, props && props.style] },
    "●",
  );
}
function Modal(props) {
  if (!props || !props.visible) return null;
  return React.createElement(
    "View",
    { style: [{ flex: 1, backgroundColor: "#ffffff" }, props.style] },
    props.children,
  );
}
function KeyboardAvoidingView(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function TouchableOpacity(props) {
  return React.createElement("Pressable", props, props && props.children);
}
function Switch(props) {
  const on = props && props.value;
  return React.createElement(
    "Pressable",
    {
      onPress: () => props && props.onValueChange && props.onValueChange(!on),
      style: [
        {
          width: 48,
          height: 28,
          borderRadius: 14,
          backgroundColor: on ? "#111827" : "#d1d5db",
        },
        props && props.style,
      ],
    },
    React.createElement("View", {
      style: {
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: "#ffffff",
        margin: 3,
        marginLeft: on ? 23 : 3,
      },
    }),
  );
}
function FlatList(props) {
  const data = (props && props.data) || [];
  const renderItem = props && props.renderItem;
  const keyExtractor = (props && props.keyExtractor) || ((item, i) => String(i));
  const items = renderItem
    ? data.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: keyExtractor(item, index) },
          renderItem({ item, index, separators: {} }),
        ),
      )
    : null;
  return React.createElement("ScrollView", { style: props && props.style }, items);
}
function SectionList(props) {
  const sections = (props && props.sections) || [];
  const renderItem = props && props.renderItem;
  const renderSectionHeader = props && props.renderSectionHeader;
  const out = [];
  sections.forEach((section, si) => {
    if (renderSectionHeader)
      out.push(
        React.createElement(
          React.Fragment,
          { key: `h${si}` },
          renderSectionHeader({ section }),
        ),
      );
    (section.data || []).forEach((item, index) => {
      if (renderItem)
        out.push(
          React.createElement(
            React.Fragment,
            { key: `i${si}-${index}` },
            renderItem({ item, index, section, separators: {} }),
          ),
        );
    });
  });
  return React.createElement("ScrollView", { style: props && props.style }, out);
}
function VirtualizedList(props) {
  return React.createElement(FlatList, props);
}
function ImageBackground(props) {
  const { source, children, style, imageStyle } = props || {};
  return React.createElement(
    "View",
    { style },
    source
      ? React.createElement("Image", {
          source,
          style: [
            { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 },
            imageStyle,
          ],
        })
      : null,
    children,
  );
}
function RefreshControl() {
  return null;
}

// Image: the v2 renderer paints a PNG from the bundle's assets by
// name. Remote URIs have no local file (no image fetch in the host
// yet), so they render as a tinted placeholder rect with the same
// layout — the screen's structure stays true while the pixels are
// honest about what loaded.
function SevynImage(props) {
  const source = props && props.source;
  const uri = source && typeof source === "object" ? source.uri : null;
  const asset =
    source && typeof source === "number"
      ? `asset:${source}`
      : uri && uri.startsWith("asset:")
        ? uri
        : null;
  if (asset) return React.createElement("Image", props);
  return React.createElement("View", {
    style: [{ backgroundColor: "#e5e7eb" }, props && props.style],
  });
}
SevynImage.resolveAssetSource = (source) => {
  if (source == null) return null;
  if (typeof source === "number") return { uri: `asset:${source}`, width: 0, height: 0 };
  return source;
};
SevynImage.prefetch = () => Promise.resolve(true);
SevynImage.queryCache = () => Promise.resolve({});

const exportsObj = {
  View: "View",
  Text: "Text",
  Image: SevynImage,
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  TouchableOpacity,
  Switch,
  FlatList,
  SectionList,
  VirtualizedList,
  ImageBackground,
  RefreshControl,
  StyleSheet,
  Platform,
  Dimensions,
  PixelRatio,
  Appearance,
  useColorScheme,
  useWindowDimensions,
  AppRegistry,
  NativeModules,
  // expo-modules-core's requireNativeModule calls
  // TurboModuleRegistry.get(name) on the 'react-native' export. On the
  // host there are no turbo modules: return the same no-op module
  // Proxy as NativeModules so the call succeeds and the caller gets a
  // harmless stand-in instead of a load-time throw.
  TurboModuleRegistry: {
    get: (_name) => makeNativeModuleProxy(),
    getEnforcing: (_name) => makeNativeModuleProxy(),
  },
  NativeEventEmitter,
  UIManager,
  findNodeHandle,
  Alert,
  Linking,
  Share,
  BackHandler,
  AppState,
  Keyboard,
  I18nManager,
  LogBox,
  AccessibilityInfo,
  PanResponder,
  Easing,
  Animated,
  // Re-exported so `require('react-native')` also serves as the
  // renderer's entry point for the SevynOS app entry.
  __sevynRenderer: renderer,
};

// Unknown exports resolve to a null-rendering stub component instead
// of throwing — a missing export is a visible gap, never a crash.
module.exports = new Proxy(exportsObj, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === "__esModule") return undefined;
    if (typeof prop === "string" && prop.startsWith("$$")) return undefined;
    return NullComponent;
  },
});
