import {
  resolveDesktopAppearance,
  type DesktopScene,
} from "@sevynos/desktop-shell/internal";
import {
  caretBlinkPhase,
  drawDesktopCursor,
  renderDesktopBackground,
  renderDesktopScene,
  type FrameDamage,
  type RgbaFrame,
} from "./software-frame-renderer.js";

export interface IncrementalRgbaFrame extends RgbaFrame {
  readonly damage: readonly FrameDamage[];
}

export interface IncrementalFrameRendererOptions {
  readonly includeCursor?: boolean;
}

export class IncrementalFrameRenderer {
  #scene: DesktopScene | undefined;
  #basePixels: Uint8Array | undefined;
  #backgroundPixels: Uint8Array | undefined;
  #backgroundSignature: string | undefined;
  #width = 0;
  #height = 0;
  #includeCursor: boolean;
  #lastBlinkPhase: 0 | 1 | undefined;

  public constructor(options: IncrementalFrameRendererOptions = {}) {
    this.#includeCursor = options.includeCursor ?? true;
  }

  public setIncludeCursor(includeCursor: boolean): void {
    this.#includeCursor = includeCursor;
  }

  public render(
    scene: DesktopScene,
    width: number,
    height: number,
    target: Uint8Array,
  ): IncrementalRgbaFrame {
    const fullDamage = Object.freeze([{ x: 0, y: 0, width, height }]);
    const previousScene = this.#scene;
    const previousBasePixels = this.#basePixels;
    const backgroundSignature = desktopBackgroundSignature(scene);
    if (
      this.#backgroundPixels === undefined ||
      this.#backgroundPixels.byteLength !== target.byteLength ||
      this.#backgroundSignature !== backgroundSignature
    ) {
      this.#backgroundPixels = renderDesktopBackground(scene, width, height).pixels;
      this.#backgroundSignature = backgroundSignature;
    }
    let damage: readonly FrameDamage[] = fullDamage;
    let canReuse = false;
    if (
      previousScene !== undefined &&
      previousBasePixels !== undefined &&
      this.#width === width &&
      this.#height === height
    ) {
      canReuse = true;
      damage = calculateSceneDamage(previousScene, scene, width, height);
      // A caret blink phase flip changes what the rasterizer draws for
      // `blink` commands without changing the scene itself, so repaint
      // their regions explicitly. This keeps the blink visible even when
      // nothing else invalidates the scene.
      const blinkPhase = caretBlinkPhase();
      const blinkDamage =
        this.#lastBlinkPhase !== undefined && blinkPhase !== this.#lastBlinkPhase
          ? collectBlinkDamage(scene)
          : [];
      this.#lastBlinkPhase = blinkPhase;
      if (blinkDamage.length > 0)
        damage = mergeDamage([...damage, ...blinkDamage], width, height);
      if (
        blinkDamage.length === 0 &&
        !this.#includeCursor &&
        isCursorOnlyChange(previousScene, scene)
      ) {
        this.#scene = scene;
        return Object.freeze({
          width,
          height,
          stride: width * 4,
          pixels: target,
          damage: Object.freeze([]),
        });
      }
      target.set(previousBasePixels);
    }

    const cursorOnly =
      canReuse && previousScene !== undefined && isCursorOnlyChange(previousScene, scene);

    if (!cursorOnly) {
      renderDesktopScene(scene, width, height, target, canReuse ? damage : undefined, {
        includeCursor: false,
        backgroundPixels: this.#backgroundPixels,
      });
      if (this.#basePixels?.byteLength === target.byteLength)
        this.#basePixels.set(target);
      else this.#basePixels = new Uint8Array(target);
    }

    const frame = this.#includeCursor
      ? drawDesktopCursor(scene, width, height, target)
      : { width, height, stride: width * 4, pixels: target };
    this.#scene = scene;
    this.#width = width;
    this.#height = height;
    return Object.freeze({ ...frame, damage });
  }

  public reset(): void {
    this.#scene = undefined;
    this.#basePixels = undefined;
    this.#backgroundPixels = undefined;
    this.#backgroundSignature = undefined;
    this.#width = 0;
    this.#height = 0;
    this.#lastBlinkPhase = undefined;
  }
}

/**
 * Desktop-space damage regions for every `blink` material command in the
 * scene (e.g. focused text input carets), translated from window-content
 * local coordinates the same way the rasterizer positions them.
 */
export function collectBlinkDamage(scene: DesktopScene): FrameDamage[] {
  const regions: FrameDamage[] = [];
  for (const node of scene.nodes) {
    if (node.kind !== "desktop-window" || node.nativeSurface === undefined) continue;
    for (const command of node.nativeSurface.commands) {
      if (command.kind !== "material" || command.blink !== true) continue;
      regions.push({
        x: node.contentBounds.x + command.bounds.x,
        y: node.contentBounds.y + command.bounds.y,
        width: command.bounds.width,
        height: command.bounds.height,
      });
    }
  }
  return regions;
}

function desktopBackgroundSignature(scene: DesktopScene): string {
  return JSON.stringify({
    theme: scene.settings.theme,
    backgrounds: scene.nodes.filter((node) => node.kind === "desktop-background"),
  });
}

function isCursorOnlyChange(previous: DesktopScene, current: DesktopScene): boolean {
  if (JSON.stringify(previous.settings) !== JSON.stringify(current.settings))
    return false;
  return nonCursorSceneSignature(previous) === nonCursorSceneSignature(current);
}

function nonCursorSceneSignature(scene: DesktopScene): string {
  return JSON.stringify(
    scene.nodes
      .filter((node) => node.kind !== "desktop-cursor")
      .map((node) => nodeSignature(node)),
  );
}

function calculateSceneDamage(
  previous: DesktopScene,
  current: DesktopScene,
  width: number,
  height: number,
): readonly FrameDamage[] {
  if (JSON.stringify(previous.settings) !== JSON.stringify(current.settings))
    return Object.freeze([{ x: 0, y: 0, width, height }]);
  const previousNodes = indexedNodes(previous);
  const currentNodes = indexedNodes(current);
  const keys = new Set([...previousNodes.keys(), ...currentNodes.keys()]);
  const changed: FrameDamage[] = [];
  for (const key of keys) {
    const before = previousNodes.get(key);
    const after = currentNodes.get(key);
    if (nodeSignature(before) === nodeSignature(after)) continue;
    const beforeBounds = nodePaintBounds(before, previous);
    const afterBounds = nodePaintBounds(after, current);
    if (beforeBounds !== undefined) changed.push(beforeBounds);
    if (afterBounds !== undefined) changed.push(afterBounds);
    if (
      before?.kind === "desktop-taskbar-application" ||
      after?.kind === "desktop-taskbar-application"
    ) {
      for (const scene of [previous, current])
        for (const node of scene.nodes)
          if (node.kind === "desktop-taskbar") changed.push(node.bounds);
    }
  }
  // Desktop workspace controls sit directly on the background plane. Repaint
  // their small chrome region whenever another scene layer changes so a
  // partial frame cannot leave stale anti-aliased edges behind.
  if (changed.length > 0 && !isCursorOnlyChange(previous, current)) {
    for (const scene of [previous, current])
      for (const node of scene.nodes)
        if (
          node.kind === "desktop-workspace-action" ||
          node.kind === "desktop-workspace-item"
        )
          changed.push({
            x: node.bounds.x - 2,
            y: node.bounds.y - 2,
            width: node.bounds.width + 4,
            height: node.bounds.height + 4,
          });
  }
  const merged = mergeDamage(changed, width, height);
  if (merged.length === 0) return Object.freeze([{ x: 0, y: 0, width: 1, height: 1 }]);
  const area = merged.reduce((sum, bounds) => sum + bounds.width * bounds.height, 0);
  if (area > width * height * 0.7) return Object.freeze([{ x: 0, y: 0, width, height }]);
  return Object.freeze(merged.map((bounds) => Object.freeze(bounds)));
}

type SceneNode = DesktopScene["nodes"][number];

function indexedNodes(scene: DesktopScene): Map<string, SceneNode> {
  const counts = new Map<string, number>();
  const indexed = new Map<string, SceneNode>();
  for (const node of scene.nodes) {
    const identity = nodeIdentity(node);
    const count = counts.get(identity) ?? 0;
    counts.set(identity, count + 1);
    indexed.set(`${identity}:${String(count)}`, node);
  }
  return indexed;
}

function nodeIdentity(node: SceneNode): string {
  switch (node.kind) {
    case "desktop-background":
    case "desktop-status-bar":
    case "desktop-taskbar":
      return `${node.kind}:${node.displayId}`;
    case "desktop-window":
      return `${node.kind}:${node.windowId}`;
    case "desktop-launcher-entry":
    case "desktop-taskbar-application":
      return `${node.kind}:${node.applicationId}`;
    case "desktop-workspace-control":
      return `${node.kind}:${node.workspaceId}`;
    case "desktop-settings-control":
    case "desktop-diagnostics-control":
    case "desktop-recovery-control":
      return `${node.kind}:${node.action}`;
    default:
      return node.kind;
  }
}

function nodeSignature(node: SceneNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.kind !== "desktop-window") return JSON.stringify(node);
  return JSON.stringify({
    order: node.order,
    base: node.base,
    title: node.title,
    contentBounds: node.contentBounds,
    surface: node.surface,
    maximized: node.maximized,
    systemMonitorSnapshot: node.systemMonitorSnapshot,
    settingsSnapshot: node.settingsSnapshot,
    nativeSurfaceRevision: node.nativeSurface?.revision,
  });
}

function nodePaintBounds(
  node: SceneNode | undefined,
  scene: DesktopScene,
): FrameDamage | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "desktop-background" || node.kind === "desktop-recovery")
    return node.bounds;
  if (node.kind === "desktop-window") {
    const appearance = resolveDesktopAppearance(scene.settings.theme);
    const shadow = node.base.focused
      ? appearance.window.focusedShadow
      : appearance.window.unfocusedShadow;
    const extent = Math.ceil(shadow.blur * 0.62);
    const left = Math.min(node.base.bounds.x, node.base.bounds.x - extent);
    const top = Math.min(
      node.base.bounds.y,
      node.base.bounds.y + shadow.offsetY - extent,
    );
    const right = Math.max(
      node.base.bounds.x + node.base.bounds.width,
      node.base.bounds.x + node.base.bounds.width + extent,
    );
    const bottom = Math.max(
      node.base.bounds.y + node.base.bounds.height,
      node.base.bounds.y + shadow.offsetY + node.base.bounds.height + extent,
    );
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }
  if (node.kind === "desktop-cursor") {
    const extent = Math.ceil(20 * Math.max(0.75, scene.settings.cursorSize)) + 2;
    return {
      x: node.position.x - 1,
      y: node.position.y - 1,
      width: extent,
      height: extent,
    };
  }
  return "bounds" in node
    ? {
        x: node.bounds.x - 16,
        y: node.bounds.y - 16,
        width: node.bounds.width + 32,
        height: node.bounds.height + 32,
      }
    : undefined;
}

function mergeDamage(
  candidates: readonly FrameDamage[],
  width: number,
  height: number,
): FrameDamage[] {
  const regions = candidates
    .map((bounds) => clampDamage(bounds, width, height))
    .filter((bounds): bounds is FrameDamage => bounds !== undefined);
  for (let index = 0; index < regions.length; index += 1) {
    let current = regions[index];
    if (current === undefined) continue;
    for (let otherIndex = regions.length - 1; otherIndex > index; otherIndex -= 1) {
      const other = regions[otherIndex];
      if (other === undefined || !touches(current, other)) continue;
      current = union(current, other);
      regions[index] = current;
      regions.splice(otherIndex, 1);
    }
  }
  return regions;
}

function clampDamage(
  bounds: FrameDamage,
  width: number,
  height: number,
): FrameDamage | undefined {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(width, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(height, Math.ceil(bounds.y + bounds.height));
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

function touches(first: FrameDamage, second: FrameDamage): boolean {
  return (
    first.x <= second.x + second.width &&
    second.x <= first.x + first.width &&
    first.y <= second.y + second.height &&
    second.y <= first.y + first.height
  );
}

function union(first: FrameDamage, second: FrameDamage): FrameDamage {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return { x, y, width: right - x, height: bottom - y };
}
