import { motionDuration, sevynTokens } from "./tokens.js";
export interface MotionValue {
  readonly opacity: number;
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}
export interface MotionTransition {
  readonly from: MotionValue;
  readonly to: MotionValue;
  readonly duration: number;
  readonly spring: typeof sevynTokens.motion.spring;
}
export function createMotionTransition(options: {
  readonly from?: Partial<MotionValue>;
  readonly to?: Partial<MotionValue>;
  readonly duration?: number;
  readonly reducedMotion: boolean;
}): MotionTransition {
  const base = { opacity: 1, scale: 1, translateX: 0, translateY: 0 };
  return Object.freeze({
    from: Object.freeze({ ...base, ...options.from }),
    to: Object.freeze({ ...base, ...options.to }),
    duration: motionDuration(
      options.duration ?? sevynTokens.motion.standard,
      options.reducedMotion,
    ),
    spring: sevynTokens.motion.spring,
  });
}
