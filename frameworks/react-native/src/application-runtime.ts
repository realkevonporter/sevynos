import type { ReactNode } from "react";
import { layoutNativeTree } from "./layout.js";
import type {
  AccessibilityNode,
  NativeBounds,
  NativeChild,
  NativeHostNode,
  NativeKeyboardEvent,
  NativePointerEvent,
  NativeTouchEvent,
  NativeRuntimeSnapshot,
} from "./native-types.js";
import {
  createNativeReconcilerRoot,
  type NativeReconcilerRoot,
  type NativeRootContainer,
} from "./reconciler.js";
import type { NativeRenderCommand } from "./surface.js";
import { Appearance } from "./appearance.js";
import { PixelRatio } from "./pixel-ratio.js";
import { Dimensions } from "./stylesheet.js";
import { getNativeAdapters } from "./native-adapter-contracts.js";
import {
  consumePendingLayoutAnimation,
  driveLayoutAnimation,
} from "./layout-animation.js";
import {
  getActiveActionSheet,
  subscribeActionSheet,
  type ActiveActionSheet,
} from "./action-sheet.js";

export interface SevynApplicationRuntimeOptions {
  readonly bounds: NativeBounds;
  readonly appearance?: "light" | "dark";
  readonly accent?: string;
  readonly reducedMotion?: boolean;
  readonly scaleFactor?: number;
  readonly fontScale?: number;
  readonly onInvalidate?: () => void;
  readonly onError?: (error: Error) => void;
  readonly onRestart?: () => void;
  readonly onClose?: () => void;
  readonly onViewDiagnostics?: () => void;
}
type RuntimeListener = (snapshot: NativeRuntimeSnapshot) => void;
const emptySnapshot = (): NativeRuntimeSnapshot =>
  Object.freeze({
    revision: 0,
    commands: Object.freeze([]),
    accessibility: Object.freeze([]),
    overlays: Object.freeze([]),
    changedNodeIds: Object.freeze([]),
  });

interface ActionSheetButtonLayout {
  readonly index: number;
  readonly label: string;
  readonly bounds: NativeBounds;
  readonly isDestructive: boolean;
  readonly isDisabled: boolean;
  readonly isCancel: boolean;
}

interface ActionSheetLayout {
  readonly panelBounds: NativeBounds;
  readonly headerBounds?: NativeBounds | undefined;
  readonly buttonBounds: readonly ActionSheetButtonLayout[];
}

export class SevynApplicationRuntime {
  readonly #container: NativeRootContainer;
  readonly #root: NativeReconcilerRoot;
  readonly #listeners = new Set<RuntimeListener>();
  readonly #onInvalidate: () => void;
  readonly #onError: (error: Error) => void;
  readonly #onRestart: () => void;
  readonly #onClose: () => void;
  readonly #onViewDiagnostics: () => void;
  #snapshot: NativeRuntimeSnapshot = emptySnapshot();
  #boundsById: ReadonlyMap<string, NativeBounds> = new Map();
  #commandCache = new Map<string, NativeRenderCommand>();
  #bounds: NativeBounds;
  #appearance: "light" | "dark";
  #accent: string;
  #reducedMotion: boolean;
  #scaleFactor: number;
  #fontScale: number;
  #focusedId: string | undefined;
  #hoveredId: string | undefined;
  #pressedId: string | undefined;
  #responderId: string | undefined;
  readonly #selectionById = new Map<string, { start: number; end: number }>();
  #invalidationPending = false;
  #suppressInvalidation = false;
  #suppressNextCommit = false;
  #activeLayoutAnimation: { stop(): void } | undefined;
  #unsubscribeActionSheet: (() => void) | undefined;
  #mounted = false;

  public constructor(options: SevynApplicationRuntimeOptions) {
    this.#bounds = options.bounds;
    this.#appearance = options.appearance ?? "dark";
    this.#accent = options.accent ?? "#D7AC57";
    this.#reducedMotion = options.reducedMotion ?? false;
    this.#scaleFactor = Math.max(1, options.scaleFactor ?? 1);
    this.#fontScale = Math.max(0.5, options.fontScale ?? 1);
    this.#syncPlatformEnvironment();
    this.#onInvalidate = options.onInvalidate ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#onRestart = options.onRestart ?? (() => undefined);
    this.#onClose = options.onClose ?? (() => undefined);
    this.#onViewDiagnostics = options.onViewDiagnostics ?? (() => undefined);
    this.#container = {
      roots: [],
      nextNodeNumber: 0,
      revision: 0,
      changedNodeIds: new Set(),
      onCommit: () => {
        this.#commitSnapshot();
      },
      onError: (error) => {
        this.#handleCrash(error);
      },
    };
    this.#root = createNativeReconcilerRoot(this.#container);
    this.#unsubscribeActionSheet = subscribeActionSheet(() => {
      if (this.#mounted) {
        this.#commitSnapshot();
      }
    });
  }

  public get snapshot(): NativeRuntimeSnapshot {
    return this.#snapshot;
  }
  public get mounted(): boolean {
    return this.#mounted;
  }
  public mount(tree: ReactNode, invalidate = true): void {
    if (this.#mounted) throw new Error("The Sevyn application is already mounted.");
    this.#mounted = true;
    this.#render(tree, invalidate);
  }
  public update(tree: ReactNode, invalidate = true): void {
    if (!this.#mounted) throw new Error("The Sevyn application is not mounted.");
    this.#render(tree, invalidate);
  }
  public unmount(): void {
    if (!this.#mounted) return;
    if (this.#activeLayoutAnimation !== undefined) {
      this.#activeLayoutAnimation.stop();
      this.#activeLayoutAnimation = undefined;
    }
    if (this.#unsubscribeActionSheet !== undefined) {
      this.#unsubscribeActionSheet();
      this.#unsubscribeActionSheet = undefined;
    }
    this.#root.render(null);
    this.#mounted = false;
    this.#focusedId = undefined;
    this.#selectionById.clear();
  }
  public configure(
    options: {
      readonly bounds?: NativeBounds;
      readonly appearance?: "light" | "dark";
      readonly accent?: string;
      readonly reducedMotion?: boolean;
      readonly scaleFactor?: number;
      readonly fontScale?: number;
    },
    invalidate = true,
  ): void {
    let changed = false;
    if (
      options.bounds !== undefined &&
      (options.bounds.x !== this.#bounds.x ||
        options.bounds.y !== this.#bounds.y ||
        options.bounds.width !== this.#bounds.width ||
        options.bounds.height !== this.#bounds.height)
    ) {
      this.#bounds = options.bounds;
      changed = true;
    }
    if (options.appearance !== undefined && options.appearance !== this.#appearance) {
      this.#appearance = options.appearance;
      changed = true;
    }
    if (options.accent !== undefined && options.accent !== this.#accent) {
      this.#accent = options.accent;
      changed = true;
    }
    if (
      options.reducedMotion !== undefined &&
      options.reducedMotion !== this.#reducedMotion
    ) {
      this.#reducedMotion = options.reducedMotion;
      changed = true;
    }
    if (options.scaleFactor !== undefined && options.scaleFactor !== this.#scaleFactor) {
      this.#scaleFactor = Math.max(1, options.scaleFactor);
      changed = true;
    }
    if (options.fontScale !== undefined && options.fontScale !== this.#fontScale) {
      this.#fontScale = Math.max(0.5, options.fontScale);
      changed = true;
    }
    if (changed) {
      this.#syncPlatformEnvironment();
      const previous = this.#suppressInvalidation;
      this.#suppressInvalidation = !invalidate;
      this.#commitSnapshot();
      this.#suppressInvalidation = previous;
    }
  }
  public subscribe(listener: RuntimeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #syncPlatformEnvironment(): void {
    Appearance.setColorScheme(this.#appearance);
    PixelRatio._setPixelRatio(this.#scaleFactor);
    PixelRatio._setFontScale(this.#fontScale);
    Dimensions.set({
      width: this.#bounds.width,
      height: this.#bounds.height,
      scale: this.#scaleFactor,
      fontScale: this.#fontScale,
    });
  }

  public recover(action: "restart" | "close" | "diagnostics"): void {
    switch (action) {
      case "restart":
        this.#onRestart();
        return;
      case "close":
        this.#onClose();
        return;
      case "diagnostics":
        this.#onViewDiagnostics();
    }
  }

  #findInteractiveAncestor(node: NativeHostNode | undefined): NativeHostNode | undefined {
    let current = node;
    while (current !== undefined) {
      if (
        current.props.onPress !== undefined ||
        current.type === "button" ||
        current.type === "toggle" ||
        current.type === "segment" ||
        current.type === "select" ||
        current.props.role === "button" ||
        current.props.role === "tab" ||
        current.props.role === "checkbox" ||
        current.props.role === "menuitem"
      ) {
        return current;
      }
      current = current.parent;
    }
    return undefined;
  }

  public dispatchPointer(
    type: "enter" | "leave" | "move" | "down" | "up" | "cancel",
    event: NativePointerEvent,
  ): void {
    const activeSheet = getActiveActionSheet();
    if (activeSheet !== null) {
      const layout = this.#getActionSheetLayout(activeSheet);
      const hitButton = layout.buttonBounds.find(
        (b) =>
          event.x >= b.bounds.x &&
          event.x <= b.bounds.x + b.bounds.width &&
          event.y >= b.bounds.y &&
          event.y <= b.bounds.y + b.bounds.height,
      );

      if (type === "down") {
        if (hitButton !== undefined && !hitButton.isDisabled) {
          this.#pressedId = `${activeSheet.id}.button.${String(hitButton.index)}`;
          this.#commitSnapshot();
        }
      } else if (type === "up") {
        const pressedButton = this.#pressedId;
        this.#pressedId = undefined;
        if (hitButton !== undefined && !hitButton.isDisabled) {
          if (pressedButton === `${activeSheet.id}.button.${String(hitButton.index)}`) {
            activeSheet.select(hitButton.index);
            return;
          }
        }
        const inPanel =
          event.x >= layout.panelBounds.x &&
          event.x <= layout.panelBounds.x + layout.panelBounds.width &&
          event.y >= layout.panelBounds.y &&
          event.y <= layout.panelBounds.y + layout.panelBounds.height;
        if (!inPanel) {
          activeSheet.cancel();
          return;
        }
        this.#commitSnapshot();
      } else if (type === "cancel") {
        this.#pressedId = undefined;
        this.#commitSnapshot();
      }
      return;
    }

    const target = this.#hitTest(event.x, event.y);
    const targetBounds =
      target === undefined ? undefined : this.#boundsById.get(target.id);
    const targetEvent =
      targetBounds === undefined
        ? event
        : {
            ...event,
            x: event.x - targetBounds.x,
            y: event.y - targetBounds.y,
          };
    if (type === "enter" && target?.id !== this.#hoveredId) {
      const previous = this.#findNode(this.#hoveredId);
      previous?.props.onPointerLeave?.(event);
      const interactive = this.#findInteractiveAncestor(target);
      this.#hoveredId = (interactive ?? target)?.id;
      target?.props.onPointerEnter?.(targetEvent);
      this.#commitSnapshot();
    }
    if (type === "leave") {
      target?.props.onPointerLeave?.(targetEvent);
      this.#hoveredId = undefined;
      this.#commitSnapshot();
    }
    if (type === "move") {
      target?.props.onPointerMove?.(targetEvent);
      let responder = this.#findNode(this.#responderId);
      if (responder === undefined) {
        let candidate = target;
        while (candidate !== undefined) {
          if (candidate.props.onMoveShouldSetResponder?.(targetEvent) === true) {
            this.#responderId = candidate.id;
            candidate.props.onResponderGrant?.(targetEvent);
            responder = candidate;
            break;
          }
          candidate = candidate.parent;
        }
      }
      responder?.props.onResponderMove?.(targetEvent);
    }
    if (type === "down") {
      const interactive = this.#findInteractiveAncestor(target);
      this.#pressedId = (interactive ?? target)?.id;
      target?.props.onPointerDown?.(targetEvent);
      let candidate: NativeHostNode | undefined = target;
      while (candidate !== undefined) {
        if (candidate.props.onStartShouldSetResponder?.(targetEvent) === true) {
          const previous = this.#findNode(this.#responderId);
          if (previous !== undefined && previous.id !== candidate.id)
            previous.props.onResponderTerminate?.(targetEvent);
          this.#responderId = candidate.id;
          candidate.props.onResponderGrant?.(targetEvent);
          break;
        }
        candidate = candidate.parent;
      }
      let focusable: NativeHostNode | undefined = target;
      while (focusable !== undefined && !this.#isFocusable(focusable)) {
        focusable = focusable.parent;
      }
      if (focusable !== undefined) this.#focus(focusable.id);
      if (target?.type === "input" && target.props.editable !== false) {
        this.#placeTextCursor(target, targetEvent.x);
      }
      this.#commitSnapshot();
    }
    if (type === "up") {
      target?.props.onPointerUp?.(targetEvent);
      const interactive = this.#findInteractiveAncestor(target);
      const activeTarget = interactive ?? target;
      if (
        activeTarget !== undefined &&
        (activeTarget.id === this.#pressedId || target?.id === this.#pressedId) &&
        !activeTarget.props.disabled
      )
        this.#activate(activeTarget);
      this.#pressedId = undefined;
      const responder = this.#findNode(this.#responderId);
      responder?.props.onResponderRelease?.(targetEvent);
      this.#responderId = undefined;
      this.#commitSnapshot();
    }
    if (type === "cancel") {
      const responder = this.#findNode(this.#responderId);
      responder?.props.onResponderTerminate?.(targetEvent);
      this.#responderId = undefined;
      this.#pressedId = undefined;
      this.#commitSnapshot();
    }
  }

  public dispatchWheel(event: {
    readonly x: number;
    readonly y: number;
    readonly deltaX: number;
    readonly deltaY: number;
  }): void {
    let current = this.#hitTest(event.x, event.y);
    while (current !== undefined) {
      if (current.props.onWheel !== undefined) {
        current.props.onWheel(event);
        return;
      }
      if (current.type === "scroll" || current.props.style?.overflow === "scroll") {
        const currentOffset = current.props.style?.scrollOffset ?? 0;
        if (
          currentOffset <= 0 &&
          event.deltaY < 0 &&
          current.props.refreshing !== true &&
          current.props.onRefresh !== undefined
        ) {
          current.props.onRefresh();
          return;
        }
        this.scroll(current.id, currentOffset + event.deltaY);
        return;
      }
      current = current.parent;
    }
  }

  public dispatchTouch(
    type: "start" | "move" | "end" | "cancel",
    event: NativeTouchEvent,
  ): void {
    const point = event.changedTouches[0];
    if (point === undefined) return;
    const target = this.#hitTest(point.x, point.y);
    if (target === undefined) return;
    const bounds = this.#boundsById.get(target.id);
    const localize = (p: typeof point) =>
      bounds === undefined ? p : { ...p, x: p.x - bounds.x, y: p.y - bounds.y };
    const localized: NativeTouchEvent = {
      touches: event.touches.map(localize),
      changedTouches: event.changedTouches.map(localize),
    };
    const interactive = this.#findInteractiveAncestor(target) ?? target;
    if (type === "start") {
      this.#pressedId = interactive.id;
      target.props.onTouchStart?.(localized);
      if (this.#isFocusable(target)) this.#focus(target.id);
      this.#commitSnapshot();
    } else if (type === "move") target.props.onTouchMove?.(localized);
    else if (type === "cancel") {
      target.props.onTouchCancel?.(localized);
      this.#pressedId = undefined;
      this.#commitSnapshot();
    } else {
      target.props.onTouchEnd?.(localized);
      if (interactive.id === this.#pressedId && !interactive.props.disabled)
        this.#activate(interactive);
      this.#pressedId = undefined;
      this.#commitSnapshot();
    }
  }

  public cursorKindAt(x: number, y: number): "text" | "pointer" | "default" {
    const activeSheet = getActiveActionSheet();
    if (activeSheet !== null) {
      const layout = this.#getActionSheetLayout(activeSheet);
      const hit = layout.buttonBounds.some(
        (b) =>
          !b.isDisabled &&
          x >= b.bounds.x &&
          x <= b.bounds.x + b.bounds.width &&
          y >= b.bounds.y &&
          y <= b.bounds.y + b.bounds.height,
      );
      return hit ? "pointer" : "default";
    }
    const target = this.#hitTest(x, y);
    if (target?.type === "input" && !target.props.disabled) return "text";
    if (target !== undefined && this.#findInteractiveAncestor(target) !== undefined)
      return "pointer";
    return "default";
  }

  public dispatchKeyboard(type: "down" | "up", event: NativeKeyboardEvent): void {
    if (event.key === "Escape") {
      const activeSheet = getActiveActionSheet();
      if (activeSheet !== null) {
        activeSheet.cancel();
        return;
      }
    }
    if (type === "down" && event.key === "Tab") {
      this.#traverseFocus(event.shift ? -1 : 1);
      return;
    }
    const target = this.#findNode(this.#focusedId);
    if (target === undefined) return;
    if (type === "up") {
      target.props.onKeyUp?.(event);
      return;
    }
    target.props.onKeyDown?.(event);
    if ((event.key === "Enter" || event.key === " ") && !target.props.disabled)
      this.#activate(target);
    if (event.key === "Escape") {
      const overlay = this.#topOverlay();
      if (overlay !== undefined) overlay.props.onDismiss?.();
    }
    if (target.type === "input") this.#handleTextInput(target, event);
    if (
      (target.type === "segment" || target.type === "select") &&
      (event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown")
    )
      this.#moveSelection(
        target,
        event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1,
      );
    if (
      target.type === "slider" &&
      (event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown")
    )
      this.#adjustSlider(
        target,
        event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1,
      );
  }

  public scroll(targetId: string, offset: number): void {
    const target = this.#findNode(targetId);
    if (
      target === undefined ||
      (target.type !== "scroll" && target.props.style?.overflow !== "scroll")
    )
      return;
    target.props = {
      ...target.props,
      style: { ...target.props.style, scrollOffset: Math.max(0, offset) },
    };
    target.dirty = true;
    target.props.onScroll?.(offset);
    this.#commitSnapshot();
  }

  #commitSnapshot(): void {
    const suppressCommitInvalidation = this.#suppressNextCommit;
    this.#suppressNextCommit = false;
    const changed: string[] = [];
    this.#walk((node) => {
      if (node.dirty) changed.push(node.id);
    });
    const layout = layoutNativeTree({
      roots: this.#container.roots,
      bounds: this.#bounds,
      appearance: this.#appearance,
      accent: this.#accent,
      reducedMotion: this.#reducedMotion,
      revision: this.#container.revision,
      changedNodeIds: changed,
      ...(this.#focusedId === undefined ? {} : { focusId: this.#focusedId }),
      ...(this.#pressedId === undefined ? {} : { pressedId: this.#pressedId }),
      ...(this.#hoveredId === undefined ? {} : { hoveredId: this.#hoveredId }),
      commandCache: this.#commandCache,
    });
    const baseSnapshot = layout.snapshot;
    this.#boundsById = layout.boundsById;
    this.#commandCache = layout.commandCache;
    this.#container.changedNodeIds.clear();

    const pendingLayoutAnimation = consumePendingLayoutAnimation();
    if (
      pendingLayoutAnimation !== undefined &&
      !this.#reducedMotion &&
      this.#snapshot.commands.length > 0 &&
      baseSnapshot.commands.length > 0
    ) {
      if (this.#activeLayoutAnimation !== undefined) {
        this.#activeLayoutAnimation.stop();
        this.#activeLayoutAnimation = undefined;
      }
      const targetSnapshot = this.#applyActionSheetOverlay(baseSnapshot);
      this.#activeLayoutAnimation = driveLayoutAnimation({
        startSnapshot: this.#snapshot,
        targetSnapshot,
        config: pendingLayoutAnimation.config,
        onFrame: (animatedSnapshot) => {
          this.#snapshot = animatedSnapshot;
          for (const listener of this.#listeners) listener(this.#snapshot);
          this.#onInvalidate();
        },
        onComplete: () => {
          this.#activeLayoutAnimation = undefined;
          pendingLayoutAnimation.onEnd?.();
        },
        onCancel: () => {
          this.#activeLayoutAnimation = undefined;
          pendingLayoutAnimation.onFail?.();
        },
      });
      return;
    }

    if (this.#activeLayoutAnimation !== undefined) {
      this.#activeLayoutAnimation.stop();
      this.#activeLayoutAnimation = undefined;
    }
    if (pendingLayoutAnimation !== undefined) {
      pendingLayoutAnimation.onEnd?.();
    }

    this.#snapshot = this.#applyActionSheetOverlay(baseSnapshot);
    for (const listener of this.#listeners) listener(this.#snapshot);
    if (
      !this.#suppressInvalidation &&
      !suppressCommitInvalidation &&
      !this.#invalidationPending
    ) {
      this.#invalidationPending = true;
      queueMicrotask(() => {
        this.#invalidationPending = false;
        this.#onInvalidate();
      });
    }
  }

  #getActionSheetLayout(sheet: ActiveActionSheet): ActionSheetLayout {
    const sheetWidth = Math.min(380, Math.max(260, this.#bounds.width - 32));
    const panelX = Math.round(this.#bounds.x + (this.#bounds.width - sheetWidth) / 2);

    const hasTitle =
      sheet.options.title !== undefined && sheet.options.title.trim() !== "";
    const hasMessage =
      sheet.options.message !== undefined && sheet.options.message.trim() !== "";
    const hasHeader = hasTitle || hasMessage;
    const headerHeight = hasHeader ? 16 + (hasTitle ? 22 : 0) + (hasMessage ? 18 : 0) : 0;

    const numOptions = sheet.options.options.length;
    const buttonHeight = 40;
    const buttonGap = 8;
    const padding = 16;
    const totalHeight =
      padding * 2 +
      headerHeight +
      (numOptions > 0 ? numOptions * (buttonHeight + buttonGap) - buttonGap : 0);
    const panelY = Math.max(
      this.#bounds.y + 16,
      Math.round(this.#bounds.y + this.#bounds.height - totalHeight - 24),
    );

    const destructiveIndices = new Set(
      Array.isArray(sheet.options.destructiveButtonIndex)
        ? sheet.options.destructiveButtonIndex
        : sheet.options.destructiveButtonIndex !== undefined
          ? [sheet.options.destructiveButtonIndex]
          : [],
    );
    const disabledIndices = new Set(sheet.options.disabledButtonIndices ?? []);

    const buttonBounds = sheet.options.options.map((label, index) => {
      const btnY = panelY + padding + headerHeight + index * (buttonHeight + buttonGap);
      return {
        index,
        label,
        bounds: {
          x: panelX + padding,
          y: btnY,
          width: sheetWidth - padding * 2,
          height: buttonHeight,
        },
        isDestructive: destructiveIndices.has(index),
        isDisabled: disabledIndices.has(index),
        isCancel: sheet.options.cancelButtonIndex === index,
      };
    });

    return {
      panelBounds: {
        x: panelX,
        y: panelY,
        width: sheetWidth,
        height: totalHeight,
      },
      headerBounds: hasHeader
        ? {
            x: panelX + padding,
            y: panelY + padding,
            width: sheetWidth - padding * 2,
            height: headerHeight,
          }
        : undefined,
      buttonBounds,
    };
  }

  #applyActionSheetOverlay(baseSnapshot: NativeRuntimeSnapshot): NativeRuntimeSnapshot {
    const sheet = getActiveActionSheet();
    if (sheet === null) return baseSnapshot;

    const layout = this.#getActionSheetLayout(sheet);
    const overlayCommands: NativeRenderCommand[] = [];

    // Backdrop scrim
    overlayCommands.push(
      Object.freeze({
        kind: "material",
        id: `${sheet.id}.backdrop`,
        bounds: this.#bounds,
        color: "#00000066",
        radius: 0,
      }),
    );

    // Sheet panel
    overlayCommands.push(
      Object.freeze({
        kind: "material",
        id: `${sheet.id}.panel`,
        bounds: layout.panelBounds,
        color: this.#appearance === "light" ? "#F5F6F8F0" : "#1E222BF0",
        radius: 16,
        radii: { topLeft: 16, topRight: 16, bottomLeft: 16, bottomRight: 16 },
        borderWidth: 1,
        borderColor: this.#appearance === "light" ? "#00000015" : "#FFFFFF15",
        backdropBlur: 20,
        shadow: { color: "#00000044", blur: 16, y: 4 },
      }),
    );

    // Title / message header
    if (layout.headerBounds !== undefined) {
      let currentY = layout.headerBounds.y;
      if (sheet.options.title !== undefined && sheet.options.title.trim() !== "") {
        overlayCommands.push(
          Object.freeze({
            kind: "text",
            id: `${sheet.id}.title`,
            bounds: {
              x: layout.headerBounds.x,
              y: currentY,
              width: layout.headerBounds.width,
              height: 22,
            },
            text: sheet.options.title,
            color: this.#appearance === "light" ? "#1A1A1A" : "#F5F6F8",
            size: 15,
            weight: 600,
            align: "center",
          }),
        );
        currentY += 22;
      }
      if (sheet.options.message !== undefined && sheet.options.message.trim() !== "") {
        overlayCommands.push(
          Object.freeze({
            kind: "text",
            id: `${sheet.id}.message`,
            bounds: {
              x: layout.headerBounds.x,
              y: currentY,
              width: layout.headerBounds.width,
              height: 18,
            },
            text: sheet.options.message,
            color: this.#appearance === "light" ? "#6B7280" : "#9CA3AF",
            size: 12,
            weight: 400,
            align: "center",
          }),
        );
      }
    }

    // Option buttons
    for (const btn of layout.buttonBounds) {
      const isPressed = this.#pressedId === `${sheet.id}.button.${String(btn.index)}`;
      const defaultBg = this.#appearance === "light" ? "#E5E7EB" : "#2B303A";
      const pressedBg = this.#appearance === "light" ? "#D1D5DB" : "#3B4252";
      const bg = isPressed ? pressedBg : defaultBg;
      const fg = btn.isDestructive
        ? "#ED7780"
        : btn.isCancel
          ? this.#accent
          : this.#appearance === "light"
            ? "#1A1A1A"
            : "#F5F6F8";

      overlayCommands.push(
        Object.freeze({
          kind: "material",
          id: `${sheet.id}.button.${String(btn.index)}.bg`,
          bounds: btn.bounds,
          color: bg,
          radius: 8,
          borderWidth: 1,
          borderColor: this.#appearance === "light" ? "#00000010" : "#FFFFFF10",
          opacity: btn.isDisabled ? 0.4 : 1,
        }),
      );

      overlayCommands.push(
        Object.freeze({
          kind: "text",
          id: `${sheet.id}.button.${String(btn.index)}.label`,
          bounds: {
            x: btn.bounds.x,
            y: btn.bounds.y + 11,
            width: btn.bounds.width,
            height: 18,
          },
          text: btn.label,
          color: fg,
          size: 14,
          weight: btn.isCancel ? 600 : 500,
          align: "center",
          opacity: btn.isDisabled ? 0.4 : 1,
        }),
      );
    }

    return Object.freeze({
      revision: baseSnapshot.revision,
      commands: Object.freeze([...baseSnapshot.commands, ...overlayCommands]),
      accessibility: baseSnapshot.accessibility,
      ...(baseSnapshot.focusId === undefined ? {} : { focusId: baseSnapshot.focusId }),
      overlays: Object.freeze([...baseSnapshot.overlays, sheet.id]),
      changedNodeIds: Object.freeze([...baseSnapshot.changedNodeIds, sheet.id]),
    });
  }
  #handleCrash(error: Error): void {
    this.#onError(error);
    const command: NativeRenderCommand = Object.freeze({
      kind: "text",
      id: "application-crash",
      bounds: this.#bounds,
      text: "This application stopped unexpectedly.",
      color: "#ED7780",
      size: 16,
      weight: 600,
    });
    const accessibility: AccessibilityNode = Object.freeze({
      id: "application-crash",
      role: "application",
      label: "Application error",
      description: "Application failure isolated by SevynOS.",
      disabled: false,
      selected: false,
      focusOrder: 0,
      bounds: this.#bounds,
      children: Object.freeze([]),
    });
    const recoveryActions: readonly {
      readonly action:
        "application-restart" | "application-close" | "application-diagnostics";
      readonly label: string;
      readonly index: number;
    }[] = [
      { action: "application-restart", label: "Restart", index: 0 },
      { action: "application-close", label: "Close", index: 1 },
      { action: "application-diagnostics", label: "View diagnostics", index: 2 },
    ];
    const recoveryControls: readonly NativeRenderCommand[] = recoveryActions.map(
      ({ action, label, index }) =>
        Object.freeze({
          kind: "control",
          id: `${action}.control`,
          bounds: {
            x: this.#bounds.x + 24 + index * 150,
            y: this.#bounds.y + 76,
            width: 138,
            height: 38,
          },
          action,
          label,
          value: "",
          state: "idle",
          accent: this.#accent,
          foreground: "#F5F6F8",
          background: "#30343B",
          radius: 8,
        }),
    );
    this.#snapshot = Object.freeze({
      revision: this.#container.revision,
      commands: Object.freeze([command, ...recoveryControls]),
      accessibility: Object.freeze([accessibility]),
      overlays: Object.freeze([]),
      changedNodeIds: Object.freeze(["application-crash"]),
    });
    this.#onInvalidate();
  }
  #walk(visitor: (node: NativeHostNode) => void): void {
    const visit = (child: NativeChild): void => {
      if (child.kind === "raw-text") return;
      visitor(child);
      child.children.forEach(visit);
    };
    this.#container.roots.forEach(visit);
  }
  #findNode(id: string | undefined): NativeHostNode | undefined {
    if (id === undefined) return undefined;
    let found: NativeHostNode | undefined;
    this.#walk((node) => {
      if (node.id === id) found = node;
    });
    return found;
  }
  #hitTest(x: number, y: number): NativeHostNode | undefined {
    const candidates: NativeHostNode[] = [];
    this.#walk((node) => {
      const bounds = this.#boundsById.get(node.id);
      if (
        bounds !== undefined &&
        x >= bounds.x &&
        x < bounds.x + bounds.width &&
        y >= bounds.y &&
        y < bounds.y + bounds.height
      )
        candidates.push(node);
    });
    return candidates.reverse().find((node) => node.props.disabled !== true);
  }
  #isFocusable(node: NativeHostNode): boolean {
    return (
      node.props.role === "button" ||
      node.props.role === "checkbox" ||
      node.props.role === "menuitem" ||
      node.props.role === "slider" ||
      node.props.role === "tab" ||
      node.props.role === "textbox"
    );
  }
  #focus(id: string): void {
    if (id === this.#focusedId) return;
    this.#findNode(this.#focusedId)?.props.onBlur?.();
    this.#focusedId = id;
    const focused = this.#findNode(id);
    if (focused?.type === "input" && !this.#selectionById.has(id)) {
      const value = String(focused.props.value ?? focused.props.defaultValue ?? "");
      this.#setSelection(
        focused,
        focused.props.selection ?? { start: value.length, end: value.length },
      );
    }
    focused?.props.onFocus?.();
    this.#commitSnapshot();
  }
  #focusableNodes(): readonly AccessibilityNode[] {
    const output: AccessibilityNode[] = [];
    const visit = (nodes: readonly AccessibilityNode[]): void => {
      nodes.forEach((node) => {
        if (
          ["button", "checkbox", "menuitem", "slider", "tab", "textbox"].includes(
            node.role,
          ) &&
          !node.disabled
        )
          output.push(node);
        visit(node.children);
      });
    };
    visit(this.#snapshot.accessibility);
    return output.sort((first, second) => first.focusOrder - second.focusOrder);
  }
  #traverseFocus(direction: 1 | -1): void {
    const overlay = this.#topOverlay();
    const all = this.#focusableNodes().filter(
      (node) => overlay === undefined || this.#isDescendantOf(node.id, overlay.id),
    );
    if (all.length === 0) return;
    const current = all.findIndex((node) => node.id === this.#focusedId);
    const next = all[(current + direction + all.length) % all.length];
    if (next !== undefined) this.#focus(next.id);
  }
  #isDescendantOf(id: string, ancestorId: string): boolean {
    let node = this.#findNode(id);
    while (node !== undefined) {
      if (node.id === ancestorId) return true;
      node = node.parent;
    }
    return false;
  }
  #topOverlay(): NativeHostNode | undefined {
    const id = this.#snapshot.overlays.at(-1);
    return this.#findNode(id);
  }
  #handleTextInput(target: NativeHostNode, event: NativeKeyboardEvent): void {
    if (target.props.editable === false) return;
    const controlled = typeof target.props.value === "string";
    const current = String(target.props.value ?? target.props.defaultValue ?? "");
    const key =
      event.key === "\r" || event.key === "\n"
        ? "Enter"
        : event.key === "\x08" || event.key === "\x7f"
          ? "Backspace"
          : event.key;
    const selected = this.#selectionById.get(target.id) ??
      target.props.selection ?? {
        start: current.length,
        end: current.length,
      };
    const start = Math.max(0, Math.min(current.length, selected.start));
    const end = Math.max(start, Math.min(current.length, selected.end));
    const modifier = event.control || event.meta;
    if (modifier && key.length === 1) {
      switch (key.toLowerCase()) {
        case "a":
          this.#setSelection(target, { start: 0, end: current.length });
          this.#commitSnapshot();
          return;
        case "c":
          if (end > start)
            void getNativeAdapters().clipboard?.writeText(current.slice(start, end));
          return;
        case "x":
          if (end > start) {
            void getNativeAdapters().clipboard?.writeText(current.slice(start, end));
            this.#replaceInputText(target, "");
          }
          return;
        case "v": {
          const clipboard = getNativeAdapters().clipboard;
          if (clipboard === undefined) return;
          void clipboard.readText().then((text) => {
            this.#replaceInputText(target, text);
          });
          return;
        }
      }
    }
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
      const movingLeft = key === "ArrowLeft";
      const nextPosition =
        key === "Home"
          ? 0
          : key === "End"
            ? current.length
            : movingLeft
              ? previousCodePointIndex(current, event.shift ? end : start)
              : nextCodePointIndex(current, event.shift ? end : end);
      this.#setSelection(
        target,
        event.shift
          ? { start: Math.min(start, nextPosition), end: Math.max(start, nextPosition) }
          : { start: nextPosition, end: nextPosition },
      );
      this.#commitSnapshot();
      return;
    }
    if (key === "Enter" && target.props.multiline !== true) {
      target.props.onSubmitEditing?.(current);
      return;
    }
    let next = current;
    let caret = start;
    if (key === "Backspace") {
      const deleteStart = start === end ? previousCodePointIndex(current, start) : start;
      next = current.slice(0, deleteStart) + current.slice(end);
      caret = deleteStart;
    } else if (key === "Delete") {
      const deleteEnd = start === end ? nextCodePointIndex(current, end) : end;
      next = current.slice(0, start) + current.slice(deleteEnd);
      caret = start;
    } else if (key === "Enter" && target.props.multiline === true) {
      next = `${current.slice(0, start)}\n${current.slice(end)}`;
      caret = start + 1;
    } else if (
      isPrintableInputKey(key) &&
      !event.control &&
      !event.meta &&
      !event.alt &&
      key.charCodeAt(0) >= 32
    ) {
      next = `${current.slice(0, start)}${key}${current.slice(end)}`;
      caret = start + key.length;
    } else return;
    if (target.props.maxLength !== undefined && next.length > target.props.maxLength)
      return;
    target.props = controlled
      ? { ...target.props, value: next, selection: { start: caret, end: caret } }
      : { ...target.props, defaultValue: next, selection: { start: caret, end: caret } };
    this.#selectionById.set(target.id, { start: caret, end: caret });
    target.dirty = true;
    target.props.onTextInput?.(next);
    target.props.onChangeText?.(next);
    target.props.onValueChange?.(next);
    if (!controlled) this.#commitSnapshot();
  }

  #replaceInputText(target: NativeHostNode, inserted: string): void {
    if (target.props.editable === false) return;
    const current = String(target.props.value ?? target.props.defaultValue ?? "");
    const selected = this.#selectionById.get(target.id) ??
      target.props.selection ?? {
        start: current.length,
        end: current.length,
      };
    const start = Math.max(0, Math.min(current.length, selected.start));
    const end = Math.max(start, Math.min(current.length, selected.end));
    const next = `${current.slice(0, start)}${inserted}${current.slice(end)}`;
    if (target.props.maxLength !== undefined && next.length > target.props.maxLength)
      return;
    const caret = start + inserted.length;
    const selection = { start: caret, end: caret };
    target.props =
      typeof target.props.value === "string"
        ? { ...target.props, value: next, selection }
        : { ...target.props, defaultValue: next, selection };
    this.#selectionById.set(target.id, selection);
    target.dirty = true;
    target.props.onTextInput?.(next);
    target.props.onChangeText?.(next);
    target.props.onValueChange?.(next);
    if (typeof target.props.value !== "string") this.#commitSnapshot();
  }

  #placeTextCursor(target: NativeHostNode, localX: number): void {
    const value = String(target.props.value ?? target.props.defaultValue ?? "");
    const fontSize = target.props.style?.fontSize ?? 15;
    const approximateAdvance = Math.max(1, fontSize * 0.62);
    const index = Math.max(
      0,
      Math.min(value.length, Math.round((localX - 10) / approximateAdvance)),
    );
    this.#setSelection(target, { start: index, end: index });
  }

  #setSelection(
    target: NativeHostNode,
    selection: { readonly start: number; readonly end: number },
  ): void {
    const value = String(target.props.value ?? target.props.defaultValue ?? "");
    const start = Math.max(0, Math.min(value.length, selection.start));
    const end = Math.max(start, Math.min(value.length, selection.end));
    const next = { start, end };
    this.#selectionById.set(target.id, next);
    target.props = { ...target.props, selection: next };
    target.dirty = true;
    target.props.onSelectionChange?.(next);
  }
  #moveSelection(target: NativeHostNode, direction: number): void {
    const options = target.props.options ?? [];
    if (options.length === 0) return;
    const controlled = target.props.selectedIndex !== undefined;
    const current = target.props.selectedIndex ?? target.props.defaultSelectedIndex ?? 0;
    const next = (current + direction + options.length) % options.length;
    const value = options[next];
    if (value === undefined) return;
    if (!controlled) {
      target.props = { ...target.props, defaultSelectedIndex: next, value };
      target.dirty = true;
      this.#commitSnapshot();
    }
    target.props.onTextInput?.(value);
    target.props.onValueChange?.(value);
  }

  #activate(target: NativeHostNode): void {
    let current: NativeHostNode | undefined = target;
    while (current !== undefined) {
      if (current.type === "toggle") {
        const controlled = current.props.checked !== undefined;
        const next = !(current.props.checked ?? current.props.defaultChecked ?? false);
        if (!controlled) {
          current.props = { ...current.props, defaultChecked: next };
          current.dirty = true;
          this.#commitSnapshot();
        }
        current.props.onValueChange?.(next);
      }
      if (current.props.onPress !== undefined) {
        current.props.onPress();
        return;
      }
      current = current.parent;
    }
  }

  #adjustSlider(target: NativeHostNode, direction: number): void {
    const minimum = target.props.minimumValue ?? 0;
    const maximum = target.props.maximumValue ?? 100;
    const step = target.props.step ?? 1;
    const controlled = typeof target.props.value === "number";
    const current = Number(target.props.value ?? target.props.defaultValue ?? minimum);
    const next = Math.min(maximum, Math.max(minimum, current + step * direction));
    if (!controlled) {
      target.props = { ...target.props, defaultValue: next };
      target.dirty = true;
      this.#commitSnapshot();
    }
    target.props.onValueChange?.(next);
  }

  #render(tree: ReactNode, invalidate: boolean): void {
    this.#suppressNextCommit = !invalidate;
    this.#root.render(tree);
  }
}

function isPrintableInputKey(key: string): boolean {
  if (key.length === 0 || key === "Dead" || key === "Compose") return false;
  if (
    /^(Arrow|Page|Home|End|F\d+$|Insert|Print|Scroll|Pause|CapsLock|NumLock|ContextMenu)/.test(
      key,
    )
  )
    return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(key)) {
    if ((segment.codePointAt(0) ?? 0) >= 0x20) return true;
  }
  return false;
}

function previousCodePointIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const previous = value.charCodeAt(index - 1);
  return previous >= 0xdc00 && previous <= 0xdfff && index > 1 ? index - 2 : index - 1;
}

function nextCodePointIndex(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const current = value.charCodeAt(index);
  return current >= 0xd800 && current <= 0xdbff && index + 1 < value.length
    ? index + 2
    : index + 1;
}
