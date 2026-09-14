import { createElement, type ReactElement } from "react";
import type { NativeComponentProps } from "./primitives.js";
import type { NativeElementType } from "./native-types.js";

export interface FabricHostComponent<
  P extends NativeComponentProps = NativeComponentProps,
> {
  (props: P): ReactElement;
  readonly displayName: string;
}

const components = new Map<string, NativeElementType>();

export const NativeComponentRegistry = Object.freeze({
  register(name: string, hostType: NativeElementType): void {
    if (!name.trim()) throw new Error("Native component names cannot be empty.");
    components.set(name, hostType);
  },
  get(name: string): NativeElementType | undefined {
    return components.get(name);
  },
  has(name: string): boolean {
    return components.has(name);
  },
});

for (const [name, hostType] of [
  ["RCTView", "view"],
  ["RCTText", "text"],
  ["RCTImageView", "image"],
  ["RCTTextInput", "input"],
  ["RCTScrollView", "scroll"],
  ["RCTModalHostView", "overlay"],
  ["RNSScreen", "view"],
  ["RNSScreenStack", "view"],
  ["RNSScreenContainer", "view"],
  ["RNSScreenNavigationContainer", "view"],
  ["RNGestureHandlerButton", "button"],
  ["RNGestureHandlerRootView", "view"],
  ["RNCViewPager", "scroll"],
  ["RNSVGSvgView", "view"],
  ["LiveKitVideoView", "view"],
  ["AutoLayoutView", "view"],
] as const)
  NativeComponentRegistry.register(name, hostType);

function createCodegenNativeComponent<P extends NativeComponentProps>(
  name: string,
): FabricHostComponent<P> {
  const component = ((props: P) => {
    const hostType = NativeComponentRegistry.get(name) ?? "view";
    return createElement(
      hostType,
      { ...props, nativeComponentName: name },
      props.children,
    );
  }) as FabricHostComponent<P>;
  Object.defineProperty(component, "displayName", { value: name });
  return component;
}

export interface CodegenNativeComponentFunction {
  <P extends NativeComponentProps>(name: string): FabricHostComponent<P>;
  get<P extends NativeComponentProps>(
    name: string,
    viewConfigProvider?: () => unknown,
  ): FabricHostComponent<P>;
}

const codegenFn = createCodegenNativeComponent as CodegenNativeComponentFunction;
codegenFn.get = function get<P extends NativeComponentProps>(
  name: string,
  _viewConfigProvider?: () => unknown,
): FabricHostComponent<P> {
  return createCodegenNativeComponent<P>(name);
};

export const codegenNativeComponent = codegenFn;
export const requireNativeComponent = codegenFn;
export const get = codegenFn.get;

export function ConditionallyIgnoredEventHandlers<
  T extends Record<string, unknown> = Record<string, unknown>,
>(handlers: T): T {
  return handlers;
}

export function dispatchCommand(
  _handle: unknown,
  _command: string,
  _args?: readonly unknown[],
): void {}

export default codegenFn;

export function codegenNativeCommands<T extends Record<string, string>>(
  commands: T,
): {
  readonly [K in keyof T]: (
    ref: {
      current?: { dispatchCommand?: (name: string, args: readonly unknown[]) => void };
    },
    ...args: readonly unknown[]
  ) => void;
} {
  const handlers: Record<string, unknown> = {};
  for (const [key, command] of Object.entries(commands)) {
    handlers[key] = (
      ref:
        | {
            current?: {
              dispatchCommand?: (name: string, args: readonly unknown[]) => void;
            };
          }
        | null
        | undefined,
      ...commandArgs: readonly unknown[]
    ) => {
      ref?.current?.dispatchCommand?.(command, commandArgs);
    };
  }
  return handlers as unknown as {
    readonly [K in keyof T]: (
      ref: {
        current?: { dispatchCommand?: (name: string, args: readonly unknown[]) => void };
      },
      ...args: readonly unknown[]
    ) => void;
  };
}
