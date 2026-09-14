import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { View, type NativeComponentProps } from "./primitives.js";

export interface EdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface SafeAreaFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const defaultInsets: EdgeInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const defaultFrame: SafeAreaFrame = Object.freeze({
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
});
const InsetsContext = createContext<EdgeInsets>(defaultInsets);
const FrameContext = createContext<SafeAreaFrame>(defaultFrame);

export const SafeAreaInsetsContext = InsetsContext;
export const SafeAreaFrameContext = FrameContext;
export const initialWindowMetrics = Object.freeze({
  insets: defaultInsets,
  frame: defaultFrame,
});

export function SafeAreaProvider(props: {
  readonly children?: ReactNode;
  readonly initialMetrics?: {
    readonly insets: EdgeInsets;
    readonly frame: SafeAreaFrame;
  };
}): ReactElement {
  const metrics = props.initialMetrics ?? initialWindowMetrics;
  return createElement(
    InsetsContext.Provider,
    { value: metrics.insets },
    createElement(FrameContext.Provider, { value: metrics.frame }, props.children),
  );
}

export function SafeAreaView(
  props: NativeComponentProps & { readonly edges?: readonly (keyof EdgeInsets)[] },
): ReactElement {
  const insets = useContext(InsetsContext);
  const edges = props.edges ?? ["top", "right", "bottom", "left"];
  return View({
    ...props,
    style: {
      ...props.style,
      ...(edges.includes("top") ? { paddingTop: insets.top } : {}),
      ...(edges.includes("right") ? { paddingRight: insets.right } : {}),
      ...(edges.includes("bottom") ? { paddingBottom: insets.bottom } : {}),
      ...(edges.includes("left") ? { paddingLeft: insets.left } : {}),
    },
  });
}

export const useSafeAreaInsets = (): EdgeInsets => useContext(InsetsContext);
export const useSafeAreaFrame = (): SafeAreaFrame => useContext(FrameContext);
export const SafeAreaConsumer = InsetsContext.Consumer;
