/**
 * Window Animation Controller for SevynOS.
 *
 * Manages smooth visual transitions for window lifecycle events:
 * opening, closing, minimizing, maximizing, restoring, and snapping.
 *
 * This controller operates at the scene composition level — it produces
 * per-window visual transform data (opacity, scale, translate) that
 * the renderer applies when drawing window frames. It does NOT modify
 * actual window bounds or state; those remain owned by GenesisWindowManager.
 */

import type { GenesisWindowId } from "@sevynos/graphics";
import type { WindowBounds } from "@sevynos/graphics";
import { sevynTokens, motionDuration } from "@sevynos/react-native/internal";

// ─── Public Types ───────────────────────────────────────────────────────────

/** Visual transform applied to a window during animation. */
export interface WindowAnimationTransform {
  readonly opacity: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly translateX: number;
  readonly translateY: number;
}

/** The kind of window animation currently playing. */
export type WindowAnimationKind =
  "open" | "close" | "minimize" | "restore" | "maximize" | "unmaximize" | "snap";

/** A running animation for a single window. */
interface ActiveWindowAnimation {
  readonly kind: WindowAnimationKind;
  readonly windowId: GenesisWindowId;
  readonly startTime: number;
  readonly duration: number;
  readonly fromTransform: WindowAnimationTransform;
  readonly toTransform: WindowAnimationTransform;
  readonly easing: (t: number) => number;
  readonly onComplete?: (() => void) | undefined;
  /** For minimize/restore: dock icon target position. */
  readonly targetBounds?: WindowBounds | undefined;
  /** For maximize/unmaximize: previous window bounds. */
  readonly previousBounds?: WindowBounds | undefined;
}

// ─── Easing Functions ───────────────────────────────────────────────────────

/** Ease-out cubic: decelerating to zero velocity. */
function easeOutCubic(t: number): number {
  const t1 = t - 1;
  return t1 * t1 * t1 + 1;
}

/** Ease-in-out cubic: acceleration then deceleration. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Ease-in cubic: accelerating from zero velocity. */
function easeInCubic(t: number): number {
  return t * t * t;
}

/** Ease-out quint for snappy feel. */
function easeOutQuint(t: number): number {
  const t1 = t - 1;
  return t1 * t1 * t1 * t1 * t1 + 1;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const IDENTITY_TRANSFORM: WindowAnimationTransform = Object.freeze({
  opacity: 1,
  scaleX: 1,
  scaleY: 1,
  translateX: 0,
  translateY: 0,
});

const ANIMATION_CONFIGS = Object.freeze({
  open: {
    duration: sevynTokens.motion.standard,
    easing: easeOutCubic,
    from: Object.freeze({
      opacity: 0,
      scaleX: 0.92,
      scaleY: 0.92,
      translateX: 0,
      translateY: 8,
    }),
  },
  close: {
    duration: sevynTokens.motion.quick,
    easing: easeInCubic,
    from: IDENTITY_TRANSFORM,
    to: Object.freeze({
      opacity: 0,
      scaleX: 0.92,
      scaleY: 0.92,
      translateX: 0,
      translateY: 8,
    }),
  },
  minimize: {
    duration: sevynTokens.motion.standard,
    easing: easeInOutCubic,
    to: Object.freeze({
      opacity: 0,
      scaleX: 0.3,
      scaleY: 0.3,
      translateX: 0,
      translateY: 0,
    }),
  },
  restore: {
    duration: sevynTokens.motion.standard,
    easing: easeOutCubic,
    from: Object.freeze({
      opacity: 0,
      scaleX: 0.3,
      scaleY: 0.3,
      translateX: 0,
      translateY: 0,
    }),
  },
  maximize: {
    duration: sevynTokens.motion.standard,
    easing: easeOutQuint,
  },
  unmaximize: {
    duration: sevynTokens.motion.standard,
    easing: easeOutQuint,
  },
  snap: {
    duration: sevynTokens.motion.quick,
    easing: easeOutCubic,
  },
});

// ─── Controller ─────────────────────────────────────────────────────────────

export class WindowAnimationController {
  readonly #animations = new Map<GenesisWindowId, ActiveWindowAnimation>();
  readonly #listeners = new Set<() => void>();
  #reducedMotion: boolean;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(reducedMotion = false) {
    this.#reducedMotion = reducedMotion;
  }

  /** Update reduced motion preference. */
  public setReducedMotion(reducedMotion: boolean): void {
    this.#reducedMotion = reducedMotion;
  }

  /**
   * Start a window-open animation.
   * The window scales up slightly and fades in.
   */
  public animateOpen(windowId: GenesisWindowId, onComplete?: () => void): void {
    const config = ANIMATION_CONFIGS.open;
    this.#startAnimation({
      kind: "open",
      windowId,
      startTime: Date.now(),
      duration: motionDuration(config.duration, this.#reducedMotion),
      fromTransform: config.from,
      toTransform: IDENTITY_TRANSFORM,
      easing: config.easing,
      onComplete,
    });
  }

  /**
   * Start a window-close animation.
   * The window scales down slightly and fades out.
   */
  public animateClose(windowId: GenesisWindowId, onComplete?: () => void): void {
    const config = ANIMATION_CONFIGS.close;
    this.#startAnimation({
      kind: "close",
      windowId,
      startTime: Date.now(),
      duration: motionDuration(config.duration, this.#reducedMotion),
      fromTransform: config.from,
      toTransform: config.to,
      easing: config.easing,
      onComplete,
    });
  }

  /**
   * Start a window-minimize animation.
   * The window scales down and fades toward the dock area.
   */
  public animateMinimize(
    windowId: GenesisWindowId,
    windowBounds: WindowBounds,
    dockTargetY?: number,
    onComplete?: () => void,
  ): void {
    const config = ANIMATION_CONFIGS.minimize;
    const translateY =
      dockTargetY !== undefined
        ? (dockTargetY - windowBounds.y - windowBounds.height / 2) * 0.3
        : windowBounds.height * 0.2;

    this.#startAnimation({
      kind: "minimize",
      windowId,
      startTime: Date.now(),
      duration: motionDuration(config.duration, this.#reducedMotion),
      fromTransform: IDENTITY_TRANSFORM,
      toTransform: {
        ...config.to,
        translateY,
      },
      easing: config.easing,
      onComplete,
    });
  }

  /**
   * Start a window-restore animation (from minimized state).
   * The window scales up and fades back in.
   */
  public animateRestore(windowId: GenesisWindowId, onComplete?: () => void): void {
    const config = ANIMATION_CONFIGS.restore;
    this.#startAnimation({
      kind: "restore",
      windowId,
      startTime: Date.now(),
      duration: motionDuration(config.duration, this.#reducedMotion),
      fromTransform: config.from,
      toTransform: IDENTITY_TRANSFORM,
      easing: config.easing,
      onComplete,
    });
  }

  /**
   * Start a maximize animation.
   * Smoothly interpolates from current bounds to maximized bounds.
   */
  public animateMaximize(
    windowId: GenesisWindowId,
    previousBounds: WindowBounds,
    onComplete?: () => void,
  ): void {
    const config = ANIMATION_CONFIGS.maximize;
    this.#startAnimation({
      kind: "maximize",
      windowId,
      startTime: Date.now(),
      duration: motionDuration(config.duration, this.#reducedMotion),
      fromTransform: IDENTITY_TRANSFORM,
      toTransform: IDENTITY_TRANSFORM,
      easing: config.easing,
      previousBounds,
      onComplete,
    });
  }

  /**
   * Start a snap animation (window tiling).
   */
  public animateSnap(windowId: GenesisWindowId, onComplete?: () => void): void {
    const config = ANIMATION_CONFIGS.snap;
    this.#startAnimation({
      kind: "snap",
      windowId,
      startTime: Date.now(),
      duration: motionDuration(config.duration, this.#reducedMotion),
      fromTransform: IDENTITY_TRANSFORM,
      toTransform: IDENTITY_TRANSFORM,
      easing: config.easing,
      onComplete,
    });
  }

  /**
   * Get the current visual transform for a window.
   * Returns undefined if no animation is running for this window.
   */
  public getTransform(windowId: GenesisWindowId): WindowAnimationTransform | undefined {
    const anim = this.#animations.get(windowId);
    if (anim === undefined) return undefined;

    const elapsed = Date.now() - anim.startTime;
    if (anim.duration === 0) return undefined;

    const rawProgress = Math.min(1, elapsed / anim.duration);
    const progress = anim.easing(rawProgress);

    return Object.freeze({
      opacity: lerp(anim.fromTransform.opacity, anim.toTransform.opacity, progress),
      scaleX: lerp(anim.fromTransform.scaleX, anim.toTransform.scaleX, progress),
      scaleY: lerp(anim.fromTransform.scaleY, anim.toTransform.scaleY, progress),
      translateX: lerp(
        anim.fromTransform.translateX,
        anim.toTransform.translateX,
        progress,
      ),
      translateY: lerp(
        anim.fromTransform.translateY,
        anim.toTransform.translateY,
        progress,
      ),
    });
  }

  /** Check whether any window is currently animating. */
  public get hasActiveAnimations(): boolean {
    return this.#animations.size > 0;
  }

  /** Check whether a specific window is currently animating. */
  public isAnimating(windowId: GenesisWindowId): boolean {
    return this.#animations.has(windowId);
  }

  /** Cancel any running animation for a window. */
  public cancel(windowId: GenesisWindowId): void {
    this.#animations.delete(windowId);
    if (this.#animations.size === 0) {
      this.#stopTick();
    }
  }

  /** Cancel all running animations. */
  public cancelAll(): void {
    this.#animations.clear();
    this.#stopTick();
  }

  /** Subscribe to animation state changes (for render invalidation). */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Clean up resources. */
  public dispose(): void {
    this.cancelAll();
    this.#listeners.clear();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  #startAnimation(animation: ActiveWindowAnimation): void {
    // Cancel any existing animation for this window
    this.#animations.delete(animation.windowId);

    if (animation.duration === 0) {
      // Reduced motion: skip animation, fire completion immediately
      animation.onComplete?.();
      return;
    }

    this.#animations.set(animation.windowId, animation);
    this.#ensureTick();
  }

  #ensureTick(): void {
    if (this.#timer !== undefined) return;
    this.#tick();
  }

  #tick(): void {
    const now = Date.now();
    const completed: GenesisWindowId[] = [];

    for (const [windowId, anim] of this.#animations) {
      const elapsed = now - anim.startTime;
      if (elapsed >= anim.duration) {
        completed.push(windowId);
      }
    }

    // Complete finished animations
    for (const windowId of completed) {
      const anim = this.#animations.get(windowId);
      this.#animations.delete(windowId);
      anim?.onComplete?.();
    }

    // Notify listeners for render invalidation
    if (this.#listeners.size > 0) {
      for (const listener of this.#listeners) {
        listener();
      }
    }

    // Schedule next tick if animations remain
    if (this.#animations.size > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#tick();
      }, 16); // ~60fps
    } else {
      this.#timer = undefined;
    }
  }

  #stopTick(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
