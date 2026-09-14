/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call */
/**
 * SevynOS React Native Community & Ecosystem Compatibility Layer
 *
 * Implements standard interfaces and components for:
 * - @react-native-community/netinfo
 * - react-native-screens
 * - react-native-gesture-handler
 * - react-native-reanimated
 * - react-native-svg
 * - @livekit/react-native
 */
import {
  createElement,
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  View,
  ScrollView as NativeScrollView,
  FlatList as NativeFlatList,
  Pressable as NativePressable,
  type NativeComponentProps,
} from "./primitives.js";
import { NetInfo } from "./native-modules.js";
import { Animated, type AnimatedValue } from "./animated.js";
import { Easing } from "./upstream-compat.js";
import { getNativeAdapters } from "./native-adapter-contracts.js";

export { Easing } from "./upstream-compat.js";
export {
  Animated,
  addWhitelistedUIProps,
  addWhitelistedNativeProps,
  createAnimatedComponent,
} from "./animated.js";

// =========================================================================
// @react-native-community/netinfo
// =========================================================================
export const NetInfoStateType = Object.freeze({
  unknown: "unknown" as const,
  none: "none" as const,
  cellular: "cellular" as const,
  wifi: "wifi" as const,
  bluetooth: "bluetooth" as const,
  ethernet: "ethernet" as const,
  wimax: "wimax" as const,
  vpn: "vpn" as const,
  other: "other" as const,
});

export type NetInfoState = Awaited<ReturnType<typeof NetInfo.fetch>>;

export function useNetInfo(): NetInfoState {
  const [state, setState] = useState<NetInfoState>({
    type: "wifi",
    isConnected: true,
    isInternetReachable: true,
  });

  useEffect(() => {
    const sub = NetInfo.addEventListener((next) => {
      setState(next);
    });
    return () => {
      sub.remove();
    };
  }, []);

  return state;
}

export const CommunityNetInfo = Object.freeze({
  fetch: NetInfo.fetch,
  addEventListener: (listener: (state: NetInfoState) => void) => {
    const sub = NetInfo.addEventListener(listener);
    const unsubscribe = () => {
      sub.remove();
    };
    (unsubscribe as unknown as { remove: () => void }).remove = () => {
      sub.remove();
    };
    return unsubscribe as unknown as (() => void) & { remove: () => void };
  },
});

export { CommunityNetInfo as NetInfo };

// =========================================================================
// react-native-screens
// =========================================================================
let screensEnabledState = true;

export function enableScreens(shouldEnable = true): void {
  screensEnabledState = shouldEnable;
}

export function screensEnabled(): boolean {
  return screensEnabledState;
}

export const Screen = forwardRef<unknown, NativeComponentProps>((props, _ref) =>
  createElement(View, props, props.children),
);
Screen.displayName = "Screen";

export const ScreenContainer = forwardRef<unknown, NativeComponentProps>((props, _ref) =>
  createElement(
    View,
    {
      ...props,
      style: {
        flex: 1,
        ...(props.style ?? {}),
      },
    },
    props.children,
  ),
);
ScreenContainer.displayName = "ScreenContainer";

export const ScreenStack = ScreenContainer;
export const ScreenStackHeaderConfig = Screen;
export const ScreenStackHeaderSubview = Screen;
export const ScreenStackHeaderBackButtonImage = Screen;
export const ScreenStackHeaderRightView = Screen;
export const ScreenStackHeaderLeftView = Screen;
export const ScreenStackHeaderCenterView = Screen;
export const ScreenStackHeaderSearchBarView = Screen;
export const SearchBar = Screen;
export const FullWindowOverlay = Screen;
export const ScreenFooter = Screen;
export const ScreenContentWrapper = Screen;
export const ScreenStackItem = Screen;
export const InnerScreen = Screen;
export const isSearchBarAvailableForCurrentPlatform = false;
export const executeNativeBackPress = (): boolean => false;

export const featureFlags = {
  experiment: {
    synchronousScreenUpdatesEnabled: false,
    synchronousHeaderConfigUpdatesEnabled: false,
    synchronousHeaderSubviewUpdatesEnabled: false,
    androidLegacyTopInsetBehavior: false,
    iosPreventReattachmentOfDismissedScreens: false,
  },
};

export const compatibilityFlags = {
  experiment: {},
};

export const NativeScreen = Screen;
export const NativeScreenContainer = ScreenContainer;
export const NativeScreenNavigationContainer = ScreenContainer;

// =========================================================================
// react-native-gesture-handler
// =========================================================================
export const State = Object.freeze({
  UNDETERMINED: 0,
  FAILED: 1,
  BEGAN: 2,
  CANCELLED: 3,
  ACTIVE: 4,
  END: 5,
});

export const Directions = Object.freeze({
  RIGHT: 1,
  LEFT: 2,
  UP: 4,
  DOWN: 8,
});

export const GestureHandlerRootView = forwardRef<unknown, NativeComponentProps>(
  (props, _ref) =>
    createElement(
      View,
      {
        ...props,
        style: {
          flex: 1,
          ...(props.style ?? {}),
        },
      },
      props.children,
    ),
);
GestureHandlerRootView.displayName = "GestureHandlerRootView";

function createGestureComponent(displayName: string) {
  const Component = forwardRef<unknown, NativeComponentProps>((props, _ref) =>
    createElement(View, props, props.children),
  );
  Component.displayName = displayName;
  return Component;
}

export const PanGestureHandler = createGestureComponent("PanGestureHandler");
export const TapGestureHandler = createGestureComponent("TapGestureHandler");
export const LongPressGestureHandler = createGestureComponent("LongPressGestureHandler");
export const FlingGestureHandler = createGestureComponent("FlingGestureHandler");
export const PinchGestureHandler = createGestureComponent("PinchGestureHandler");
export const RotationGestureHandler = createGestureComponent("RotationGestureHandler");
export const NativeViewGestureHandler = createGestureComponent(
  "NativeViewGestureHandler",
);

export type MockGesture = Record<string, (...args: unknown[]) => MockGesture>;

function mockGesture(): MockGesture {
  const target = Object.create(null) as object;
  const proxy: MockGesture = new Proxy(target, {
    get: () => () => proxy,
  }) as MockGesture;
  return proxy;
}

export const Gesture = Object.freeze({
  Pan: () => mockGesture(),
  Tap: () => mockGesture(),
  LongPress: () => mockGesture(),
  Pinch: () => mockGesture(),
  Rotation: () => mockGesture(),
  Fling: () => mockGesture(),
  Native: () => mockGesture(),
  Manual: () => mockGesture(),
  Race: (..._gestures: unknown[]) => mockGesture(),
  Simultaneous: (..._gestures: unknown[]) => mockGesture(),
  Exclusive: (..._gestures: unknown[]) => mockGesture(),
});

export function GestureDetector(props: {
  readonly children?: ReactNode;
  readonly gesture: unknown;
}): ReactElement {
  return createElement(View, null, props.children);
}

// =========================================================================
// react-native-reanimated
// =========================================================================
export interface SharedValue<T> {
  value: T;
  get(): T;
  set(value: T | ((current: T) => T)): void;
  modify(modifier?: (value: T) => T): void;
  addListener(id: number, listener: (value: T) => void): void;
  removeListener(id: number): void;
}

export function createSharedValue<T>(initialValue: T): SharedValue<T> {
  let val = initialValue;
  const sv: SharedValue<T> = {
    get value(): T {
      return val;
    },
    set value(next: T) {
      val = next;
    },
    get() {
      return val;
    },
    set(next: T | ((current: T) => T)) {
      if (typeof next === "function") {
        val = (next as (current: T) => T)(val);
      } else {
        val = next;
      }
    },
    modify(modifier?: (v: T) => T) {
      if (typeof modifier === "function") {
        val = modifier(val);
      }
    },
    addListener: () => undefined,
    removeListener: () => undefined,
  };
  return sv;
}

export function useSharedValue<T>(initialValue: T): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  if (!ref.current) {
    ref.current = createSharedValue(initialValue);
  }
  return ref.current;
}

export function useAnimatedStyle<T extends Record<string, unknown>>(
  updater: () => T,
  _dependencies?: unknown[],
): T {
  return updater();
}

export function useDerivedValue<T>(
  updater: () => T,
  _dependencies?: unknown[],
): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  let nextVal: T;
  try {
    nextVal = updater();
  } catch {
    nextVal = (ref.current ? ref.current.value : undefined) as T;
  }
  if (!ref.current) {
    ref.current = createSharedValue(nextVal);
  } else {
    ref.current.value = nextVal;
  }
  return ref.current;
}

export function useAnimatedScrollHandler(handlers: unknown): (event: unknown) => void {
  return (event: unknown) => {
    if (typeof handlers === "function") {
      handlers(event);
    } else if (typeof handlers === "object" && handlers !== null) {
      const record = handlers as Record<string, (e: unknown) => void>;
      record["onScroll"]?.(event);
    }
  };
}

export function withTiming<T>(
  toValue: T,
  _config?: unknown,
  callback?: (finished: boolean) => void,
): T {
  callback?.(true);
  return toValue;
}

export function withSpring<T>(
  toValue: T,
  _config?: unknown,
  callback?: (finished: boolean) => void,
): T {
  callback?.(true);
  return toValue;
}

export function withSequence<T>(...animations: T[]): T {
  return animations[animations.length - 1] as T;
}

export function withDelay<T>(_delay: number, animation: T): T {
  return animation;
}

export function withRepeat<T>(
  animation: T,
  _numberOfReps?: number,
  _reverse?: boolean,
): T {
  return animation;
}

export function cancelAnimation<T>(_sharedValue: SharedValue<T>): void {
  // Graceful no-op
}

export function runOnJS<Args extends unknown[], Return>(
  fn: (...args: Args) => Return,
): (...args: Args) => Return {
  return fn;
}

export function runOnUI<Args extends unknown[], Return>(
  fn: (...args: Args) => Return,
): (...args: Args) => Return {
  return fn;
}

export function interpolate(
  value: number,
  inputRange: readonly number[],
  outputRange: readonly (number | string)[],
): number | string {
  if (inputRange.length < 2 || outputRange.length < 2) return outputRange[0] ?? value;
  const minIn = inputRange[0] ?? 0;
  const maxIn = inputRange[inputRange.length - 1] ?? 1;
  const clamped = Math.max(minIn, Math.min(maxIn, value));
  const progress = maxIn === minIn ? 0 : (clamped - minIn) / (maxIn - minIn);
  const out0 = outputRange[0];
  const out1 = outputRange[outputRange.length - 1];
  if (typeof out0 === "number" && typeof out1 === "number") {
    return out0 + (out1 - out0) * progress;
  }
  return outputRange[0] ?? value;
}

export function makeMutable<T>(initialValue: T): SharedValue<T> {
  return createSharedValue(initialValue);
}

export function useAnimatedReaction(
  prepare: () => unknown,
  react: (res: unknown, prev: unknown) => void,
  _dependencies?: unknown[],
): void {
  const prevRef = useRef<unknown>(undefined);
  useEffect(() => {
    try {
      const res = prepare();
      react(res, prevRef.current);
      prevRef.current = res;
    } catch {
      // ignore
    }
  }, []);
}

export function useAnimatedRef<T = unknown>(): { current: T | null } {
  return useRef<T | null>(null);
}

export function useAnimatedProps<T extends Record<string, unknown>>(
  updater: () => T,
  _dependencies?: unknown[],
): T {
  return updater();
}

export function useWorkletCallback<Args extends unknown[], Return>(
  fn: (...args: Args) => Return,
): (...args: Args) => Return {
  return fn;
}

export function measure(_ref: unknown): {
  x: number;
  y: number;
  width: number;
  height: number;
  pageX: number;
  pageY: number;
} {
  return { x: 0, y: 0, width: 0, height: 0, pageX: 0, pageY: 0 };
}

export function scrollTo(
  _ref: unknown,
  _x: number,
  _y: number,
  _animated: boolean,
): void {}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function interpolateColor(
  _value: number,
  _inputRange: readonly number[],
  outputRange: readonly string[],
): string {
  return outputRange[0] ?? "#000000";
}

export const Extrapolation = Object.freeze({
  EXTEND: "extend",
  CLAMP: "clamp",
  IDENTITY: "identity",
});

export const ReduceMotion = Object.freeze({
  System: "system" as const,
  Always: "always" as const,
  Never: "never" as const,
});

export function useReducedMotion(): boolean {
  return false;
}

const layoutAnimationBuilder = () => ({
  duration: () => layoutAnimationBuilder(),
  springify: () => layoutAnimationBuilder(),
  damping: () => layoutAnimationBuilder(),
  stiffness: () => layoutAnimationBuilder(),
  delay: () => layoutAnimationBuilder(),
  withCallback: () => layoutAnimationBuilder(),
});

export const Layout = layoutAnimationBuilder();
export const FadeIn = layoutAnimationBuilder();
export const FadeOut = layoutAnimationBuilder();
export const FadeInRight = layoutAnimationBuilder();
export const FadeOutRight = layoutAnimationBuilder();
export const FadeInLeft = layoutAnimationBuilder();
export const FadeOutLeft = layoutAnimationBuilder();
export const SlideInUp = layoutAnimationBuilder();
export const SlideOutDown = layoutAnimationBuilder();

export const Extrapolate = Object.freeze({
  EXTEND: "extend",
  CLAMP: "clamp",
  IDENTITY: "identity",
});

export const Reanimated = Object.freeze({
  useSharedValue,
  createSharedValue,
  makeMutable,
  useAnimatedStyle,
  useDerivedValue,
  useAnimatedScrollHandler,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedProps,
  useWorkletCallback,
  useReducedMotion,
  ReduceMotion,
  withTiming,
  withSpring,
  withSequence,
  withDelay,
  withRepeat,
  cancelAnimation,
  runOnJS,
  runOnUI,
  interpolate,
  interpolateColor,
  clamp,
  measure,
  scrollTo,
  Easing,
  Extrapolation,
  Extrapolate,
  Layout,
  FadeIn,
  FadeOut,
  FadeInRight,
  FadeOutRight,
  FadeInLeft,
  FadeOutLeft,
  SlideInUp,
  SlideOutDown,
  addWhitelistedUIProps: Animated.addWhitelistedUIProps,
  addWhitelistedNativeProps: Animated.addWhitelistedNativeProps,
  View: Animated.View,
  Text: Animated.Text,
  Image: Animated.Image,
  ScrollView: Animated.ScrollView,
  FlatList: Animated.FlatList,
  createAnimatedComponent: Animated.createAnimatedComponent,
});

// =========================================================================
// react-native-svg
// =========================================================================
function createSvgComponent(name: string) {
  const Component = forwardRef<unknown, NativeComponentProps>((props, _ref) =>
    createElement("view", { ...props, svgElement: name }, props.children),
  );
  Component.displayName = name;
  return Component;
}

export const Svg = createSvgComponent("Svg");
export const Path = createSvgComponent("Path");
export const Circle = createSvgComponent("Circle");
export const Rect = createSvgComponent("Rect");
export const G = createSvgComponent("G");
export const SvgText = createSvgComponent("Text");
export const Defs = createSvgComponent("Defs");
export const Use = createSvgComponent("Use");
export const Line = createSvgComponent("Line");
export const Polygon = createSvgComponent("Polygon");
export const Polyline = createSvgComponent("Polyline");
export const ClipPath = createSvgComponent("ClipPath");
export const SvgLinearGradient = createSvgComponent("LinearGradient");
export const SvgRadialGradient = createSvgComponent("RadialGradient");
export const Stop = createSvgComponent("Stop");
export const Pattern = createSvgComponent("Pattern");
export const Mask = createSvgComponent("Mask");

// =========================================================================
// @livekit/react-native (WebRTC & LiveKit adapter)
// =========================================================================
export function registerGlobals(): void {
  const global = globalThis as unknown as Record<string, unknown>;

  // Mock RTCPeerConnection for SevynOS host
  if (typeof global["RTCPeerConnection"] === "undefined") {
    class MockRTCPeerConnection {
      public createOffer() {
        return Promise.resolve({
          type: "offer",
          sdp: "v=0\r\no=sevynos 0 0 IN IP4 127.0.0.1\r\ns=SevynRTC\r\n",
        });
      }
      public createAnswer() {
        return Promise.resolve({
          type: "answer",
          sdp: "v=0\r\no=sevynos 0 0 IN IP4 127.0.0.1\r\ns=SevynRTC\r\n",
        });
      }
      public setLocalDescription() {
        return Promise.resolve();
      }
      public setRemoteDescription() {
        return Promise.resolve();
      }
      public addIceCandidate() {
        return Promise.resolve();
      }
      public addTrack() {
        return {};
      }
      public removeTrack() {
        // No-op
      }
      public close() {
        // No-op
      }
      public addEventListener() {
        // No-op
      }
      public removeEventListener() {
        // No-op
      }
    }
    global["RTCPeerConnection"] = MockRTCPeerConnection;
  }

  if (typeof global["MediaStream"] === "undefined") {
    class MockMediaStream {
      public id = `sevyn-stream-${String(Date.now())}`;
      public getTracks() {
        return [];
      }
      public getVideoTracks() {
        return [];
      }
      public getAudioTracks() {
        return [];
      }
      public addTrack() {
        // No-op
      }
      public removeTrack() {
        // No-op
      }
    }
    global["MediaStream"] = MockMediaStream;
  }

  if (
    typeof navigator !== "undefined" &&
    !(navigator as { mediaDevices?: unknown }).mediaDevices
  ) {
    const mediaAdapters = getNativeAdapters();
    (navigator as unknown as Record<string, unknown>)["mediaDevices"] = {
      getUserMedia: async (constraints: { audio?: boolean; video?: boolean }) => {
        const camera = mediaAdapters.camera;
        if (constraints.video === true && camera?.preview) {
          await camera.preview();
        }
        const microphone = mediaAdapters.microphone;
        if (constraints.audio === true && microphone?.start) {
          await microphone.start();
        }
        return new (global["MediaStream"] as new () => unknown)();
      },
      enumerateDevices: async () => [
        { deviceId: "sevyn-camera-0", kind: "videoinput", label: "Sevyn Genesis Camera" },
        {
          deviceId: "sevyn-mic-0",
          kind: "audioinput",
          label: "Sevyn Genesis Microphone",
        },
        {
          deviceId: "sevyn-speaker-0",
          kind: "audiooutput",
          label: "Sevyn Genesis Output",
        },
      ],
    };
  }
}

let audioSessionStarted = false;

export const AudioSession = Object.freeze({
  get isStarted(): boolean {
    return audioSessionStarted;
  },
  startAudioSession: async () => {
    audioSessionStarted = true;
    const audio = getNativeAdapters().audio;
    if (audio?.getOutputs) {
      await audio.getOutputs();
    }
  },
  stopAudioSession: async () => {
    audioSessionStarted = false;
  },
  configureAudio: async (_config: unknown) => {
    // Graceful configure
  },
});

export const VideoView = forwardRef<unknown, NativeComponentProps>((props, _ref) =>
  createElement(
    View,
    {
      ...props,
      style: {
        backgroundColor: "#000000",
        ...(props.style ?? {}),
      },
    },
    props.children,
  ),
);
VideoView.displayName = "VideoView";

export function useRoom(): { state: string } {
  return { state: "connected" };
}

export function useParticipants(): readonly unknown[] {
  return [];
}

export function useTracks(): readonly unknown[] {
  return [];
}

const defaultCommunity = Object.assign({}, CommunityNetInfo, {
  NetInfo: CommunityNetInfo,
  CommunityNetInfo,
  useNetInfo,
  Svg,
  Rect,
  Circle,
  Path,
  G,
  Defs,
  Use,
  Line,
  Polygon,
  Polyline,
  LinearGradient: SvgLinearGradient,
  RadialGradient: SvgRadialGradient,
  Stop,
  ClipPath,
  Pattern,
  Mask,
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  enableScreens,
  Screen,
  ScreenContainer,
  ScreenStack,
  ScreenStackHeaderConfig,
  ScreenStackHeaderSubview,
  ScreenStackHeaderLeftView,
  ScreenStackHeaderCenterView,
  ScreenStackHeaderRightView,
  ScreenStackHeaderBackButtonImage,
  ScreenStackHeaderSearchBarView,
  SearchBar,
  FullWindowOverlay,
  ScreenFooter,
  ScreenContentWrapper,
  ScreenStackItem,
  InnerScreen,
  isSearchBarAvailableForCurrentPlatform,
  executeNativeBackPress,
  featureFlags,
  compatibilityFlags,
  NativeScreenNavigationContainer,
  NativeScreenContainer,
  NativeScreen,
  useSharedValue,
  createSharedValue,
  makeMutable,
  useAnimatedStyle,
  useDerivedValue,
  useAnimatedScrollHandler,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedProps,
  useWorkletCallback,
  useReducedMotion,
  ReduceMotion,
  withTiming,
  withSpring,
  withRepeat,
  withSequence,
  withDelay,
  cancelAnimation,
  interpolate,
  interpolateColor,
  clamp,
  measure,
  scrollTo,
  Extrapolation,
  Extrapolate,
  Layout,
  FadeIn,
  FadeOut,
  FadeInRight,
  FadeOutRight,
  FadeInLeft,
  FadeOutLeft,
  SlideInUp,
  SlideOutDown,
  Easing,
  Reanimated,
  Animated,
  createAnimatedComponent: Animated.createAnimatedComponent,
  View: Animated.View,
  Text: Animated.Text,
  Image: Animated.Image,
  ScrollView: Animated.ScrollView,
  FlatList: Animated.FlatList,
  Value: Animated.Value,
  timing: Animated.timing,
  spring: Animated.spring,
  sequence: Animated.sequence,
  parallel: Animated.parallel,
  stagger: Animated.stagger,
  loop: Animated.loop,
  addWhitelistedUIProps: Animated.addWhitelistedUIProps,
  addWhitelistedNativeProps: Animated.addWhitelistedNativeProps,
  runOnJS,
  runOnUI,
  VideoView,
  useRoom,
  useParticipants,
  useTracks,
  registerGlobals,
});

export default defaultCommunity;
