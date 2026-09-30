import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
} from "react";
import {
  FlatList,
  Image,
  ScrollView,
  SectionList,
  Text,
  View,
  type NativeComponentProps,
} from "./primitives.js";
import type { NativeStyle } from "./native-types.js";
import { InteractionManager } from "./interaction-manager.js";

export interface EndResult {
  readonly finished: boolean;
}
export type EndCallback = (result: EndResult) => void;

export interface CompositeAnimation {
  start(callback?: EndCallback): void;
  stop(): void;
  reset(): void;
}

export interface InterpolationConfig {
  readonly inputRange: readonly number[];
  readonly outputRange: readonly (number | string)[];
  readonly extrapolate?: "extend" | "clamp" | "identity";
}

export class AnimatedInterpolation {
  readonly #parent: AnimatedValue;
  readonly #config: InterpolationConfig;

  public constructor(parent: AnimatedValue, config: InterpolationConfig) {
    this.#parent = parent;
    this.#config = config;
  }

  public getValue(): number | string {
    const val = this.#parent.getValue();
    const { inputRange, outputRange, extrapolate = "extend" } = this.#config;
    if (inputRange.length < 2 || outputRange.length < 2) {
      return outputRange[0] ?? val;
    }
    const minInput = inputRange[0] ?? 0;
    const maxInput = inputRange[inputRange.length - 1] ?? 1;

    let clamped = val;
    if (extrapolate === "clamp") {
      clamped = Math.max(minInput, Math.min(maxInput, val));
    }

    let idx = 0;
    while (idx < inputRange.length - 2 && clamped > (inputRange[idx + 1] ?? 0)) {
      idx += 1;
    }
    const inStart = inputRange[idx] ?? 0;
    const inEnd = inputRange[idx + 1] ?? 1;
    const outStart = outputRange[idx];
    const outEnd = outputRange[idx + 1];

    if (typeof outStart === "number" && typeof outEnd === "number") {
      const progress = inEnd === inStart ? 0 : (clamped - inStart) / (inEnd - inStart);
      return outStart + (outEnd - outStart) * progress;
    }

    return clamped >= inEnd ? (outEnd ?? "") : (outStart ?? "");
  }

  public addListener(callback: (state: { value: number | string }) => void): string {
    return this.#parent.addListener(() => {
      callback({ value: this.getValue() });
    });
  }

  public removeListener(id: string): void {
    this.#parent.removeListener(id);
  }
}

let nextListenerId = 1;

export class AnimatedValue {
  #value: number;
  readonly #listeners = new Map<string, (state: { value: number }) => void>();

  public constructor(value: number) {
    this.#value = value;
  }

  public getValue(): number {
    return this.#value;
  }

  public setValue(value: number): void {
    this.#value = value;
    for (const listener of this.#listeners.values()) {
      listener({ value });
    }
  }

  public addListener(callback: (state: { value: number }) => void): string {
    const id = "anim_" + String(nextListenerId++);
    this.#listeners.set(id, callback);
    return id;
  }

  public removeListener(id: string): void {
    this.#listeners.delete(id);
  }

  public removeAllListeners(): void {
    this.#listeners.clear();
  }

  public hasListeners(): boolean {
    return this.#listeners.size > 0;
  }

  public stopAnimation(callback?: (value: number) => void): void {
    callback?.(this.#value);
  }

  public resetAnimation(callback?: (value: number) => void): void {
    this.#value = 0;
    callback?.(0);
  }

  public setOffset(_offset: number): void {}
  public flattenOffset(): void {}
  public extractOffset(): void {}

  public interpolate(config: InterpolationConfig): AnimatedInterpolation {
    return new AnimatedInterpolation(this, config);
  }
}

export class AnimatedValueXY {
  public readonly x: AnimatedValue;
  public readonly y: AnimatedValue;

  public constructor(valueIn?: {
    x?: number | AnimatedValue;
    y?: number | AnimatedValue;
  }) {
    this.x =
      valueIn?.x instanceof AnimatedValue
        ? valueIn.x
        : new AnimatedValue(typeof valueIn?.x === "number" ? valueIn.x : 0);
    this.y =
      valueIn?.y instanceof AnimatedValue
        ? valueIn.y
        : new AnimatedValue(typeof valueIn?.y === "number" ? valueIn.y : 0);
  }

  public setValue(value: { x: number; y: number }): void {
    this.x.setValue(value.x);
    this.y.setValue(value.y);
  }

  public setOffset(_offset: { x: number; y: number }): void {}
  public flattenOffset(): void {}
  public extractOffset(): void {}

  public addListener(callback: (value: { x: number; y: number }) => void): string {
    return this.x.addListener(() => {
      callback({ x: this.x.getValue(), y: this.y.getValue() });
    });
  }

  public removeListener(id: string): void {
    this.x.removeListener(id);
    this.y.removeListener(id);
  }

  public removeAllListeners(): void {
    this.x.removeAllListeners();
    this.y.removeAllListeners();
  }

  public stopAnimation(callback?: (value: { x: number; y: number }) => void): void {
    callback?.({ x: this.x.getValue(), y: this.y.getValue() });
  }

  public resetAnimation(callback?: (value: { x: number; y: number }) => void): void {
    this.setValue({ x: 0, y: 0 });
    callback?.({ x: 0, y: 0 });
  }

  public getLayout(): { left: AnimatedValue; top: AnimatedValue } {
    return { left: this.x, top: this.y };
  }

  public getTranslateTransform(): readonly [
    { readonly translateX: AnimatedValue },
    { readonly translateY: AnimatedValue },
  ] {
    return [Object.freeze({ translateX: this.x }), Object.freeze({ translateY: this.y })];
  }
}

export interface TimingAnimationConfig {
  readonly toValue: number;
  readonly duration?: number;
  readonly delay?: number;
  readonly easing?: (t: number) => number;
  readonly useNativeDriver?: boolean;
}

export interface SpringAnimationConfig {
  readonly toValue: number;
  readonly friction?: number;
  readonly tension?: number;
  readonly bounciness?: number;
  readonly speed?: number;
  readonly useNativeDriver?: boolean;
}

export function timing(
  value: AnimatedValue,
  config: TimingAnimationConfig,
): CompositeAnimation {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let animFrameId: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let interactionHandle: number | undefined;

  const cleanupInteraction = (): void => {
    if (interactionHandle !== undefined) {
      const handle = interactionHandle;
      interactionHandle = undefined;
      InteractionManager.clearInteractionHandle(handle);
    }
  };

  return {
    start(callback?: EndCallback): void {
      this.stop();
      active = true;
      const startValue = value.getValue();
      const targetValue = config.toValue;
      const duration = Math.max(0, config.duration ?? 300);
      const delay = Math.max(0, config.delay ?? 0);
      const easing = config.easing ?? ((t: number): number => t);

      if (duration > 0 || delay > 0) {
        interactionHandle = InteractionManager.createInteractionHandle();
      }

      const run = (): void => {
        if (!active) return;
        if (duration === 0) {
          cleanupInteraction();
          value.setValue(targetValue);
          active = false;
          callback?.({ finished: true });
          return;
        }

        const startTime = Date.now();
        const step = (): void => {
          if (!active) return;
          const elapsed = Date.now() - startTime;
          const t = Math.min(1, elapsed / duration);
          const eased = easing(t);
          value.setValue(startValue + (targetValue - startValue) * eased);

          if (t < 1) {
            animFrameId = setTimeout(step, 16);
          } else {
            cleanupInteraction();
            value.setValue(targetValue);
            active = false;
            callback?.({ finished: true });
          }
        };
        step();
      };

      if (delay > 0) {
        timerId = setTimeout(run, delay);
      } else {
        run();
      }
    },
    stop(): void {
      active = false;
      cleanupInteraction();
      if (timerId !== undefined) clearTimeout(timerId);
      if (animFrameId !== undefined) clearTimeout(animFrameId);
    },
    reset(): void {
      this.stop();
    },
  };
}

export function spring(
  value: AnimatedValue,
  config: SpringAnimationConfig,
): CompositeAnimation {
  let animFrameId: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let interactionHandle: number | undefined;

  const cleanupInteraction = (): void => {
    if (interactionHandle !== undefined) {
      const handle = interactionHandle;
      interactionHandle = undefined;
      InteractionManager.clearInteractionHandle(handle);
    }
  };

  return {
    start(callback?: EndCallback): void {
      this.stop();
      active = true;
      interactionHandle = InteractionManager.createInteractionHandle();
      let current = value.getValue();
      const target = config.toValue;
      let velocity = 0;
      const tension = config.tension ?? 40;
      const friction = config.friction ?? 7;

      const step = (): void => {
        if (!active) return;
        const force = -tension * 0.001 * (current - target);
        const damping = -friction * 0.01 * velocity;
        const acceleration = force + damping;
        velocity += acceleration;
        current += velocity;
        value.setValue(current);

        if (Math.abs(velocity) < 0.005 && Math.abs(current - target) < 0.005) {
          cleanupInteraction();
          value.setValue(target);
          active = false;
          callback?.({ finished: true });
        } else {
          animFrameId = setTimeout(step, 16);
        }
      };
      step();
    },
    stop(): void {
      active = false;
      cleanupInteraction();
      if (animFrameId !== undefined) clearTimeout(animFrameId);
    },
    reset(): void {
      this.stop();
    },
  };
}

export function sequence(animations: readonly CompositeAnimation[]): CompositeAnimation {
  let currentIndex = 0;
  let active = false;

  return {
    start(callback?: EndCallback): void {
      this.stop();
      active = true;
      currentIndex = 0;

      const runNext = (): void => {
        if (!active) return;
        if (currentIndex >= animations.length) {
          active = false;
          callback?.({ finished: true });
          return;
        }
        const anim = animations[currentIndex++];
        anim?.start((result) => {
          if (!active) return;
          if (result.finished) {
            runNext();
          } else {
            active = false;
            callback?.({ finished: false });
          }
        });
      };
      runNext();
    },
    stop(): void {
      active = false;
      for (const anim of animations) anim.stop();
    },
    reset(): void {
      this.stop();
      for (const anim of animations) anim.reset();
    },
  };
}

export function parallel(
  animations: readonly CompositeAnimation[],
  config?: { readonly stopTogether?: boolean },
): CompositeAnimation {
  let active = false;

  return {
    start(callback?: EndCallback): void {
      this.stop();
      active = true;
      if (animations.length === 0) {
        callback?.({ finished: true });
        return;
      }

      let completed = 0;
      const total = animations.length;

      for (const anim of animations) {
        anim.start((result) => {
          if (!active) return;
          if (result.finished) {
            completed += 1;
            if (completed === total) {
              active = false;
              callback?.({ finished: true });
            }
          } else if (config?.stopTogether ?? true) {
            this.stop();
            callback?.({ finished: false });
          }
        });
      }
    },
    stop(): void {
      active = false;
      for (const anim of animations) anim.stop();
    },
    reset(): void {
      this.stop();
      for (const anim of animations) anim.reset();
    },
  };
}

export function stagger(
  time: number,
  animations: readonly CompositeAnimation[],
): CompositeAnimation {
  const delayedAnimations = animations.map((anim, index) =>
    sequence([
      timing(new AnimatedValue(0), { toValue: 1, duration: index * time }),
      anim,
    ]),
  );
  return parallel(delayedAnimations);
}

export function loop(
  animation: CompositeAnimation,
  config?: { readonly iterations?: number },
): CompositeAnimation {
  const maxIterations = config?.iterations ?? -1;
  let currentIteration = 0;
  let active = false;

  return {
    start(callback?: EndCallback): void {
      this.stop();
      active = true;
      currentIteration = 0;

      const run = (): void => {
        if (!active) return;
        if (maxIterations > 0 && currentIteration >= maxIterations) {
          active = false;
          callback?.({ finished: true });
          return;
        }
        currentIteration += 1;
        animation.reset();
        animation.start((result) => {
          if (!active) return;
          if (result.finished) {
            run();
          } else {
            active = false;
            callback?.({ finished: false });
          }
        });
      };
      run();
    },
    stop(): void {
      active = false;
      animation.stop();
    },
    reset(): void {
      this.stop();
      animation.reset();
    },
  };
}

export type AnimatedStyle = {
  [K in keyof NativeStyle]?: NativeStyle[K] | AnimatedValue | AnimatedInterpolation;
};

export function resolveAnimatedStyle(
  style?: AnimatedStyle | readonly AnimatedStyle[],
): NativeStyle {
  if (!style) return {};
  const merged: Record<string, unknown> = {};
  const styles = Array.isArray(style) ? style : [style];

  for (const s of styles) {
    if (!s) continue;
    for (const [key, val] of Object.entries(s as Record<string, unknown>)) {
      if (val instanceof AnimatedValue || val instanceof AnimatedInterpolation) {
        merged[key] = val.getValue();
      } else {
        merged[key] = val;
      }
    }
  }
  return merged;
}

export function createAnimatedComponent<P extends NativeComponentProps>(
  Component: ComponentType<P>,
): (
  props: Omit<P, "style"> & { readonly style?: AnimatedStyle | readonly AnimatedStyle[] },
) => ReactElement {
  return function AnimatedComponentWrapper(props): ReactElement {
    const [, setTick] = useState(0);
    const resolvedStyle = resolveAnimatedStyle(props.style);
    const subscriptions = useRef<(() => void)[]>([]);

    useEffect(() => {
      for (const unsub of subscriptions.current) {
        unsub();
      }
      subscriptions.current = [];

      const styles = Array.isArray(props.style) ? props.style : [props.style];
      for (const s of styles) {
        if (!s) continue;
        for (const val of Object.values(s as Record<string, unknown>)) {
          if (val instanceof AnimatedValue || val instanceof AnimatedInterpolation) {
            const listenerId = val.addListener(() => {
              setTick((t) => (t + 1) % 10000);
            });
            subscriptions.current.push(() => {
              val.removeListener(listenerId);
            });
          }
        }
      }

      return (): void => {
        for (const unsub of subscriptions.current) {
          unsub();
        }
        subscriptions.current = [];
      };
    }, [props.style]);

    return createElement(Component as ComponentType<Record<string, unknown>>, {
      ...props,
      style: resolvedStyle,
    });
  };
}

export function addWhitelistedUIProps(_props: Record<string, boolean>): void {}
export function addWhitelistedNativeProps(_props: Record<string, boolean>): void {}

export function event(
  argMapping?: readonly unknown[],
  config?: { listener?: (...args: unknown[]) => void; useNativeDriver?: boolean },
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (Array.isArray(argMapping) && argMapping.length > 0) {
      const mapping = argMapping[0];
      const eventObj = args[0];
      if (
        typeof mapping === "object" &&
        mapping !== null &&
        typeof eventObj === "object" &&
        eventObj !== null
      ) {
        const traverse = (map: Record<string, unknown>, src: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(map)) {
            if (v instanceof AnimatedValue && typeof src[k] === "number") {
              v.setValue(src[k]);
            } else if (
              typeof v === "object" &&
              v !== null &&
              typeof src[k] === "object" &&
              src[k] !== null
            ) {
              traverse(v as Record<string, unknown>, src[k] as Record<string, unknown>);
            }
          }
        };
        traverse(mapping as Record<string, unknown>, eventObj as Record<string, unknown>);
      }
    }
    config?.listener?.(...args);
  };
}

export function diffClamp(
  a: AnimatedValue,
  min: number,
  max: number,
): AnimatedInterpolation {
  return a.interpolate({
    inputRange: [min, max],
    outputRange: [min, max],
    extrapolate: "clamp",
  });
}

export function add(a: AnimatedValue, b: AnimatedValue | number): AnimatedInterpolation {
  const bVal = b instanceof AnimatedValue ? b.getValue() : b;
  return a.interpolate({
    inputRange: [0, 100],
    outputRange: [bVal, 100 + bVal],
  });
}

export function subtract(
  a: AnimatedValue,
  b: AnimatedValue | number,
): AnimatedInterpolation {
  const bVal = b instanceof AnimatedValue ? b.getValue() : b;
  return a.interpolate({
    inputRange: [0, 100],
    outputRange: [-bVal, 100 - bVal],
  });
}

export function multiply(
  a: AnimatedValue,
  b: AnimatedValue | number,
): AnimatedInterpolation {
  const bVal = b instanceof AnimatedValue ? b.getValue() : b;
  return a.interpolate({
    inputRange: [0, 1],
    outputRange: [0, bVal],
  });
}

export function divide(
  a: AnimatedValue,
  b: AnimatedValue | number,
): AnimatedInterpolation {
  const bVal = b instanceof AnimatedValue ? b.getValue() : b;
  const divisor = bVal === 0 ? 1 : bVal;
  return a.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1 / divisor],
  });
}

export function modulo(a: AnimatedValue, modulus: number): AnimatedInterpolation {
  return a.interpolate({
    inputRange: [0, modulus],
    outputRange: [0, modulus],
  });
}

export function decay(_value: AnimatedValue, _config: unknown): CompositeAnimation {
  return {
    start(callback?: EndCallback): void {
      callback?.({ finished: true });
    },
    stop(): void {},
    reset(): void {},
  };
}

export function delay(time: number): CompositeAnimation {
  return {
    start(callback?: EndCallback): void {
      setTimeout(() => callback?.({ finished: true }), time);
    },
    stop(): void {},
    reset(): void {},
  };
}

export const Animated = {
  Value: AnimatedValue,
  ValueXY: AnimatedValueXY,
  timing,
  spring,
  sequence,
  parallel,
  stagger,
  loop,
  event,
  diffClamp,
  add,
  subtract,
  multiply,
  divide,
  modulo,
  decay,
  delay,
  createAnimatedComponent,
  addWhitelistedUIProps,
  addWhitelistedNativeProps,
  View: createAnimatedComponent(View),
  Text: createAnimatedComponent(Text),
  Image: createAnimatedComponent(Image),
  ScrollView: createAnimatedComponent(ScrollView),
  FlatList: createAnimatedComponent(FlatList),
  SectionList: createAnimatedComponent(SectionList),
};
