import type { ComponentType } from "react";
import {
  defineSystemApplication,
  type SystemApplicationContext,
  type SystemApplicationManifest,
  type SystemApplicationModule,
  type SystemApplicationStopReason,
} from "@sevynos/shell-core";

export interface SystemApplicationOptions<State = unknown, Props = unknown> {
  readonly render?: (input: unknown) => unknown;
  readonly component?: ComponentType<Props>;
  readonly start?: (context: SystemApplicationContext) => void | Promise<void>;
  readonly stop?: (reason: SystemApplicationStopReason) => void | Promise<void>;
  readonly captureState?: () => State;
}

export function createSystemApplication<State = unknown, Props = unknown>(
  manifest: SystemApplicationManifest,
  renderOrOptions?:
    ((input: unknown) => unknown) | SystemApplicationOptions<State, Props>,
): SystemApplicationModule<State> {
  const options: SystemApplicationOptions<State, Props> =
    typeof renderOrOptions === "function"
      ? { render: renderOrOptions }
      : (renderOrOptions ?? { render: () => Object.freeze([]) });

  return defineSystemApplication<State>({
    manifest,
    create: (context, preservedState) => {
      const state = preservedState ?? (Object.freeze({}) as State);
      return {
        start: () => options.start?.(context),
        stop: (reason) => options.stop?.(reason),
        captureState: () => (options.captureState ? options.captureState() : state),
        render: options.render ?? (() => Object.freeze([])),
        component: options.component,
      };
    },
  });
}

export function createReactNativeSystemApplication<Props = unknown, State = unknown>(
  manifest: SystemApplicationManifest,
  component: ComponentType<Props>,
  options: Omit<SystemApplicationOptions<State, Props>, "component"> = {},
): SystemApplicationModule<State> {
  return createSystemApplication<State, Props>(manifest, {
    ...options,
    component,
    render: options.render ?? (() => Object.freeze([])),
  });
}

export function systemApplicationManifest(options: {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly supportedDeviceClasses: readonly string[];
}): SystemApplicationManifest {
  return Object.freeze({
    ...options,
    version: "0.1.0",
  });
}
