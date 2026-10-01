import { createElement, type ComponentType } from "react";
import {
  SevynApplicationRuntime,
  type NativeBounds,
  type NativeRuntimeSnapshot,
} from "@sevynos/react-native/internal";
import type { DesktopShellSurfaceSceneNode } from "@sevynos/system-applications/desktop";

/**
 * Renders React Native shell components (dock, status bar, etc.) to native
 * snapshots. Each shell application gets a persistent SevynApplicationRuntime
 * so component state survives across frames.
 *
 * This is the bridge that lets the entire desktop shell be written in React
 * Native instead of native TypeScript scene-node builders.
 */
export class ShellComponentRenderer {
  readonly #runtimes = new Map<string, SevynApplicationRuntime>();
  readonly #onInvalidate: () => void;

  public constructor(onInvalidate: () => void) {
    this.#onInvalidate = onInvalidate;
  }

  /**
   * Render a shell component with the given props.
   * On first call, mounts the component. On subsequent calls, updates props.
   * Returns the scene node, or undefined if rendering failed.
   */
  public render(
    applicationId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: ComponentType<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props: any,
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    order: number,
    displayId: string,
  ): DesktopShellSurfaceSceneNode | undefined {
    try {
      const nativeBounds: NativeBounds = {
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      };
      let runtime = this.#runtimes.get(applicationId);
      if (runtime === undefined) {
        runtime = new SevynApplicationRuntime({
          bounds: nativeBounds,
          appearance: "dark",
          accent: "#D7AC57",
          onInvalidate: this.#onInvalidate,
        });
        runtime.mount(createElement(component, props));
        this.#runtimes.set(applicationId, runtime);
      } else {
        runtime.configure({ bounds: nativeBounds }, false);
        runtime.update(createElement(component, props));
      }
      const snapshot: NativeRuntimeSnapshot = runtime.snapshot;
      // If the component returned null (e.g. closed Launcher), it produces
      // zero commands. Return undefined so the composer skips this surface
      // entirely, instead of emitting a full-bounds opaque node that would
      // cover the wallpaper.
      if (snapshot.commands.length === 0) {
        return undefined;
      }
      return {
        kind: "desktop-shell-surface",
        order,
        bounds: { ...bounds },
        displayId,
        applicationId,
        nativeSurface: { commands: snapshot.commands },
      };
    } catch (error) {
      console.error(
        `Shell component render failed for "${applicationId}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Dispatch a pointer event to a shell component.
   * Coordinates are in surface-local space.
   */
  public dispatchPointer(
    applicationId: string,
    type: "down" | "up" | "move" | "cancel",
    x: number,
    y: number,
  ): boolean {
    const runtime = this.#runtimes.get(applicationId);
    if (runtime === undefined) return false;
    try {
      runtime.dispatchPointer(type, {
        x,
        y,
        pointerId: 1,
        button: "primary",
        buttons: type === "up" ? [] : ["primary"],
      } as never);
      return true;
    } catch {
      return false;
    }
  }

  public dispose(applicationId: string): void {
    const runtime = this.#runtimes.get(applicationId);
    if (runtime !== undefined) {
      try {
        runtime.unmount();
      } catch {
        // Ignore
      }
      this.#runtimes.delete(applicationId);
    }
  }

  public disposeAll(): void {
    for (const id of [...this.#runtimes.keys()]) this.dispose(id);
  }
}
