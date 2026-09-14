/**
 * Upstream React Native LayoutAnimation implementation.
 * Drives layout transitions through the animation/frame pipeline.
 */

import type { NativeBounds, NativeRuntimeSnapshot } from "./native-types.js";
import type { NativeRenderCommand } from "./surface.js";
import { InteractionManager } from "./interaction-manager.js";

export type LayoutAnimationType =
  "spring" | "linear" | "easeInEaseOut" | "easeIn" | "easeOut" | "keyboard";

export type LayoutAnimationProperty = "opacity" | "scaleX" | "scaleY" | "scaleXY";

export interface LayoutAnimationPropertyConfig {
  readonly duration?: number;
  readonly delay?: number;
  readonly springDamping?: number;
  readonly initialVelocity?: number;
  readonly type?: LayoutAnimationType;
  readonly property?: LayoutAnimationProperty;
}

export interface LayoutAnimationConfig {
  readonly duration: number;
  readonly create?: LayoutAnimationPropertyConfig;
  readonly update?: LayoutAnimationPropertyConfig;
  readonly delete?: LayoutAnimationPropertyConfig;
}

export type LayoutAnimationCallback = () => void;

export interface PendingLayoutAnimation {
  readonly config: LayoutAnimationConfig;
  readonly onEnd?: LayoutAnimationCallback | undefined;
  readonly onFail?: LayoutAnimationCallback | undefined;
}

let pendingAnimation: PendingLayoutAnimation | undefined;

export function getPendingLayoutAnimation(): PendingLayoutAnimation | undefined {
  return pendingAnimation;
}

export function consumePendingLayoutAnimation(): PendingLayoutAnimation | undefined {
  const current = pendingAnimation;
  pendingAnimation = undefined;
  return current;
}

export function clearPendingLayoutAnimation(): void {
  pendingAnimation = undefined;
}

const EASINGS: Record<LayoutAnimationType, (t: number) => number> = {
  linear: (t) => t,
  easeInEaseOut: (t) => t * t * (3 - 2 * t),
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  keyboard: (t) => t * t * (3 - 2 * t),
  spring: (t) => {
    // Damped spring approximation
    const c = 0.4;
    return 1 - Math.exp(-6 * t) * Math.cos(2 * Math.PI * (1 - c) * t);
  },
};

function interpolateBounds(
  from: NativeBounds,
  to: NativeBounds,
  progress: number,
): NativeBounds {
  return {
    x: Math.round(from.x + (to.x - from.x) * progress),
    y: Math.round(from.y + (to.y - from.y) * progress),
    width: Math.round(from.width + (to.width - from.width) * progress),
    height: Math.round(from.height + (to.height - from.height) * progress),
  };
}

function interpolateCommand(
  from: NativeRenderCommand | undefined,
  to: NativeRenderCommand | undefined,
  progress: number,
  propType: LayoutAnimationProperty | undefined,
): NativeRenderCommand | undefined {
  if (from !== undefined && to !== undefined) {
    const bounds = interpolateBounds(from.bounds, to.bounds, progress);
    const fromOpacity = from.opacity ?? 1;
    const toOpacity = to.opacity ?? 1;
    const opacity = fromOpacity + (toOpacity - fromOpacity) * progress;
    return Object.freeze({
      ...to,
      bounds,
      opacity,
    });
  }

  if (from === undefined && to !== undefined) {
    // Created command
    const toOpacity = to.opacity ?? 1;
    if (propType === "opacity") {
      return Object.freeze({
        ...to,
        opacity: toOpacity * progress,
      });
    }
    // ScaleXY / default: scale in from center
    const cx = to.bounds.x + to.bounds.width / 2;
    const cy = to.bounds.y + to.bounds.height / 2;
    const w = Math.round(to.bounds.width * progress);
    const h = Math.round(to.bounds.height * progress);
    return Object.freeze({
      ...to,
      bounds: {
        x: Math.round(cx - w / 2),
        y: Math.round(cy - h / 2),
        width: w,
        height: h,
      },
      opacity: toOpacity * progress,
    });
  }

  if (from !== undefined && to === undefined) {
    // Deleted command
    const fromOpacity = from.opacity ?? 1;
    const remaining = 1 - progress;
    if (propType === "opacity") {
      return Object.freeze({
        ...from,
        opacity: fromOpacity * remaining,
      });
    }
    const cx = from.bounds.x + from.bounds.width / 2;
    const cy = from.bounds.y + from.bounds.height / 2;
    const w = Math.round(from.bounds.width * remaining);
    const h = Math.round(from.bounds.height * remaining);
    return Object.freeze({
      ...from,
      bounds: {
        x: Math.round(cx - w / 2),
        y: Math.round(cy - h / 2),
        width: w,
        height: h,
      },
      opacity: fromOpacity * remaining,
    });
  }

  return undefined;
}

export function driveLayoutAnimation(options: {
  readonly startSnapshot: NativeRuntimeSnapshot;
  readonly targetSnapshot: NativeRuntimeSnapshot;
  readonly config: LayoutAnimationConfig;
  readonly onFrame: (snapshot: NativeRuntimeSnapshot) => void;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
}): { stop(): void } {
  const duration = Math.max(16, options.config.duration);
  const easingType = options.config.update?.type ?? "easeInEaseOut";
  const easing = EASINGS[easingType];

  const startCommandsById = new Map<string, NativeRenderCommand>();
  for (const cmd of options.startSnapshot.commands) {
    startCommandsById.set(cmd.id, cmd);
  }

  const targetCommandsById = new Map<string, NativeRenderCommand>();
  for (const cmd of options.targetSnapshot.commands) {
    targetCommandsById.set(cmd.id, cmd);
  }

  const allIds = new Set([...startCommandsById.keys(), ...targetCommandsById.keys()]);
  const handle = InteractionManager.createInteractionHandle();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const startTime = Date.now();

  const cleanup = (): void => {
    active = false;
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    InteractionManager.clearInteractionHandle(handle);
  };

  const step = (): void => {
    if (!active) return;
    const elapsed = Date.now() - startTime;
    const rawT = Math.min(1, elapsed / duration);
    const progress = easing(rawT);

    if (rawT < 1) {
      const interpolatedCommands: NativeRenderCommand[] = [];
      for (const id of allIds) {
        const from = startCommandsById.get(id);
        const to = targetCommandsById.get(id);
        const propType =
          to === undefined
            ? options.config.delete?.property
            : options.config.create?.property;
        const cmd = interpolateCommand(from, to, progress, propType);
        if (cmd !== undefined) {
          interpolatedCommands.push(cmd);
        }
      }

      options.onFrame(
        Object.freeze({
          revision: options.targetSnapshot.revision,
          commands: Object.freeze(interpolatedCommands),
          accessibility: options.targetSnapshot.accessibility,
          overlays: options.targetSnapshot.overlays,
          changedNodeIds: options.targetSnapshot.changedNodeIds,
        }),
      );

      timerId = setTimeout(step, 16);
    } else {
      cleanup();
      options.onFrame(options.targetSnapshot);
      options.onComplete();
    }
  };

  step();

  return {
    stop(): void {
      if (!active) return;
      cleanup();
      options.onCancel();
    },
  };
}

export const LayoutAnimation = Object.freeze({
  configureNext: (
    config: LayoutAnimationConfig,
    onEnd?: LayoutAnimationCallback,
    onFail?: LayoutAnimationCallback,
  ): void => {
    pendingAnimation = { config, onEnd, onFail };
  },
  create: (duration: number, type: string, property: string): LayoutAnimationConfig => ({
    duration,
    create: {
      type: type as LayoutAnimationType,
      property: property as LayoutAnimationProperty,
    },
    update: {
      type: type as LayoutAnimationType,
    },
    delete: {
      type: type as LayoutAnimationType,
      property: property as LayoutAnimationProperty,
    },
  }),
  Types: Object.freeze({
    spring: "spring" as const,
    linear: "linear" as const,
    easeInEaseOut: "easeInEaseOut" as const,
    easeIn: "easeIn" as const,
    easeOut: "easeOut" as const,
    keyboard: "keyboard" as const,
  }),
  Properties: Object.freeze({
    opacity: "opacity" as const,
    scaleX: "scaleX" as const,
    scaleY: "scaleY" as const,
    scaleXY: "scaleXY" as const,
  }),
  Presets: Object.freeze({
    easeInEaseOut: Object.freeze({
      duration: 300,
      create: { type: "easeInEaseOut" as const, property: "opacity" as const },
      update: { type: "easeInEaseOut" as const },
      delete: { type: "easeInEaseOut" as const, property: "opacity" as const },
    }),
    linear: Object.freeze({
      duration: 500,
      create: { type: "linear" as const, property: "opacity" as const },
      update: { type: "linear" as const },
      delete: { type: "linear" as const, property: "opacity" as const },
    }),
    spring: Object.freeze({
      duration: 700,
      create: { type: "linear" as const, property: "opacity" as const },
      update: { type: "spring" as const, springDamping: 0.4 },
      delete: { type: "linear" as const, property: "opacity" as const },
    }),
  }),
});
