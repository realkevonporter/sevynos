import { existsSync, readFileSync } from "node:fs";
import {
  DESKTOP_VISUAL_METRICS,
  resolveDesktopAppearance,
  type DesktopAppearance,
  type DesktopScene,
  type DesktopShadowAppearance,
  type DesktopWindowSceneNode,
} from "@sevynos/desktop-shell/internal";
import {
  getCharacterAdvance as getNativeCharacterAdvance,
  type NativeCornerRadii,
  type NativeGradient,
  type NativeIconCommand,
  type NativeRenderCommand,
  type NativeShadow,
} from "@sevynos/react-native/internal";

export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly pixels: Uint8Array;
}

type Rgba = readonly [number, number, number, number];
interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type FrameDamage = Bounds;
/**
 * Caret blink timing shared by the rasterizer, the damage tracker, and the
 * compositor wake-up timer. `blink` material commands (e.g. the text input
 * caret) are visible during phase 0 and hidden during phase 1 of each
 * period, anchored to the Unix epoch so every layer agrees on the phase
 * without extra signaling.
 */
export const CARET_BLINK_PERIOD_MS = 530;
export function caretBlinkPhase(nowMs: number = Date.now()): 0 | 1 {
  return Math.floor(nowMs / CARET_BLINK_PERIOD_MS) % 2 === 0 ? 0 : 1;
}
type DesktopCursorSceneNode = Extract<
  DesktopScene["nodes"][number],
  { readonly kind: "desktop-cursor" }
>;
type DesktopStatusBarSceneNode = Extract<
  DesktopScene["nodes"][number],
  { readonly kind: "desktop-status-bar" }
>;
interface Clip {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const COLOR_CACHE = new Map<string, Rgba>();
const TRANSPARENT: Rgba = Object.freeze([0, 0, 0, 0]);
const SHADOW_MASK_CACHE = new Map<string, ShadowMask>();
const GLYPH_MASK_CACHE = new Map<string, GlyphMask>();
const MAXIMUM_SHADOW_MASKS = 32;

interface ShadowMask {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8Array;
}

interface GlyphMask {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8Array;
}

interface FontAtlasGlyph {
  readonly advance: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly alpha: string;
}

interface FontAtlasSize {
  readonly ascent: number;
  readonly descent: number;
  readonly glyphs: Readonly<Record<string, FontAtlasGlyph>>;
}

interface FontAtlas {
  readonly family: string;
  readonly sizes: Readonly<Record<string, FontAtlasSize>>;
}

interface DecodedAtlasGlyph extends Omit<FontAtlasGlyph, "alpha"> {
  readonly ascent: number;
  readonly alpha: Uint8Array;
}

const FONT_ATLAS = loadFontAtlas();
const ATLAS_GLYPH_CACHE = new Map<string, DecodedAtlasGlyph>();

/**
 * Deterministic CPU rasterizer for the Linux wl_shm host.
 *
 * The desktop scene and native application snapshots remain the source of truth;
 * this module only turns their render commands into RGBA pixels for Wayland.
 */
export function renderDesktopScene(
  scene: DesktopScene,
  width: number,
  height: number,
  target?: Uint8Array,
  damage?: readonly FrameDamage[],
  options: {
    readonly includeCursor?: boolean;
    readonly backgroundPixels?: Uint8Array;
  } = {},
): RgbaFrame {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  const raster = new SoftwareRaster(pixelWidth, pixelHeight, target);
  const hasBackgroundPlane = options.backgroundPixels !== undefined;
  if (
    options.backgroundPixels !== undefined &&
    options.backgroundPixels.byteLength !== raster.pixels.byteLength
  )
    throw new Error("Background plane dimensions do not match the render target.");
  if (damage === undefined) {
    if (options.backgroundPixels === undefined) raster.clear(parseColor("#090b11"));
    else raster.pixels.set(options.backgroundPixels);
    drawDesktopScene(raster, scene, options.includeCursor ?? true, !hasBackgroundPlane);
  } else {
    for (const region of damage) {
      raster.resetClip();
      raster.pushClip(region);
      if (options.backgroundPixels === undefined)
        raster.fillRect(
          { x: 0, y: 0, width: pixelWidth, height: pixelHeight },
          parseColor("#090b11"),
        );
      else raster.copyRegionFrom(options.backgroundPixels, region);
      drawDesktopScene(raster, scene, options.includeCursor ?? true, !hasBackgroundPlane);
    }
    raster.resetClip();
  }

  return Object.freeze({
    width: pixelWidth,
    height: pixelHeight,
    stride: pixelWidth * 4,
    pixels: raster.pixels,
  });
}

export function renderDesktopBackground(
  scene: DesktopScene,
  width: number,
  height: number,
): RgbaFrame {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  const raster = new SoftwareRaster(pixelWidth, pixelHeight);
  const appearance = resolveDesktopAppearance(scene.settings.theme);
  raster.clear(parseColor(appearance.background.end));
  for (const node of scene.nodes)
    if (node.kind === "desktop-background")
      drawBackground(raster, node.bounds, appearance);
  return Object.freeze({
    width: pixelWidth,
    height: pixelHeight,
    stride: pixelWidth * 4,
    pixels: raster.pixels,
  });
}

/** Draws only the current desktop cursor over an existing RGBA framebuffer. */
export function drawDesktopCursor(
  scene: DesktopScene,
  width: number,
  height: number,
  target: Uint8Array,
): RgbaFrame {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  const raster = new SoftwareRaster(pixelWidth, pixelHeight, target);
  const cursor = [...scene.nodes]
    .sort((left, right) => left.order - right.order)
    .find((node): node is DesktopCursorSceneNode => node.kind === "desktop-cursor");
  if (cursor !== undefined)
    drawCursor(
      raster,
      cursor,
      scene.settings.cursorSize,
      resolveDesktopAppearance(scene.settings.theme),
    );
  return Object.freeze({
    width: pixelWidth,
    height: pixelHeight,
    stride: pixelWidth * 4,
    pixels: raster.pixels,
  });
}

function drawDesktopScene(
  raster: SoftwareRaster,
  scene: DesktopScene,
  includeCursor: boolean,
  includeBackground: boolean,
): void {
  const appearance = resolveDesktopAppearance(scene.settings.theme);
  for (const node of [...scene.nodes].sort((left, right) => left.order - right.order)) {
    switch (node.kind) {
      case "desktop-background":
        if (includeBackground) drawBackground(raster, node.bounds, appearance);
        break;
      case "desktop-status-bar":
        drawStatusBar(raster, node, appearance);
        break;
      case "desktop-window":
        drawWindow(raster, node, appearance);
        break;
      case "desktop-taskbar":
        drawTaskbar(raster, node.bounds, node.activeWorkspace, appearance);
        break;
      case "desktop-launcher-button":
        drawLauncherButton(
          raster,
          node.bounds,
          node.open,
          scene.settings.accentColor,
          appearance,
        );
        break;
      case "desktop-launcher-surface":
        raster.backdropBlur(node.bounds, 0, undefined, 20);
        raster.fillRect(
          node.bounds,
          parseColor(
            appearance.mode === "light"
              ? "rgba(240, 243, 248, 0.72)"
              : "rgba(7, 9, 13, 0.75)",
          ),
        );
        break;
      case "desktop-launcher-header":
        raster.drawText(
          node.title,
          node.bounds.x,
          node.bounds.y + (node.bounds.height - 18) / 2,
          3,
          parseColor(appearance.content.primary),
          "start",
        );
        break;
      case "desktop-launcher-search":
        raster.roundedRect(
          node.bounds,
          12,
          parseColor(
            appearance.mode === "light"
              ? "rgba(255, 255, 255, 0.85)"
              : "rgba(24, 29, 38, 0.84)",
          ),
          parseColor(appearance.launcher.border),
        );
        raster.drawText(
          node.query.length > 0 ? node.query : node.placeholder,
          node.bounds.x + 16,
          node.bounds.y + (node.bounds.height - 14) / 2,
          2,
          parseColor(
            node.query.length > 0
              ? appearance.content.primary
              : appearance.content.secondary,
          ),
          "start",
        );
        break;
      case "desktop-launcher-entry":
        drawLauncherEntry(
          raster,
          node.bounds,
          node.label,
          node.iconLabel,
          node.running,
          scene.settings.accentColor,
          appearance,
        );
        break;
      case "desktop-taskbar-application":
        drawButton(
          raster,
          node.bounds,
          `${node.minimized ? "◇ " : ""}${node.label}`,
          node.focused,
          scene.settings.accentColor,
          appearance,
          true,
          node.running ?? true,
        );
        break;
      case "desktop-reset-action":
        drawButton(
          raster,
          node.bounds,
          node.label,
          false,
          scene.settings.accentColor,
          appearance,
        );
        break;
      case "desktop-workspace-control":
        drawButton(
          raster,
          node.bounds,
          node.workspaceId.slice(-1),
          node.active,
          scene.settings.accentColor,
          appearance,
        );
        break;
      case "desktop-workspace-action":
        drawButton(
          raster,
          node.bounds,
          node.label,
          false,
          scene.settings.accentColor,
          appearance,
        );
        break;
      case "desktop-workspace-item":
        drawDesktopWorkspaceItem(raster, node, scene.settings.accentColor, appearance);
        break;
      case "desktop-diagnostics-control":
      case "desktop-recovery-control":
        drawButton(
          raster,
          node.bounds,
          node.label,
          false,
          scene.settings.accentColor,
          appearance,
        );
        break;
      case "desktop-settings-control":
        // Native surface controls already paint these bounds. This node is hit-test metadata.
        break;
      case "desktop-recovery":
        raster.fillRect(node.bounds, parseColor(appearance.recovery.surface));
        raster.drawText(
          "Genesis Recovery",
          node.bounds.x + node.bounds.width / 2,
          node.bounds.y + node.bounds.height / 2 - 34,
          3,
          parseColor(appearance.recovery.primary),
          "center",
        );
        raster.drawText(
          node.message,
          node.bounds.x + node.bounds.width / 2,
          node.bounds.y + node.bounds.height / 2 + 8,
          2,
          parseColor(appearance.recovery.secondary),
          "center",
        );
        break;
      case "desktop-cursor":
        if (includeCursor)
          drawCursor(raster, node, scene.settings.cursorSize, appearance);
    }
  }
}

function drawBackground(
  raster: SoftwareRaster,
  bounds: Bounds,
  appearance: DesktopAppearance,
): void {
  raster.desktopBackground(bounds, appearance.background);
  const isDark = appearance.mode === "dark";

  // Coordinate matrix grid lines
  const matrixColor = parseColor(
    isDark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.04)",
  );
  for (const ratio of [0.33, 0.67]) {
    const lineY = Math.round(bounds.y + bounds.height * ratio);
    const lineX = Math.round(bounds.x + bounds.width * ratio);
    raster.drawLine(bounds.x, lineY, bounds.x + bounds.width, lineY, matrixColor, 1);
    raster.drawLine(lineX, bounds.y, lineX, bounds.y + bounds.height, matrixColor, 1);
  }

  // Precision grid dots
  const grid = parseColor(appearance.background.grid);
  const spacing = DESKTOP_VISUAL_METRICS.backgroundGridSpacing;
  for (let x = bounds.x + spacing; x < bounds.x + bounds.width; x += spacing) {
    for (let y = bounds.y + spacing; y < bounds.y + bounds.height; y += spacing) {
      raster.fillRect({ x: x - 1, y: y - 1, width: 2, height: 2 }, grid);
    }
  }

  // Central Sevyn Luxury Emblem Lattice
  const cx = Math.round(bounds.x + bounds.width / 2);
  const cy = Math.round(bounds.y + bounds.height / 2);
  const crosshairColor = parseColor(
    isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.07)",
  );
  raster.drawLine(cx - 160, cy, cx + 160, cy, crosshairColor, 1);
  raster.drawLine(cx, cy - 160, cx, cy + 160, crosshairColor, 1);

  // Diamond outer (rotated 45-degree diamond lattice)
  const outerColor = parseColor(
    isDark ? "rgba(230, 196, 122, 0.28)" : "rgba(180, 145, 75, 0.26)",
  );
  raster.drawLine(cx, cy - 75, cx + 75, cy, outerColor, 1);
  raster.drawLine(cx + 75, cy, cx, cy + 75, outerColor, 1);
  raster.drawLine(cx, cy + 75, cx - 75, cy, outerColor, 1);
  raster.drawLine(cx - 75, cy, cx, cy - 75, outerColor, 1);

  // Diamond inner
  const innerColor = parseColor(
    isDark ? "rgba(159, 168, 255, 0.32)" : "rgba(100, 110, 200, 0.28)",
  );
  raster.drawLine(cx, cy - 50, cx + 50, cy, innerColor, 1);
  raster.drawLine(cx + 50, cy, cx, cy + 50, innerColor, 1);
  raster.drawLine(cx, cy + 50, cx - 50, cy, innerColor, 1);
  raster.drawLine(cx - 50, cy, cx, cy - 50, innerColor, 1);

  // Core diamond
  const coreColor = parseColor(
    isDark ? "rgba(230, 196, 122, 0.55)" : "rgba(180, 145, 75, 0.55)",
  );
  raster.drawLine(cx, cy - 20, cx + 20, cy, coreColor, 1);
  raster.drawLine(cx + 20, cy, cx, cy + 20, coreColor, 1);
  raster.drawLine(cx, cy + 20, cx - 20, cy, coreColor, 1);
  raster.drawLine(cx - 20, cy, cx, cy - 20, coreColor, 1);
}

function drawWindow(
  raster: SoftwareRaster,
  node: DesktopWindowSceneNode,
  appearance: DesktopAppearance,
): void {
  const bounds = node.base.bounds;
  const windowAppearance = appearance.window;
  const shadow = node.base.focused
    ? windowAppearance.focusedShadow
    : windowAppearance.unfocusedShadow;
  drawSoftShadow(raster, bounds, DESKTOP_VISUAL_METRICS.windowRadius, shadow);
  raster.roundedRect(
    bounds,
    DESKTOP_VISUAL_METRICS.windowRadius,
    parseColor(windowAppearance.surface),
    parseColor(
      node.base.focused
        ? windowAppearance.focusedBorder
        : windowAppearance.unfocusedBorder,
    ),
  );
  raster.roundedRect(
    {
      x: bounds.x + 1,
      y: bounds.y + 1,
      width: bounds.width - 2,
      height: DESKTOP_VISUAL_METRICS.titleBarHeight,
    },
    DESKTOP_VISUAL_METRICS.windowRadius - 1,
    parseColor(
      node.base.focused
        ? windowAppearance.focusedTitleBar
        : windowAppearance.unfocusedTitleBar,
    ),
  );
  raster.fillRect(
    {
      x: bounds.x + 1,
      y: bounds.y + DESKTOP_VISUAL_METRICS.titleBarHeight - 15,
      width: bounds.width - 2,
      height: 15,
    },
    parseColor(
      node.base.focused
        ? windowAppearance.focusedTitleBar
        : windowAppearance.unfocusedTitleBar,
    ),
  );
  // macOS: title is centered, no badge
  raster.drawText(
    node.title,
    bounds.x + bounds.width / 2,
    bounds.y + 14,
    1.4,
    parseColor(
      node.base.focused ? windowAppearance.focusedTitle : windowAppearance.unfocusedTitle,
    ),
    "center",
    Math.max(0, bounds.width - 140), // leave room for traffic lights
  );
  raster.fillRect(
    {
      x: bounds.x + 1,
      y: bounds.y + DESKTOP_VISUAL_METRICS.titleBarHeight - 1,
      width: bounds.width - 2,
      height: 1,
    },
    parseColor(windowAppearance.divider),
  );

  raster.pushClip(node.contentBounds);
  if (node.nativeSurface !== undefined)
    drawNativeSurface(
      raster,
      node.nativeSurface.commands,
      node.contentBounds.x,
      node.contentBounds.y,
    );
  else drawFallbackSurface(raster, node, appearance);
  raster.popClip();

  for (const control of node.controls) {
    const available = control.kind !== "restore" || node.maximized;
    drawWindowControl(raster, control, control.kind, available);
  }
}

function wrapText(
  raster: SoftwareRaster,
  text: string,
  scale: number,
  maxWidth: number,
): readonly string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let currentLine = "";
    for (const word of words) {
      const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;
      if (raster.measureText(candidate, scale) <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine.length > 0) lines.push(currentLine);
        currentLine = word;
      }
    }
    lines.push(currentLine);
  }
  return lines;
}

function drawFallbackSurface(
  raster: SoftwareRaster,
  node: DesktopWindowSceneNode,
  appearance: DesktopAppearance,
): void {
  const surface = node.surface;
  if (surface === undefined) return;
  const x = node.base.bounds.x + 24;
  const y = node.base.bounds.y + 68;
  const foreground = parseColor(appearance.content.primary);
  const secondary = parseColor(appearance.content.secondary);
  switch (surface.kind) {
    case "welcome": {
      raster.drawText(surface.heading, x, y, 2.6, foreground);
      let currentY = y + 36;
      const maxTextWidth = Math.max(100, node.contentBounds.width - 48);
      for (const paragraph of surface.body) {
        const wrapped = wrapText(raster, paragraph, 1.8, maxTextWidth);
        for (const line of wrapped) {
          raster.drawText(line, x, currentY, 1.8, secondary);
          currentY += 22;
        }
        currentY += 6;
      }
      const statusItems = surface.runtimeStatus
        .split("·")
        .map((s) => s.trim())
        .filter(Boolean);
      currentY += 10;
      let chipX = x;
      const successColor = parseColor(appearance.content.success);
      const chipBg = withAlpha(successColor, appearance.mode === "dark" ? 0.12 : 0.08);
      const chipBorder = withAlpha(successColor, 0.28);
      for (const item of statusItems) {
        const textWidth = raster.measureText(item, 1.5);
        const chipWidth = textWidth + 28;
        const chipBounds = { x: chipX, y: currentY, width: chipWidth, height: 26 };
        if (chipX + chipWidth <= node.contentBounds.x + node.contentBounds.width - 24) {
          raster.roundedRect(chipBounds, 13, chipBg, chipBorder);
          raster.fillCircle(chipX + 11, currentY + 13, 3, successColor);
          raster.drawText(item, chipX + 20, currentY + 7, 1.5, successColor);
          chipX += chipWidth + 8;
        }
      }
      break;
    }
    case "console": {
      const terminalBounds = {
        x: node.contentBounds.x + 12,
        y: node.contentBounds.y + 12,
        width: node.contentBounds.width - 24,
        height: node.contentBounds.height - 24,
      };
      const terminalBg = parseColor("#0D1117");
      const terminalBorder = parseColor("rgba(255, 255, 255, 0.10)");
      raster.roundedRect(terminalBounds, 10, terminalBg, terminalBorder);
      const headerHeight = 26;
      raster.roundedRect(
        {
          x: terminalBounds.x,
          y: terminalBounds.y,
          width: terminalBounds.width,
          height: headerHeight,
        },
        10,
        parseColor("#161B22"),
        terminalBorder,
      );
      raster.fillRect(
        {
          x: terminalBounds.x + 1,
          y: terminalBounds.y + headerHeight - 6,
          width: terminalBounds.width - 2,
          height: 6,
        },
        parseColor("#161B22"),
      );
      raster.fillCircle(
        terminalBounds.x + 14,
        terminalBounds.y + 13,
        3.5,
        parseColor("#FF5F56"),
      );
      raster.fillCircle(
        terminalBounds.x + 25,
        terminalBounds.y + 13,
        3.5,
        parseColor("#FFBD2E"),
      );
      raster.fillCircle(
        terminalBounds.x + 36,
        terminalBounds.y + 13,
        3.5,
        parseColor("#27C93F"),
      );
      raster.drawText(
        "genesis-terminal",
        terminalBounds.x + terminalBounds.width / 2,
        terminalBounds.y + 7,
        1.4,
        parseColor("rgba(255, 255, 255, 0.45)"),
        "center",
      );
      const contentX = terminalBounds.x + 16;
      let lineY = terminalBounds.y + 38;
      const consoleColor = parseColor("#7EE787");
      surface.history.slice(-8).forEach((line) => {
        raster.drawText(line, contentX, lineY, 1.6, consoleColor);
        lineY += 20;
      });
      const promptColor = parseColor("#79C0FF");
      raster.drawText(surface.prompt, contentX, lineY, 1.6, promptColor);
      const promptWidth = raster.measureText(surface.prompt, 1.6);
      raster.drawText(
        surface.input,
        contentX + promptWidth,
        lineY,
        1.6,
        parseColor("#FFFFFF"),
      );
      const inputWidth = raster.measureText(surface.input, 1.6);
      raster.drawText(
        "▌",
        contentX + promptWidth + inputWidth,
        lineY,
        1.6,
        parseColor("#E6C47A"),
      );
      break;
    }
    default:
      raster.drawText(surface.heading, x, y, 2.6, foreground);
  }
}

function drawNativeSurface(
  raster: SoftwareRaster,
  commands: readonly NativeRenderCommand[],
  originX: number,
  originY: number,
): void {
  const initialClipDepth = raster.clipDepth;
  for (const command of commands) {
    const bounds = {
      x: command.bounds.x + originX,
      y: command.bounds.y + originY,
      width: command.bounds.width,
      height: command.bounds.height,
    };
    switch (command.kind) {
      case "clip-start":
        raster.pushClip(bounds);
        break;
      case "clip-end":
        raster.popClip();
        break;
      case "material": {
        // Skip rendering during the blink-off phase of the caret blink cycle.
        if (command.blink === true && caretBlinkPhase() !== 0) break;
        const opacity = command.opacity ?? 1;
        if (command.backdropBlur !== undefined && command.backdropBlur > 0) {
          raster.backdropBlur(
            bounds,
            command.radius,
            command.radii,
            command.backdropBlur,
          );
        }
        if (command.shadow !== undefined)
          drawSoftShadow(
            raster,
            bounds,
            command.radius,
            command.shadow,
            command.radii,
            opacity,
          );
        const borderColor =
          command.borderColor === undefined ? undefined : parseColor(command.borderColor);
        if (command.gradient !== undefined) {
          raster.drawGradient(
            bounds,
            command.radius,
            command.radii,
            command.gradient,
            opacity,
            borderColor,
            command.borderWidth ?? 1,
            command.borderStyle ?? "solid",
          );
        } else {
          raster.roundedRect(
            bounds,
            command.radius,
            parseColor(command.color),
            borderColor,
            command.radii,
            command.borderWidth ?? 1,
            command.borderStyle ?? "solid",
            opacity,
          );
        }
        if (command.blur !== undefined && command.blur > 0) {
          raster.blurRegion(bounds, command.blur);
        }
        break;
      }
      case "gradient": {
        const opacity = command.opacity ?? 1;
        const borderColor =
          command.borderColor === undefined ? undefined : parseColor(command.borderColor);
        raster.drawGradient(
          bounds,
          command.radius,
          command.radii,
          command.gradient,
          opacity,
          borderColor,
          command.borderWidth ?? 1,
          command.borderStyle ?? "solid",
        );
        break;
      }
      case "bitmap":
        raster.drawBitmap(
          command.pixels,
          command.width,
          command.height,
          bounds,
          command.opacity ?? 1,
        );
        break;
      case "text": {
        const scale = Math.max(1, command.size / 7);
        const opacity = command.opacity ?? 1;
        const textColor = withAlpha(parseColor(command.color), opacity);
        const x =
          command.align === "center"
            ? bounds.x + bounds.width / 2
            : command.align === "end"
              ? bounds.x + bounds.width
              : bounds.x;
        const lines =
          command.lines && command.lines.length > 0
            ? command.lines
            : bounds.height >= 14 * scale &&
                (raster.measureText(command.text, scale) > bounds.width ||
                  command.text.includes("\n"))
              ? wrapText(raster, command.text, scale, bounds.width)
              : [command.text];

        if (lines.length > 1) {
          const lineHeight = command.lineHeight ?? Math.round(command.size * 1.4);
          let lineY = bounds.y + 2;
          for (const line of lines) {
            if (lineY + lineHeight > bounds.y + bounds.height + 4) break;
            raster.drawText(
              line,
              x,
              lineY,
              scale,
              textColor,
              command.align ?? "start",
              bounds.width,
            );
            lineY += lineHeight;
          }
        } else {
          const lineText = lines[0] ?? command.text;
          const textWidth = command.measuredWidth ?? raster.measureText(lineText, scale);
          raster.drawText(
            lineText,
            x,
            bounds.y + (bounds.height - 7 * scale) / 2,
            scale,
            textColor,
            command.align ?? "start",
            command.align === undefined
              ? bounds.width
              : Math.max(bounds.width, textWidth),
          );
        }
        break;
      }
      case "separator":
        raster.fillRect(
          { ...bounds, height: Math.max(1, bounds.height) },
          withAlpha(parseColor(command.color), command.opacity ?? 1),
        );
        break;
      case "control": {
        const disabled = command.state === "disabled";
        const active = command.state === "focused" || command.state === "pressed";
        const hovered = command.state === "hovered";
        const opacity = command.opacity ?? 1;
        if (command.shadow !== undefined)
          drawSoftShadow(
            raster,
            bounds,
            command.radius,
            command.shadow,
            command.radii,
            opacity,
          );
        const background = withAlpha(
          parseColor(active ? command.accent : command.background),
          (disabled ? 0.42 : 1) * opacity,
        );
        const borderColor =
          command.borderWidth && command.borderColor
            ? parseColor(command.borderColor)
            : command.state === "focused"
              ? parseColor(command.accent)
              : undefined;
        raster.roundedRect(
          bounds,
          command.radius,
          background,
          borderColor,
          command.radii,
          command.borderWidth ?? 1,
          command.borderStyle ?? "solid",
          opacity,
        );
        if (hovered && !active && !disabled) {
          raster.roundedRect(
            bounds,
            command.radius,
            parseColor("rgba(255, 255, 255, 0.08)"),
            undefined,
            command.radii,
            1,
            "solid",
            opacity,
          );
        }
        if (command.value) {
          raster.drawText(
            command.value,
            bounds.x + bounds.width / 2,
            bounds.y + (bounds.height - 14) / 2,
            2,
            withAlpha(
              parseColor(active ? "#19140a" : command.foreground),
              (disabled ? 0.42 : 1) * opacity,
            ),
            "center",
            Math.max(0, bounds.width - 12),
          );
        }
        break;
      }
      case "icon":
        drawNativeIcon(raster, { ...command, bounds }, command.opacity ?? 1);
        break;
    }
  }
  raster.restoreClipDepth(initialClipDepth);
}

function drawNativeIcon(
  raster: SoftwareRaster,
  command: NativeIconCommand,
  opacity = 1,
): void {
  const { x, y, width, height } = command.bounds;
  const color = withAlpha(parseColor(command.color), opacity);
  const cx = x + width / 2;
  const cy = y + height / 2;
  switch (command.icon) {
    case "appearance":
      raster.fillCircle(cx, cy, Math.min(width, height) * 0.34, color);
      raster.fillRect(
        { x: cx, y: cy - height * 0.36, width: width / 2, height: height * 0.72 },
        parseColor("#20232b"),
      );
      break;
    case "color":
      raster.fillPolygon(
        [
          [cx, y + 2],
          [x + width - 2, cy],
          [cx, y + height - 2],
          [x + 2, cy],
        ],
        color,
      );
      break;
    case "display":
      raster.strokeRect(
        { x: x + 1, y: y + 2, width: width - 2, height: height - 6 },
        color,
        2,
      );
      raster.drawLine(cx - 4, y + height - 1, cx + 4, y + height - 1, color, 2);
      break;
    case "workspace":
      raster.strokeRect(
        { x: x + 2, y: y + 2, width: width * 0.38, height: height * 0.38 },
        color,
      );
      raster.strokeRect(
        { x: cx, y: cy, width: width * 0.38, height: height * 0.38 },
        color,
      );
      break;
    case "pointer":
      raster.fillPolygon(
        [
          [x + 3, y + 2],
          [cx + 2, y + height - 3],
          [cx + 4, cy + 3],
          [x + width - 2, cy + 1],
        ],
        color,
      );
      break;
    case "motion":
      raster.drawLine(x + 1, cy - 4, cx, cy, color, 2);
      raster.drawLine(cx, cy, x + width - 1, cy + 4, color, 2);
      break;
    case "history":
      raster.strokeCircle(cx, cy, Math.min(width, height) * 0.36, color);
      raster.drawLine(cx, cy, cx, cy - 5, color);
      raster.drawLine(cx, cy, cx + 4, cy, color);
      break;
    case "controls":
      for (const offset of [5, height / 2, height - 5])
        raster.drawLine(x + 2, y + offset, x + width - 2, y + offset, color, 2);
      break;
    case "gallery":
      raster.strokeCircle(cx, cy, Math.min(width, height) * 0.3, color, 2);
      raster.fillCircle(cx, cy, Math.min(width, height) * 0.12, color);
      break;
    case "search":
      raster.strokeCircle(cx - 2, cy - 2, Math.min(width, height) * 0.27, color, 2);
      raster.drawLine(cx + 2, cy + 2, x + width - 2, y + height - 2, color, 2);
      break;
    default:
      drawVectorIcon(raster, command.icon, command.bounds, color);
      break;
  }
}

function drawVectorIcon(
  raster: SoftwareRaster,
  icon: string,
  bounds: Bounds,
  color: Rgba,
): void {
  const { x, y, width, height } = bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const lower = icon.toLowerCase();

  if (
    lower.includes("compass") ||
    lower.includes("browser") ||
    lower.includes("web") ||
    lower.includes("globe")
  ) {
    const r = Math.min(width, height) * 0.44;
    raster.strokeCircle(cx, cy, r, color, 1.8);
    // North needle (solid fill)
    raster.fillPolygon(
      [
        [cx, cy - r + 2.5],
        [cx + 3.2, cy],
        [cx - 3.2, cy],
      ],
      color,
    );
    // South needle (semi-transparent)
    raster.fillPolygon(
      [
        [cx, cy + r - 2.5],
        [cx + 3.2, cy],
        [cx - 3.2, cy],
      ],
      withAlpha(color, 0.45),
    );
    raster.fillCircle(cx, cy, 2, color);
    return;
  }

  if (lower.includes("folder") || lower.includes("file")) {
    const fw = width * 0.8;
    const fh = height * 0.62;
    const fx = Math.round(cx - fw / 2);
    const fy = Math.round(cy - fh / 2 + 2);
    // Tab on top left
    raster.roundedRect({ x: fx, y: fy - 4, width: fw * 0.45, height: 6 }, 2, color);
    // Folder body
    raster.roundedRect({ x: fx, y: fy, width: fw, height: fh }, 3, color);
    // Subtle flap shadow line
    raster.drawLine(
      fx + 2,
      fy + 4,
      fx + fw - 2,
      fy + 4,
      withAlpha(parseColor("#000000"), 0.25),
      1.5,
    );
    return;
  }

  if (lower.includes("code") || lower.includes("studio") || lower.includes("dev")) {
    const s = Math.min(width, height) * 0.38;
    // Left bracket <
    raster.drawLine(cx - 3, cy - s, cx - s - 1, cy, color, 2);
    raster.drawLine(cx - s - 1, cy, cx - 3, cy + s, color, 2);
    // Right bracket >
    raster.drawLine(cx + 3, cy - s, cx + s + 1, cy, color, 2);
    raster.drawLine(cx + s + 1, cy, cx + 3, cy + s, color, 2);
    // Slash /
    raster.drawLine(cx + 2, cy - s - 1, cx - 2, cy + s + 1, withAlpha(color, 0.75), 1.8);
    return;
  }

  if (lower.includes("terminal") || lower.includes("console")) {
    const tw = width * 0.8;
    const th = height * 0.62;
    const tx = Math.round(cx - tw / 2);
    const ty = Math.round(cy - th / 2);
    raster.strokeRect({ x: tx, y: ty, width: tw, height: th }, color, 1.8);
    raster.drawLine(tx, ty + 5, tx + tw, ty + 5, withAlpha(color, 0.5), 1);
    raster.drawLine(tx + 4, ty + 8, tx + 7, ty + 11, color, 1.8);
    raster.drawLine(tx + 7, ty + 11, tx + 4, ty + 14, color, 1.8);
    raster.fillRect({ x: tx + 9, y: ty + 13, width: 5, height: 2 }, color);
    return;
  }

  if (lower.includes("document") || lower.includes("note")) {
    const dw = width * 0.62;
    const dh = height * 0.78;
    const dx = Math.round(cx - dw / 2);
    const dy = Math.round(cy - dh / 2);
    raster.roundedRect({ x: dx, y: dy, width: dw, height: dh }, 2, color);
    // Corner fold
    raster.fillPolygon(
      [
        [dx + dw - 5, dy],
        [dx + dw, dy + 5],
        [dx + dw - 5, dy + 5],
      ],
      withAlpha(parseColor("#000000"), 0.35),
    );
    // Rule lines
    for (let i = 0; i < 3; i++) {
      raster.drawLine(
        dx + 4,
        dy + 9 + i * 5,
        dx + dw - 4,
        dy + 9 + i * 5,
        withAlpha(parseColor("#000000"), 0.35),
        1.5,
      );
    }
    return;
  }

  if (
    lower.includes("pulse") ||
    lower.includes("monitor") ||
    lower.includes("activity")
  ) {
    const pw = width * 0.8;
    const px = Math.round(cx - pw / 2);
    raster.drawLine(px, cy, px + pw * 0.25, cy, color, 2);
    raster.drawLine(px + pw * 0.25, cy, px + pw * 0.35, cy + 5, color, 2);
    raster.drawLine(px + pw * 0.35, cy + 5, px + pw * 0.5, cy - 8, color, 2);
    raster.drawLine(px + pw * 0.5, cy - 8, px + pw * 0.65, cy + 6, color, 2);
    raster.drawLine(px + pw * 0.65, cy + 6, px + pw * 0.75, cy, color, 2);
    raster.drawLine(px + pw * 0.75, cy, px + pw, cy, color, 2);
    return;
  }

  if (lower.includes("gear") || lower.includes("setting")) {
    const outerR = Math.min(width, height) * 0.4;
    const innerR = outerR * 0.55;
    const holeR = outerR * 0.25;
    for (let a = 0; a < 8; a++) {
      const angle = (a * Math.PI) / 4;
      const tx = cx + Math.cos(angle) * (outerR + 2);
      const ty = cy + Math.sin(angle) * (outerR + 2);
      raster.fillCircle(tx, ty, 2.2, color);
    }
    raster.strokeCircle(cx, cy, innerR, color, 3);
    raster.fillCircle(cx, cy, holeR, parseColor("#20232b"));
    return;
  }

  if (lower.includes("palette") || lower.includes("gallery") || lower.includes("photo")) {
    const pr = Math.min(width, height) * 0.4;
    raster.strokeCircle(cx, cy, pr, color, 2);
    raster.fillCircle(cx + pr * 0.45, cy + pr * 0.28, pr * 0.22, parseColor("#20232b"));
    raster.fillCircle(cx - pr * 0.4, cy - pr * 0.28, 2.2, color);
    raster.fillCircle(cx, cy - pr * 0.52, 2.2, color);
    raster.fillCircle(cx + pr * 0.4, cy - pr * 0.28, 2.2, color);
    return;
  }

  if (lower.includes("edit") || lower.includes("pen") || lower.includes("text")) {
    const l = Math.min(width, height) * 0.36;
    raster.drawLine(cx - l + 3, cy + l - 3, cx + l, cy - l, color, 2.8);
    raster.fillPolygon(
      [
        [cx - l, cy + l],
        [cx - l + 4, cy + l - 1],
        [cx - l + 1, cy + l - 4],
      ],
      color,
    );
    return;
  }

  if (lower.includes("apps") || lower.includes("grid") || lower.includes("manage")) {
    const gw = width * 0.65;
    const s = Math.round(gw * 0.42);
    const gap = Math.round(gw * 0.16);
    const gx = Math.round(cx - (s * 2 + gap) / 2);
    const gy = Math.round(cy - (s * 2 + gap) / 2);
    raster.roundedRect({ x: gx, y: gy, width: s, height: s }, 2, color);
    raster.roundedRect({ x: gx + s + gap, y: gy, width: s, height: s }, 2, color);
    raster.roundedRect({ x: gx, y: gy + s + gap, width: s, height: s }, 2, color);
    raster.roundedRect(
      { x: gx + s + gap, y: gy + s + gap, width: s, height: s },
      2,
      color,
    );
    return;
  }

  if (lower.includes("sparkles") || lower.includes("welcome")) {
    const sr = Math.min(width, height) * 0.42;
    raster.fillPolygon(
      [
        [cx, cy - sr],
        [cx + sr * 0.26, cy - sr * 0.26],
        [cx + sr, cy],
        [cx + sr * 0.26, cy + sr * 0.26],
        [cx, cy + sr],
        [cx - sr * 0.26, cy + sr * 0.26],
        [cx - sr, cy],
        [cx - sr * 0.26, cy - sr * 0.26],
      ],
      color,
    );
    raster.fillCircle(cx + sr * 0.72, cy - sr * 0.65, 1.8, color);
    raster.fillCircle(cx - sr * 0.68, cy + sr * 0.65, 1.5, color);
    return;
  }

  if (lower.includes("calc")) {
    const cw = width * 0.64;
    const ch = height * 0.78;
    const rx = Math.round(cx - cw / 2);
    const ry = Math.round(cy - ch / 2);
    raster.roundedRect({ x: rx, y: ry, width: cw, height: ch }, 3, color);
    raster.fillRect(
      { x: rx + 3, y: ry + 3, width: cw - 6, height: Math.round(ch * 0.24) },
      parseColor("#20232b"),
    );
    const bw = Math.round((cw - 8) / 2);
    const bh = Math.round((ch * 0.48) / 2);
    raster.fillRect(
      { x: rx + 3, y: ry + Math.round(ch * 0.38), width: bw, height: bh },
      withAlpha(parseColor("#000000"), 0.3),
    );
    raster.fillRect(
      { x: rx + 5 + bw, y: ry + Math.round(ch * 0.38), width: bw, height: bh },
      withAlpha(parseColor("#000000"), 0.3),
    );
    raster.fillRect(
      { x: rx + 3, y: ry + Math.round(ch * 0.68), width: bw, height: bh },
      withAlpha(parseColor("#000000"), 0.3),
    );
    raster.fillRect(
      { x: rx + 5 + bw, y: ry + Math.round(ch * 0.68), width: bw, height: bh },
      withAlpha(parseColor("#000000"), 0.3),
    );
    return;
  }

  // Fallback: rounded square badge
  raster.roundedRect({ x: cx - 7, y: cy - 7, width: 14, height: 14 }, 3, color);
}

function resolveAppIconVisuals(label: string): {
  readonly gradientStart: string;
  readonly gradientEnd: string;
  readonly symbol: string;
  readonly icon: string;
} {
  const lower = label.toLocaleLowerCase();
  if (lower.includes("welcome")) {
    return {
      gradientStart: "#F59E0B",
      gradientEnd: "#B45309",
      symbol: "W",
      icon: "sparkles",
    };
  }
  if (lower.includes("browser") || lower.includes("web")) {
    return {
      gradientStart: "#0EA5E9",
      gradientEnd: "#0369A1",
      symbol: "WB",
      icon: "compass",
    };
  }
  if (lower.includes("studio") || lower.includes("ide")) {
    return {
      gradientStart: "#6366F1",
      gradientEnd: "#4338CA",
      symbol: "</>",
      icon: "code",
    };
  }
  if (lower.includes("console") || lower.includes("terminal")) {
    return {
      gradientStart: "#334155",
      gradientEnd: "#0F172A",
      symbol: ">_",
      icon: "terminal",
    };
  }
  if (lower.includes("file")) {
    return {
      gradientStart: "#06B6D4",
      gradientEnd: "#0E7490",
      symbol: "FL",
      icon: "folder",
    };
  }
  if (lower.includes("setting")) {
    return {
      gradientStart: "#64748B",
      gradientEnd: "#334155",
      symbol: "⚙",
      icon: "gear",
    };
  }
  if (lower.includes("monitor")) {
    return {
      gradientStart: "#10B981",
      gradientEnd: "#047857",
      symbol: "SM",
      icon: "pulse",
    };
  }
  if (lower.includes("note")) {
    return {
      gradientStart: "#FBBF24",
      gradientEnd: "#D97706",
      symbol: "NT",
      icon: "document",
    };
  }
  if (lower.includes("text") || lower.includes("editor")) {
    return {
      gradientStart: "#F97316",
      gradientEnd: "#C2410C",
      symbol: "TE",
      icon: "edit",
    };
  }
  if (lower.includes("app") && (lower.includes("manage") || lower.includes("store"))) {
    return {
      gradientStart: "#A855F7",
      gradientEnd: "#7E22CE",
      symbol: "AM",
      icon: "apps",
    };
  }
  if (
    lower.includes("gallery") ||
    lower.includes("photo") ||
    lower.includes("component")
  ) {
    return {
      gradientStart: "#F43F5E",
      gradientEnd: "#BE123C",
      symbol: "UI",
      icon: "palette",
    };
  }
  if (lower.includes("calc")) {
    return {
      gradientStart: "#6366F1",
      gradientEnd: "#4338CA",
      symbol: "CA",
      icon: "calculator",
    };
  }
  return {
    gradientStart: "#6366F1",
    gradientEnd: "#4338CA",
    symbol: label.charAt(0) || "•",
    icon: "apps",
  };
}

function drawTaskbar(
  raster: SoftwareRaster,
  bounds: Bounds,
  _workspace: string,
  appearance: DesktopAppearance,
): void {
  const isDark = appearance.mode === "dark";
  // Bounds are now the floating dock directly (macOS-style), not full-width.
  const dockRadius = 18; // macOS-like rounded corners
  const dockBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  drawSoftShadow(raster, dockBounds, dockRadius, appearance.taskbar.shadow);
  // Frosted glass surface
  raster.roundedRect(
    dockBounds,
    dockRadius,
    parseColor(isDark ? "rgba(24, 28, 38, 0.82)" : "rgba(245, 247, 252, 0.86)"),
    parseColor(isDark ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.70)"),
  );
  // Specular top highlight line
  raster.drawLine(
    dockBounds.x + dockRadius,
    dockBounds.y + 1,
    dockBounds.x + dockBounds.width - dockRadius,
    dockBounds.y + 1,
    parseColor(isDark ? "rgba(255, 255, 255, 0.28)" : "rgba(255, 255, 255, 0.90)"),
    1,
  );
  // Subtle inner border for frosted glass rim
  raster.roundedRect(
    { x: dockX + 1, y: dockY + 1, width: dockWidth - 2, height: dockHeight - 2 },
    dockRadius - 1,
    TRANSPARENT,
    parseColor(isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.50)"),
  );
  // Subtle divider between launcher and apps
  const dividerX = dockX + 64;
  raster.drawLine(
    dividerX,
    dockY + 10,
    dividerX,
    dockY + dockHeight - 10,
    parseColor(isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.12)"),
    1,
  );
  // Subtle divider between apps and workspace switchers
  const wsDividerX = dockX + dockWidth - 120;
  raster.drawLine(
    wsDividerX,
    dockY + 10,
    wsDividerX,
    dockY + dockHeight - 10,
    parseColor(isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.12)"),
    1,
  );
}

function drawStatusBar(
  raster: SoftwareRaster,
  node: DesktopStatusBarSceneNode,
  appearance: DesktopAppearance,
): void {
  const bounds = node.bounds;
  const isDark = appearance.mode === "dark";
  // macOS-style translucent menu bar
  raster.fillRect(
    bounds,
    parseColor(isDark ? "rgba(20, 22, 30, 0.72)" : "rgba(250, 250, 252, 0.72)"),
  );
  // Subtle bottom border
  raster.drawLine(
    bounds.x,
    bounds.y + bounds.height - 1,
    bounds.x + bounds.width,
    bounds.y + bounds.height - 1,
    parseColor(isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)"),
    1,
  );

  const centerY = bounds.y + Math.round(bounds.height / 2);
  const textColor = parseColor(isDark ? "#FFFFFF" : "#1A1C23");
  const dimColor = parseColor(isDark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.75)");

  // Left: Sevyn logo + app name + menus (macOS-style)
  let leftX = bounds.x + 12;
  // Sevyn emblem (replaces Apple logo)
  const emblemSize = 14;
  const emblemY = centerY - Math.round(emblemSize / 2);
  raster.roundedGradientRect(
    { x: leftX, y: emblemY, width: emblemSize, height: emblemSize },
    4,
    parseColor("#E6C47A"),
    parseColor("#B8943D"),
  );
  raster.drawText(
    "S",
    leftX + emblemSize / 2,
    emblemY + 1,
    1.0,
    parseColor("#1C1917"),
    "center",
  );
  leftX += emblemSize + 8;

  // Active app name (bold)
  raster.drawText("SevynOS", leftX, centerY - 5, 1.3, textColor, "start");
  leftX += 62;

  // Menu items
  const menus = ["File", "Edit", "View", "Window", "Help"];
  for (const menu of menus) {
    raster.drawText(menu, leftX, centerY - 5, 1.2, textColor, "start");
    leftX += menu.length * 7 + 16;
  }

  // Right: status icons + clock (macOS-style, right-aligned)
  let rightX = bounds.x + bounds.width - 12;

  // Clock: macOS format "Mon Sep 28  6:09 PM"
  const now = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const clockText = `${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()}  ${hours}:${minutes} ${ampm}`;
  const clockWidth = clockText.length * 6.5;
  rightX -= clockWidth;
  raster.drawText(clockText, rightX, centerY - 5, 1.2, textColor, "start");
  rightX -= 16;

  // Battery
  if (node.batteryAvailable !== false) {
    const pct = Math.min(100, Math.max(0, node.batteryPercent ?? 100));
    const batW = 22;
    const batH = 11;
    rightX -= batW + 4;
    const batX = rightX;
    const batY = centerY - Math.round(batH / 2);
    // Battery outline
    raster.roundedRect(
      { x: batX, y: batY, width: batW, height: batH },
      3,
      parseColor("rgba(0,0,0,0)"),
      dimColor,
    );
    // Battery fill
    const fillW = Math.round((batW - 4) * (pct / 100));
    if (fillW > 0) {
      raster.fillRect(
        { x: batX + 2, y: batY + 2, width: fillW, height: batH - 4 },
        pct <= 20 ? parseColor("#FF3B30") : textColor,
      );
    }
    // Battery cap
    raster.fillRect(
      { x: batX + batW + 1, y: batY + 3, width: 2, height: batH - 6 },
      dimColor,
    );
    rightX -= 12;
  }

  // WiFi icon (signal bars)
  const wifiState = node.wifiState ?? "unavailable";
  const wifiColor = wifiState === "connected" ? textColor : dimColor;
  rightX -= 16;
  const wifiX = rightX;
  const wifiY = centerY;
  // Signal bars (4 bars, increasing height)
  const signalLevel = wifiState === "connected" ? 4 : wifiState === "connecting" ? 2 : 1;
  for (let i = 0; i < 4; i++) {
    const barH = 3 + i * 2;
    const barX = wifiX + i * 4;
    const alpha = i < signalLevel ? 1 : 0.25;
    raster.fillRect(
      { x: barX, y: wifiY + 4 - barH, width: 2.5, height: barH },
      parseColor(isDark ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`),
    );
  }
  void wifiColor;
  rightX -= 12;

  // Volume icon
  if (node.audioMuted !== undefined || node.audioVolume !== undefined) {
    rightX -= 16;
    const volX = rightX;
    const volY = centerY;
    // Speaker shape (simplified)
    raster.fillRect({ x: volX + 2, y: volY - 3, width: 4, height: 6 }, dimColor);
    raster.drawText(
      node.audioMuted ? "✕" : "♪",
      volX + 8,
      volY - 6,
      1.2,
      dimColor,
      "start",
    );
    rightX -= 8;
  }
}

function drawButton(
  raster: SoftwareRaster,
  bounds: Bounds,
  label: string,
  active: boolean,
  accent: string,
  appearance: DesktopAppearance,
  isTaskbarApp = false,
  running = true,
): void {
  if (isTaskbarApp) {
    const cleanLabel = label.replace(/^[◇\s]+/, "");
    const visuals = resolveAppIconVisuals(cleanLabel);
    const centerX = bounds.x + bounds.width / 2;
    const baseCenterY = bounds.y + bounds.height / 2 - 2;
    // Active window elevates upward slightly (Apple dock lift)
    const centerY = active ? baseCenterY - 3 : baseCenterY;
    const iconSize = 34;
    const iconX = Math.round(centerX - iconSize / 2);
    const iconY = Math.round(centerY - iconSize / 2);
    const iconRadius = 9;

    // Ambient glow behind elevated active squircle
    if (active) {
      raster.roundedRect(
        { x: iconX - 2, y: iconY - 2, width: iconSize + 4, height: iconSize + 4 },
        iconRadius + 2,
        TRANSPARENT,
        withAlpha(parseColor(accent), 0.75),
      );
    }

    // Squircle gradient background
    raster.roundedGradientRect(
      { x: iconX, y: iconY, width: iconSize, height: iconSize },
      iconRadius,
      parseColor(visuals.gradientStart),
      parseColor(visuals.gradientEnd),
    );
    // Specular highlight line
    raster.drawLine(
      iconX + 3,
      iconY + 1,
      iconX + iconSize - 3,
      iconY + 1,
      parseColor("rgba(255, 255, 255, 0.45)"),
      1,
    );
    // Centered vector icon
    drawVectorIcon(
      raster,
      visuals.icon,
      { x: iconX + 6, y: iconY + 6, width: iconSize - 12, height: iconSize - 12 },
      parseColor("#FFFFFF"),
    );

    // Active / Running indicator underneath
    if (active) {
      raster.roundedRect(
        {
          x: Math.round(centerX - 6),
          y: bounds.y + bounds.height - 4,
          width: 12,
          height: 3,
        },
        1.5,
        parseColor(accent),
        withAlpha(parseColor(accent), 0.9),
      );
    } else if (running) {
      raster.fillCircle(
        centerX,
        bounds.y + bounds.height - 3,
        2,
        parseColor("rgba(255, 255, 255, 0.65)"),
      );
    }
    return;
  }

  // Non-taskbar button (e.g. workspace controls, reset action)
  const isDark = appearance.mode === "dark";
  const buttonBg = active
    ? parseColor(accent)
    : parseColor(isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)");
  const buttonBorder = active
    ? parseColor(appearance.button.activeBorder)
    : parseColor(isDark ? "rgba(255, 255, 255, 0.16)" : "rgba(0, 0, 0, 0.12)");
  raster.roundedRect(
    bounds,
    bounds.height <= 30
      ? Math.round(bounds.height / 2)
      : DESKTOP_VISUAL_METRICS.buttonRadius,
    buttonBg,
    buttonBorder,
  );

  raster.drawText(
    label,
    bounds.x + bounds.width / 2,
    bounds.y + (bounds.height - 12) / 2,
    1.6,
    parseColor(
      active
        ? appearance.mode === "dark"
          ? "#1C1917"
          : "#FFFFFF"
        : appearance.button.text,
    ),
    "center",
    Math.max(0, bounds.width - 8),
  );
}

function drawDesktopWorkspaceItem(
  raster: SoftwareRaster,
  node: Extract<
    DesktopScene["nodes"][number],
    { readonly kind: "desktop-workspace-item" }
  >,
  accent: string,
  appearance: DesktopAppearance,
): void {
  const centerX = node.bounds.x + node.bounds.width / 2;
  const iconY = node.bounds.y + 10;
  const iconWidth = 42;
  const iconHeight = 34;
  const iconX = Math.round(centerX - iconWidth / 2);
  const iconColor = node.itemKind === "directory" ? "#E6C47A" : accent;
  raster.roundedRect(
    { x: iconX, y: iconY, width: iconWidth, height: iconHeight },
    8,
    withAlpha(parseColor(iconColor), 0.9),
    parseColor("rgba(255, 255, 255, 0.35)"),
  );
  raster.drawText(
    node.itemKind === "directory" ? "DIR" : "TXT",
    centerX,
    iconY + iconHeight / 2 - 1,
    1.05,
    parseColor("#17120A"),
    "center",
  );
  raster.drawText(
    node.label,
    centerX,
    node.bounds.y + 58,
    1.25,
    parseColor(appearance.content.primary),
    "center",
    node.bounds.width - 8,
  );
}

function drawLauncherButton(
  raster: SoftwareRaster,
  bounds: Bounds,
  active: boolean,
  accent: string,
  appearance: DesktopAppearance,
): void {
  const isDark = appearance.mode === "dark";
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2 - 2;
  const iconSize = 34;
  const iconX = Math.round(centerX - iconSize / 2);
  const iconY = Math.round(centerY - iconSize / 2);
  const iconRadius = 9;

  raster.roundedGradientRect(
    { x: iconX, y: iconY, width: iconSize, height: iconSize },
    iconRadius,
    parseColor(active ? accent : isDark ? "#2C2C2E" : "#E5E5EA"),
    parseColor(active ? appearance.launcher.iconEnd : isDark ? "#1C1C1E" : "#D1D1D6"),
  );
  raster.drawLine(
    iconX + 3,
    iconY + 1,
    iconX + iconSize - 3,
    iconY + 1,
    parseColor("rgba(255, 255, 255, 0.40)"),
    1,
  );

  // 4 colorful mini app tiles (Apple App Library icon)
  const tileSize = 8;
  const gap = 3;
  const startX = centerX - tileSize - Math.round(gap / 2);
  const startY = centerY - tileSize - Math.round(gap / 2);

  raster.roundedRect(
    { x: startX, y: startY, width: tileSize, height: tileSize },
    2.5,
    parseColor("#0A84FF"),
  );
  raster.roundedRect(
    { x: startX + tileSize + gap, y: startY, width: tileSize, height: tileSize },
    2.5,
    parseColor("#34C759"),
  );
  raster.roundedRect(
    { x: startX, y: startY + tileSize + gap, width: tileSize, height: tileSize },
    2.5,
    parseColor("#FF9500"),
  );
  raster.roundedRect(
    {
      x: startX + tileSize + gap,
      y: startY + tileSize + gap,
      width: tileSize,
      height: tileSize,
    },
    2.5,
    parseColor("#AF52DE"),
  );

  if (active) {
    raster.roundedRect(
      { x: iconX - 1, y: iconY - 1, width: iconSize + 2, height: iconSize + 2 },
      iconRadius + 1,
      TRANSPARENT,
      withAlpha(parseColor(accent), 0.75),
    );
  }
}

function drawLauncherEntry(
  raster: SoftwareRaster,
  bounds: Bounds,
  label: string,
  iconLabel: string | undefined,
  running: boolean,
  accent: string,
  appearance: DesktopAppearance,
): void {
  drawSoftShadow(
    raster,
    bounds,
    DESKTOP_VISUAL_METRICS.launcherRadius,
    appearance.launcher.shadow,
  );
  raster.roundedRect(
    bounds,
    DESKTOP_VISUAL_METRICS.launcherRadius,
    parseColor(appearance.launcher.surface),
    parseColor(appearance.launcher.border),
  );

  const cleanLabel = label.replace(/^[◇\s]+/, "");
  const visuals = resolveAppIconVisuals(cleanLabel);

  if (bounds.height > 80) {
    const iconSize = 48;
    const iconX = bounds.x + Math.round((bounds.width - iconSize) / 2);
    const iconY = bounds.y + 16;
    const iconRadius = 12;

    // Dedicated high-res gradient squircle
    raster.roundedGradientRect(
      { x: iconX, y: iconY, width: iconSize, height: iconSize },
      iconRadius,
      parseColor(visuals.gradientStart),
      parseColor(visuals.gradientEnd),
    );
    // Specular highlight line
    raster.drawLine(
      iconX + 3,
      iconY + 1,
      iconX + iconSize - 3,
      iconY + 1,
      parseColor("rgba(255, 255, 255, 0.45)"),
      1,
    );
    // Centered vector icon
    drawVectorIcon(
      raster,
      visuals.icon,
      { x: iconX + 10, y: iconY + 10, width: iconSize - 20, height: iconSize - 20 },
      parseColor("#FFFFFF"),
    );

    raster.drawText(
      label,
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height - 26,
      1.7,
      parseColor(appearance.launcher.text),
      "center",
      bounds.width - 8,
    );
    if (running) {
      raster.fillCircle(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height - 8,
        2.5,
        parseColor(accent),
      );
    }
  } else {
    raster.roundedGradientRect(
      { x: bounds.x + 10, y: bounds.y + 8, width: 28, height: 28 },
      8,
      parseColor(visuals.gradientStart),
      parseColor(visuals.gradientEnd),
    );
    raster.drawLine(
      bounds.x + 12,
      bounds.y + 9,
      bounds.x + 36,
      bounds.y + 9,
      parseColor("rgba(255, 255, 255, 0.40)"),
      1,
    );
    drawVectorIcon(
      raster,
      visuals.icon,
      { x: bounds.x + 14, y: bounds.y + 12, width: 20, height: 20 },
      parseColor("#FFFFFF"),
    );
    raster.drawText(
      label,
      bounds.x + 50,
      bounds.y + (bounds.height - 14) / 2,
      1.8,
      parseColor(appearance.launcher.text),
      "start",
      Math.max(0, bounds.width - 78),
    );
    if (running)
      raster.fillCircle(
        bounds.x + bounds.width - 18,
        bounds.y + bounds.height / 2,
        2.5,
        parseColor(accent),
      );
  }
}

function drawSoftShadow(
  raster: SoftwareRaster,
  bounds: Bounds,
  radius: number,
  shadow: DesktopShadowAppearance | NativeShadow,
  radii?: NativeCornerRadii,
  opacity = 1,
): void {
  raster.softShadow(bounds, radius, shadow, radii, opacity);
}

function drawCursor(
  raster: SoftwareRaster,
  node: DesktopCursorSceneNode,
  cursorScale: number,
  appearance: DesktopAppearance,
): void {
  if (!node.visible || node.cursorKind === "hidden") return;
  const scale = Math.max(0.75, cursorScale);
  const { x, y } = node.position;
  const outlineColor = parseColor(appearance.cursor.outline);
  const fillColor = parseColor(appearance.cursor.fill);

  if (node.cursorKind === "pointer") {
    const handPoints = [
      [x + 4 * scale, y],
      [x + 8 * scale, y],
      [x + 8 * scale, y + 8 * scale],
      [x + 11 * scale, y + 8 * scale],
      [x + 14 * scale, y + 10 * scale],
      [x + 15 * scale, y + 14 * scale],
      [x + 14 * scale, y + 20 * scale],
      [x + 4 * scale, y + 20 * scale],
      [x, y + 14 * scale],
      [x, y + 10 * scale],
      [x + 4 * scale, y + 8 * scale],
    ] as const;
    raster.fillPolygon(handPoints, outlineColor);
    const handInset = [
      [x + 5 * scale, y + 1.2 * scale],
      [x + 7 * scale, y + 1.2 * scale],
      [x + 7 * scale, y + 9 * scale],
      [x + 10 * scale, y + 9 * scale],
      [x + 13 * scale, y + 11 * scale],
      [x + 13.8 * scale, y + 14 * scale],
      [x + 13 * scale, y + 19 * scale],
      [x + 5 * scale, y + 19 * scale],
      [x + 1.2 * scale, y + 14 * scale],
      [x + 1.2 * scale, y + 11 * scale],
      [x + 5 * scale, y + 9 * scale],
    ] as const;
    raster.fillPolygon(handInset, fillColor);
    return;
  }

  if (node.cursorKind === "text") {
    const beamHeight = 18 * scale;
    const beamWidth = 8 * scale;
    const top = y - beamHeight / 2;
    raster.fillRect(
      { x: x - beamWidth / 2, y: top, width: beamWidth, height: 2 * scale },
      outlineColor,
    );
    raster.fillRect(
      {
        x: x - beamWidth / 2,
        y: top + beamHeight - 2 * scale,
        width: beamWidth,
        height: 2 * scale,
      },
      outlineColor,
    );
    raster.fillRect(
      { x: x - 1 * scale, y: top, width: 2 * scale, height: beamHeight },
      outlineColor,
    );
    return;
  }

  if (node.cursorKind === "resize-ew") {
    const cy = y;
    raster.drawLine(x - 8 * scale, cy, x + 8 * scale, cy, outlineColor, 2 * scale);
    raster.fillPolygon(
      [
        [x - 8 * scale, cy],
        [x - 3 * scale, cy - 4 * scale],
        [x - 3 * scale, cy + 4 * scale],
      ],
      outlineColor,
    );
    raster.fillPolygon(
      [
        [x + 8 * scale, cy],
        [x + 3 * scale, cy - 4 * scale],
        [x + 3 * scale, cy + 4 * scale],
      ],
      outlineColor,
    );
    return;
  }

  if (node.cursorKind === "resize-ns") {
    const cx = x;
    raster.drawLine(cx, y - 8 * scale, cx, y + 8 * scale, outlineColor, 2 * scale);
    raster.fillPolygon(
      [
        [cx, y - 8 * scale],
        [cx - 4 * scale, y - 3 * scale],
        [cx + 4 * scale, y - 3 * scale],
      ],
      outlineColor,
    );
    raster.fillPolygon(
      [
        [cx, y + 8 * scale],
        [cx - 4 * scale, y + 3 * scale],
        [cx + 4 * scale, y + 3 * scale],
      ],
      outlineColor,
    );
    return;
  }

  // Standard modern arrow cursor
  const points = [
    [x, y - 0.5],
    [x, y + 17 * scale],
    [x + 4.5 * scale, y + 12.5 * scale],
    [x + 7.5 * scale, y + 17 * scale],
    [x + 9.5 * scale, y + 15.5 * scale],
    [x + 6.8 * scale, y + 11.2 * scale],
    [x + 15.5 * scale, y + 12.8 * scale],
  ] as const;
  raster.fillPolygon(points, outlineColor);
  const inset = [
    [x + 1.2 * scale, y + 2 * scale],
    [x + 1.2 * scale, y + 14.8 * scale],
    [x + 4.4 * scale, y + 11.8 * scale],
    [x + 6.8 * scale, y + 15.5 * scale],
    [x + 8.2 * scale, y + 14.5 * scale],
    [x + 6.2 * scale, y + 10.8 * scale],
    [x + 13.5 * scale, y + 12 * scale],
  ] as const;
  raster.fillPolygon(inset, fillColor);
}

function drawWindowControl(
  raster: SoftwareRaster,
  bounds: Bounds,
  kind: "close" | "minimize" | "maximize" | "restore",
  available = true,
): void {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const radius = 6.5;

  if (kind === "close") {
    raster.fillCircle(
      centerX,
      centerY,
      radius,
      parseColor(available ? "#FF5F56" : "#4A4A4A"),
    );
    raster.strokeCircle(
      centerX,
      centerY,
      radius,
      parseColor(available ? "#E0443E" : "#3A3A3A"),
      1,
    );
    if (available) {
      raster.drawLine(
        centerX - 2.5,
        centerY - 2.5,
        centerX + 2.5,
        centerY + 2.5,
        parseColor("#4D0000"),
        1.2,
      );
      raster.drawLine(
        centerX + 2.5,
        centerY - 2.5,
        centerX - 2.5,
        centerY + 2.5,
        parseColor("#4D0000"),
        1.2,
      );
    }
  } else if (kind === "minimize") {
    raster.fillCircle(
      centerX,
      centerY,
      radius,
      parseColor(available ? "#FFBD2E" : "#4A4A4A"),
    );
    raster.strokeCircle(
      centerX,
      centerY,
      radius,
      parseColor(available ? "#DEA123" : "#3A3A3A"),
      1,
    );
    if (available) {
      raster.drawLine(
        centerX - 2.5,
        centerY,
        centerX + 2.5,
        centerY,
        parseColor("#5E3E00"),
        1.2,
      );
    }
  } else {
    raster.fillCircle(
      centerX,
      centerY,
      radius,
      parseColor(available ? "#27C93F" : "#4A4A4A"),
    );
    raster.strokeCircle(
      centerX,
      centerY,
      radius,
      parseColor(available ? "#1AAB29" : "#3A3A3A"),
      1,
    );
    if (available) {
      raster.drawLine(
        centerX - 2.5,
        centerY - 2.5,
        centerX + 2.5,
        centerY + 2.5,
        parseColor("#004D11"),
        1.2,
      );
      raster.drawLine(
        centerX - 2.5,
        centerY - 2.5,
        centerX + 1.5,
        centerY - 2.5,
        parseColor("#004D11"),
        1.2,
      );
      raster.drawLine(
        centerX - 2.5,
        centerY - 2.5,
        centerX - 2.5,
        centerY + 1.5,
        parseColor("#004D11"),
        1.2,
      );
      raster.drawLine(
        centerX + 2.5,
        centerY + 2.5,
        centerX - 1.5,
        centerY + 2.5,
        parseColor("#004D11"),
        1.2,
      );
      raster.drawLine(
        centerX + 2.5,
        centerY + 2.5,
        centerX + 2.5,
        centerY - 1.5,
        parseColor("#004D11"),
        1.2,
      );
    }
  }
}

class SoftwareRaster {
  public readonly pixels: Uint8Array;
  readonly #words: Uint32Array;
  readonly #clips: Clip[] = [];

  public constructor(
    public readonly width: number,
    public readonly height: number,
    pixels?: Uint8Array,
  ) {
    if (pixels !== undefined && pixels.byteLength !== width * height * 4)
      throw new Error("Reusable framebuffer dimensions do not match the render target.");
    this.pixels = pixels ?? new Uint8Array(width * height * 4);
    this.#words = new Uint32Array(
      this.pixels.buffer,
      this.pixels.byteOffset,
      this.pixels.byteLength / 4,
    );
    this.resetClip();
  }

  public clear(color: Rgba): void {
    this.#clips.splice(0, this.#clips.length, {
      left: 0,
      top: 0,
      right: this.width,
      bottom: this.height,
    });
    this.fillRect({ x: 0, y: 0, width: this.width, height: this.height }, color);
  }

  public resetClip(): void {
    this.#clips.splice(0, this.#clips.length, {
      left: 0,
      top: 0,
      right: this.width,
      bottom: this.height,
    });
  }

  public pushClip(bounds: Bounds): void {
    const current = this.#clip;
    this.#clips.push({
      left: Math.max(current.left, Math.floor(bounds.x)),
      top: Math.max(current.top, Math.floor(bounds.y)),
      right: Math.min(current.right, Math.ceil(bounds.x + bounds.width)),
      bottom: Math.min(current.bottom, Math.ceil(bounds.y + bounds.height)),
    });
  }

  public popClip(): void {
    if (this.#clips.length > 1) this.#clips.pop();
  }

  public get clipDepth(): number {
    return this.#clips.length;
  }

  public restoreClipDepth(depth: number): void {
    while (this.#clips.length > Math.max(1, depth)) this.#clips.pop();
  }

  public setPixel(x: number, y: number, color: Rgba): void {
    const column = Math.round(x);
    const row = Math.round(y);
    const clip = this.#clip;
    if (
      column < clip.left ||
      column >= clip.right ||
      row < clip.top ||
      row >= clip.bottom
    )
      return;
    const offset = (row * this.width + column) * 4;
    const alpha = color[3] / 255;
    if (alpha >= 1) {
      this.pixels[offset] = color[0];
      this.pixels[offset + 1] = color[1];
      this.pixels[offset + 2] = color[2];
      this.pixels[offset + 3] = 255;
      return;
    }
    this.pixels[offset] = Math.round(
      color[0] * alpha + (this.pixels[offset] ?? 0) * (1 - alpha),
    );
    this.pixels[offset + 1] = Math.round(
      color[1] * alpha + (this.pixels[offset + 1] ?? 0) * (1 - alpha),
    );
    this.pixels[offset + 2] = Math.round(
      color[2] * alpha + (this.pixels[offset + 2] ?? 0) * (1 - alpha),
    );
    this.pixels[offset + 3] = 255;
  }

  public fillRect(bounds: Bounds, color: Rgba): void {
    const clip = this.#clip;
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const alpha = color[3] / 255;
    if (alpha >= 1) {
      const packed = packRgba(color);
      for (let row = top; row < bottom; row += 1)
        this.#words.fill(packed, row * this.width + left, row * this.width + right);
      return;
    }
    for (let row = top; row < bottom; row += 1) {
      let offset = (row * this.width + left) * 4;
      for (let column = left; column < right; column += 1) {
        this.#blendOffset(offset, color, alpha);
        offset += 4;
      }
    }
  }

  public copyRegionFrom(source: Uint8Array, bounds: Bounds): void {
    if (source.byteLength !== this.pixels.byteLength)
      throw new Error("Source framebuffer dimensions do not match the render target.");
    const clip = this.#clip;
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const rowBytes = Math.max(0, right - left) * 4;
    for (let row = top; row < bottom; row += 1) {
      const offset = (row * this.width + left) * 4;
      this.pixels.set(source.subarray(offset, offset + rowBytes), offset);
    }
  }

  public desktopBackground(
    bounds: Bounds,
    appearance: DesktopAppearance["background"],
  ): void {
    const clip = this.#clip;
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const first = parseColor(appearance.start);
    const middle = parseColor(appearance.middle);
    const last = parseColor(appearance.end);
    const glowFirst = parseColor(appearance.glowStart);
    const glowMiddle = parseColor(appearance.glowMiddle);
    const glowCenterX = bounds.x + bounds.width * DESKTOP_VISUAL_METRICS.backgroundGlowX;
    const glowCenterY = bounds.y + bounds.height * DESKTOP_VISUAL_METRICS.backgroundGlowY;
    const glowRadius = Math.max(
      1,
      bounds.width * DESKTOP_VISUAL_METRICS.backgroundGlowRadius,
    );
    const gradientDenominator = Math.max(
      1,
      bounds.width * bounds.width + bounds.height * bounds.height,
    );
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const progress = clampUnit(
          ((column - bounds.x) * bounds.width + (row - bounds.y) * bounds.height) /
            gradientDenominator,
        );
        const baseFirst = progress < 0.48 ? first : middle;
        const baseLast = progress < 0.48 ? middle : last;
        const baseAmount = progress < 0.48 ? progress / 0.48 : (progress - 0.48) / 0.52;
        const baseRed = mixChannel(baseFirst[0], baseLast[0], baseAmount);
        const baseGreen = mixChannel(baseFirst[1], baseLast[1], baseAmount);
        const baseBlue = mixChannel(baseFirst[2], baseLast[2], baseAmount);
        const glowProgress =
          Math.hypot(column - glowCenterX, row - glowCenterY) / glowRadius;
        if (glowProgress >= 1) {
          this.#words[row * this.width + column] = packChannels(
            baseRed,
            baseGreen,
            baseBlue,
          );
          continue;
        }
        const glowStart = glowProgress < 0.48 ? glowFirst : glowMiddle;
        const glowEnd = glowProgress < 0.48 ? glowMiddle : TRANSPARENT;
        const glowAmount =
          glowProgress < 0.48 ? glowProgress / 0.48 : (glowProgress - 0.48) / 0.52;
        const glowAlpha = mixChannel(glowStart[3], glowEnd[3], glowAmount) / 255;
        this.#words[row * this.width + column] = packChannels(
          mixChannel(
            baseRed,
            mixChannel(glowStart[0], glowEnd[0], glowAmount),
            glowAlpha,
          ),
          mixChannel(
            baseGreen,
            mixChannel(glowStart[1], glowEnd[1], glowAmount),
            glowAlpha,
          ),
          mixChannel(
            baseBlue,
            mixChannel(glowStart[2], glowEnd[2], glowAmount),
            glowAlpha,
          ),
        );
      }
    }
  }

  public roundedGradientRect(
    bounds: Bounds,
    radius: number,
    first: Rgba,
    last: Rgba,
  ): void {
    const clip = this.#clip;
    const normalizedRadius = Math.max(
      0,
      Math.min(radius, bounds.width / 2, bounds.height / 2),
    );
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const denominator = Math.max(1, bounds.width + bounds.height);
    const r = normalizedRadius;
    const bx = bounds.x;
    const by = bounds.y;
    const bw = bounds.width;
    const bh = bounds.height;

    for (let row = top; row < bottom; row += 1) {
      const py = row + 0.5;
      for (let column = left; column < right; column += 1) {
        const px = column + 0.5;
        let coverage = 1;
        if (
          r > 0 &&
          (px < bx + r || px > bx + bw - r) &&
          (py < by + r || py > by + bh - r)
        ) {
          const cx = px < bx + r ? bx + r : bx + bw - r;
          const cy = py < by + r ? by + r : by + bh - r;
          const dist = Math.hypot(px - cx, py - cy);
          coverage = Math.min(1, Math.max(0, 0.5 + r - dist));
          if (coverage <= 0) continue;
        }

        const progress = clampUnit((column - bounds.x + (row - bounds.y)) / denominator);
        const color = interpolateRgba(first, last, progress);
        if (coverage >= 1) {
          this.setPixel(column, row, color);
        } else {
          this.#blendOffset(
            (row * this.width + column) * 4,
            color,
            (color[3] / 255) * coverage,
          );
        }
      }
    }
  }

  public softShadow(
    bounds: Bounds,
    radius: number,
    shadow: DesktopShadowAppearance | NativeShadow,
    radii?: NativeCornerRadii,
    opacity = 1,
  ): void {
    const clip = this.#clip;
    const color = parseColor(shadow.color);
    const mask = resolveShadowMask(bounds.width, bounds.height, radius, shadow, radii);
    const originX = Math.floor(bounds.x) + mask.offsetX;
    const originY = Math.floor(bounds.y) + mask.offsetY;
    const left = Math.max(clip.left, originX);
    const top = Math.max(clip.top, originY);
    const right = Math.min(clip.right, originX + mask.width);
    const bottom = Math.min(clip.bottom, originY + mask.height);
    const shadowOpacity =
      "y" in shadow && shadow.opacity !== undefined ? shadow.opacity : 1;
    const colorAlpha = (color[3] / 255) * shadowOpacity * opacity;
    for (let row = top; row < bottom; row += 1) {
      let maskOffset = (row - originY) * mask.width + left - originX;
      for (let column = left; column < right; column += 1) {
        const alpha = mask.alpha[maskOffset] ?? 0;
        if (alpha > 0)
          this.#blendOffset(
            (row * this.width + column) * 4,
            color,
            colorAlpha * (alpha / 255),
          );
        maskOffset += 1;
      }
    }
  }

  #roundedRectUniform(bounds: Bounds, radius: number, color: Rgba, border?: Rgba): void {
    const normalizedRadius = Math.max(
      0,
      Math.min(radius, bounds.width / 2, bounds.height / 2),
    );
    if (normalizedRadius <= 0.5) {
      if (border !== undefined) {
        this.fillRect(bounds, border);
        if (bounds.width > 2 && bounds.height > 2)
          this.fillRect(
            {
              x: bounds.x + 1,
              y: bounds.y + 1,
              width: bounds.width - 2,
              height: bounds.height - 2,
            },
            color,
          );
      } else {
        this.fillRect(bounds, color);
      }
      return;
    }

    const clip = this.#clip;
    const bx = bounds.x;
    const by = bounds.y;
    const bw = bounds.width;
    const bh = bounds.height;
    const r = normalizedRadius;

    // Fast interior body (central horizontal band)
    const innerTop = Math.max(clip.top, Math.ceil(by + r));
    const innerBottom = Math.min(clip.bottom, Math.floor(by + bh - r));
    if (innerBottom > innerTop) {
      if (border !== undefined) {
        this.fillRect(
          { x: bx, y: innerTop, width: 1, height: innerBottom - innerTop },
          border,
        );
        if (bw > 2) {
          this.fillRect(
            { x: bx + 1, y: innerTop, width: bw - 2, height: innerBottom - innerTop },
            color,
          );
        }
        this.fillRect(
          { x: bx + bw - 1, y: innerTop, width: 1, height: innerBottom - innerTop },
          border,
        );
      } else {
        this.fillRect(
          { x: bx, y: innerTop, width: bw, height: innerBottom - innerTop },
          color,
        );
      }
    }

    // Central vertical strips (top and bottom between corner blocks)
    const innerLeft = Math.max(clip.left, Math.ceil(bx + r));
    const innerRight = Math.min(clip.right, Math.floor(bx + bw - r));
    if (innerRight > innerLeft) {
      const topStart = Math.max(clip.top, Math.floor(by));
      const topEnd = Math.min(clip.bottom, innerTop);
      if (topEnd > topStart) {
        if (border !== undefined) {
          this.fillRect(
            { x: innerLeft, y: topStart, width: innerRight - innerLeft, height: 1 },
            border,
          );
          if (topEnd > topStart + 1) {
            this.fillRect(
              {
                x: innerLeft,
                y: topStart + 1,
                width: innerRight - innerLeft,
                height: topEnd - (topStart + 1),
              },
              color,
            );
          }
        } else {
          this.fillRect(
            {
              x: innerLeft,
              y: topStart,
              width: innerRight - innerLeft,
              height: topEnd - topStart,
            },
            color,
          );
        }
      }
      const bottomStart = Math.max(clip.top, innerBottom);
      const bottomEnd = Math.min(clip.bottom, Math.ceil(by + bh));
      if (bottomEnd > bottomStart) {
        if (border !== undefined) {
          if (bottomEnd - 1 > bottomStart) {
            this.fillRect(
              {
                x: innerLeft,
                y: bottomStart,
                width: innerRight - innerLeft,
                height: bottomEnd - 1 - bottomStart,
              },
              color,
            );
          }
          this.fillRect(
            { x: innerLeft, y: bottomEnd - 1, width: innerRight - innerLeft, height: 1 },
            border,
          );
        } else {
          this.fillRect(
            {
              x: innerLeft,
              y: bottomStart,
              width: innerRight - innerLeft,
              height: bottomEnd - bottomStart,
            },
            color,
          );
        }
      }
    }

    // 4 Corner zones with distance-field subpixel anti-aliasing
    const corners = [
      [bx, bx + r, by, by + r, bx + r, by + r],
      [bx + bw - r, bx + bw, by, by + r, bx + bw - r, by + r],
      [bx, bx + r, by + bh - r, by + bh, bx + r, by + bh - r],
      [bx + bw - r, bx + bw, by + bh - r, by + bh, bx + bw - r, by + bh - r],
    ] as const;

    const colorAlpha = color[3] / 255;
    const borderAlpha = border !== undefined ? border[3] / 255 : 0;
    const innerR = Math.max(0, r - 1);

    for (const [cMinX, cMaxX, cMinY, cMaxY, cx, cy] of corners) {
      const cLeft = Math.max(clip.left, Math.floor(cMinX));
      const cRight = Math.min(clip.right, Math.ceil(cMaxX));
      const cTop = Math.max(clip.top, Math.floor(cMinY));
      const cBottom = Math.min(clip.bottom, Math.ceil(cMaxY));

      for (let row = cTop; row < cBottom; row += 1) {
        const py = row + 0.5;
        const dy = py - cy;
        const dy2 = dy * dy;
        for (let col = cLeft; col < cRight; col += 1) {
          const px = col + 0.5;
          const dx = px - cx;
          const dist = Math.sqrt(dx * dx + dy2);

          const outerCoverage = Math.min(1, Math.max(0, 0.5 + r - dist));
          if (outerCoverage <= 0) continue;

          if (border !== undefined) {
            const innerCoverage = Math.min(1, Math.max(0, 0.5 + innerR - dist));
            const borderCoverage = outerCoverage - innerCoverage;
            const offset = (row * this.width + col) * 4;
            if (borderCoverage > 0) {
              this.#blendOffset(offset, border, borderAlpha * borderCoverage);
            }
            if (innerCoverage > 0) {
              this.#blendOffset(offset, color, colorAlpha * innerCoverage);
            }
          } else {
            const offset = (row * this.width + col) * 4;
            this.#blendOffset(offset, color, colorAlpha * outerCoverage);
          }
        }
      }
    }
  }

  public roundedRect(
    bounds: Bounds,
    radius: number,
    color: Rgba,
    border?: Rgba,
    radii?: NativeCornerRadii,
    borderWidth = 1,
    borderStyle: "solid" | "dashed" | "dotted" = "solid",
    opacity = 1,
  ): void {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const isUniformRadii =
      radii === undefined ||
      (radii.topLeft === radius &&
        radii.topRight === radius &&
        radii.bottomLeft === radius &&
        radii.bottomRight === radius);
    if (isUniformRadii && borderWidth === 1 && borderStyle === "solid" && opacity === 1) {
      this.#roundedRectUniform(bounds, radius, color, border);
      return;
    }

    const clip = this.#clip;
    const resolved = resolveRadii(bounds, radius, radii);
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const colorAlpha = (color[3] / 255) * opacity;
    const borderAlpha = border !== undefined ? (border[3] / 255) * opacity : 0;
    const bw = bounds.width;
    const bh = bounds.height;
    const bx = bounds.x;
    const by = bounds.y;
    const dashLength =
      borderStyle === "dotted" ? Math.max(2, borderWidth) : Math.max(6, borderWidth * 3);

    for (let row = top; row < bottom; row += 1) {
      const py = row + 0.5;
      for (let col = left; col < right; col += 1) {
        const px = col + 0.5;
        const {
          r: cr,
          dist: cDist,
          isCorner,
        } = getCornerDistance(px, py, bounds, resolved);
        let outerCoverage = 1;
        if (isCorner) {
          outerCoverage = Math.min(1, Math.max(0, 0.5 + cr - cDist));
          if (outerCoverage <= 0) continue;
        }

        if (border !== undefined && borderWidth > 0) {
          let innerCoverage: number;
          if (isCorner) {
            const innerR = Math.max(0, cr - borderWidth);
            innerCoverage = Math.min(1, Math.max(0, 0.5 + innerR - cDist));
          } else {
            const minEdgeDist = Math.min(px - bx, bx + bw - px, py - by, by + bh - py);
            innerCoverage = Math.min(1, Math.max(0, 0.5 + minEdgeDist - borderWidth));
          }
          const borderCoverage = Math.max(0, outerCoverage - innerCoverage);

          let inDash = true;
          if (borderStyle !== "solid") {
            let perimeter = 0;
            if (py <= by + borderWidth) {
              perimeter = px - bx;
            } else if (px >= bx + bw - borderWidth) {
              perimeter = bw + (py - by);
            } else if (py >= by + bh - borderWidth) {
              perimeter = bw + bh + (bx + bw - px);
            } else {
              perimeter = 2 * bw + bh + (by + bh - py);
            }
            inDash = Math.floor(perimeter / dashLength) % 2 === 0;
          }

          const offset = (row * this.width + col) * 4;
          if (inDash && borderCoverage > 0 && borderAlpha > 0) {
            this.#blendOffset(offset, border, borderAlpha * borderCoverage);
          }
          if (innerCoverage > 0 && colorAlpha > 0) {
            this.#blendOffset(offset, color, colorAlpha * innerCoverage);
          }
        } else {
          const offset = (row * this.width + col) * 4;
          if (colorAlpha > 0) {
            this.#blendOffset(offset, color, colorAlpha * outerCoverage);
          }
        }
      }
    }
  }

  public drawGradient(
    bounds: Bounds,
    radius: number,
    radii: NativeCornerRadii | undefined,
    gradient: NativeGradient,
    opacity = 1,
    borderColor?: Rgba,
    borderWidth = 1,
    borderStyle: "solid" | "dashed" | "dotted" = "solid",
  ): void {
    if (bounds.width <= 0 || bounds.height <= 0 || gradient.stops.length === 0) return;
    const clip = this.#clip;
    const resolved = resolveRadii(bounds, radius, radii);
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const borderAlpha = borderColor !== undefined ? (borderColor[3] / 255) * opacity : 0;
    const bw = bounds.width;
    const bh = bounds.height;
    const bx = bounds.x;
    const by = bounds.y;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const parsedStops = gradient.stops.map((s) => ({
      offset: s.offset,
      color: parseColor(s.color),
    }));
    const dashLength =
      borderStyle === "dotted" ? Math.max(2, borderWidth) : Math.max(6, borderWidth * 3);

    const isLinear = gradient.kind === "linear";
    let dx = 0;
    let dy = 1;
    let len = Math.max(1, bh);
    let rRad = Math.max(1, Math.max(bw, bh) / 2);

    if (isLinear) {
      const angle = gradient.angle ?? 180;
      const rad = (angle * Math.PI) / 180;
      dx = Math.sin(rad);
      dy = -Math.cos(rad);
      len = Math.max(1, Math.abs(bw * dx) + Math.abs(bh * dy));
    } else {
      rRad = Math.max(1, Math.max(bw, bh) / 2);
    }

    for (let row = top; row < bottom; row += 1) {
      const py = row + 0.5;
      for (let col = left; col < right; col += 1) {
        const px = col + 0.5;
        const {
          r: cr,
          dist: cDist,
          isCorner,
        } = getCornerDistance(px, py, bounds, resolved);
        let outerCoverage = 1;
        if (isCorner) {
          outerCoverage = Math.min(1, Math.max(0, 0.5 + cr - cDist));
          if (outerCoverage <= 0) continue;
        }

        let t: number;
        if (isLinear) {
          const proj = (px - cx) * dx + (py - cy) * dy;
          t = clampUnit(0.5 + proj / len);
        } else {
          const dist = Math.hypot(px - cx, py - cy);
          t = clampUnit(dist / rRad);
        }

        const gradColor = sampleStops(parsedStops, t);
        const gradAlpha = (gradColor[3] / 255) * opacity;

        if (borderColor !== undefined && borderWidth > 0) {
          let innerCoverage: number;
          if (isCorner) {
            const innerR = Math.max(0, cr - borderWidth);
            innerCoverage = Math.min(1, Math.max(0, 0.5 + innerR - cDist));
          } else {
            const minEdgeDist = Math.min(px - bx, bx + bw - px, py - by, by + bh - py);
            innerCoverage = Math.min(1, Math.max(0, 0.5 + minEdgeDist - borderWidth));
          }
          const borderCoverage = Math.max(0, outerCoverage - innerCoverage);

          let inDash = true;
          if (borderStyle !== "solid") {
            let perimeter = 0;
            if (py <= by + borderWidth) {
              perimeter = px - bx;
            } else if (px >= bx + bw - borderWidth) {
              perimeter = bw + (py - by);
            } else if (py >= by + bh - borderWidth) {
              perimeter = bw + bh + (bx + bw - px);
            } else {
              perimeter = 2 * bw + bh + (by + bh - py);
            }
            inDash = Math.floor(perimeter / dashLength) % 2 === 0;
          }

          const offset = (row * this.width + col) * 4;
          if (inDash && borderCoverage > 0 && borderAlpha > 0) {
            this.#blendOffset(offset, borderColor, borderAlpha * borderCoverage);
          }
          if (innerCoverage > 0 && gradAlpha > 0) {
            this.#blendOffset(offset, gradColor, gradAlpha * innerCoverage);
          }
        } else {
          const offset = (row * this.width + col) * 4;
          if (gradAlpha > 0) {
            this.#blendOffset(offset, gradColor, gradAlpha * outerCoverage);
          }
        }
      }
    }
  }

  public backdropBlur(
    bounds: Bounds,
    radius: number,
    radii: NativeCornerRadii | undefined,
    blurRadius: number,
  ): void {
    if (blurRadius <= 0 || bounds.width <= 0 || bounds.height <= 0) return;
    const clip = this.#clip;
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const regionW = right - left;
    const regionH = bottom - top;
    if (regionW <= 0 || regionH <= 0) return;

    const r = Math.max(1, Math.min(24, Math.round(blurRadius)));
    const temp = new Uint8Array(regionW * regionH * 4);
    for (let row = 0; row < regionH; row += 1) {
      const srcOffset = ((top + row) * this.width + left) * 4;
      const dstOffset = row * regionW * 4;
      temp.set(this.pixels.subarray(srcOffset, srcOffset + regionW * 4), dstOffset);
    }

    const blurred = this.#boxBlur(temp, regionW, regionH, r);
    const resolved = resolveRadii(bounds, radius, radii);
    for (let row = top; row < bottom; row += 1) {
      const py = row + 0.5;
      const localRow = row - top;
      for (let col = left; col < right; col += 1) {
        const px = col + 0.5;
        const {
          r: cr,
          dist: cDist,
          isCorner,
        } = getCornerDistance(px, py, bounds, resolved);
        let coverage = 1;
        if (isCorner) {
          coverage = Math.min(1, Math.max(0, 0.5 + cr - cDist));
          if (coverage <= 0) continue;
        }

        const localCol = col - left;
        const srcOffset = (localRow * regionW + localCol) * 4;
        const dstOffset = (row * this.width + col) * 4;

        const b0 = blurred[srcOffset] ?? 0;
        const b1 = blurred[srcOffset + 1] ?? 0;
        const b2 = blurred[srcOffset + 2] ?? 0;
        const b3 = blurred[srcOffset + 3] ?? 255;

        if (coverage >= 1) {
          this.pixels[dstOffset] = b0;
          this.pixels[dstOffset + 1] = b1;
          this.pixels[dstOffset + 2] = b2;
          this.pixels[dstOffset + 3] = b3;
        } else {
          this.#blendOffset(dstOffset, [b0, b1, b2, b3], (b3 / 255) * coverage);
        }
      }
    }
  }

  public blurRegion(bounds: Bounds, blurRadius: number): void {
    if (blurRadius <= 0 || bounds.width <= 0 || bounds.height <= 0) return;
    const clip = this.#clip;
    const left = Math.max(clip.left, Math.floor(bounds.x));
    const top = Math.max(clip.top, Math.floor(bounds.y));
    const right = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const bottom = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    const regionW = right - left;
    const regionH = bottom - top;
    if (regionW <= 0 || regionH <= 0) return;

    const r = Math.max(1, Math.min(24, Math.round(blurRadius)));
    const temp = new Uint8Array(regionW * regionH * 4);
    for (let row = 0; row < regionH; row += 1) {
      const srcOffset = ((top + row) * this.width + left) * 4;
      const dstOffset = row * regionW * 4;
      temp.set(this.pixels.subarray(srcOffset, srcOffset + regionW * 4), dstOffset);
    }
    const blurred = this.#boxBlur(temp, regionW, regionH, r);
    for (let row = 0; row < regionH; row += 1) {
      const srcOffset = row * regionW * 4;
      const dstOffset = ((top + row) * this.width + left) * 4;
      this.pixels.set(blurred.subarray(srcOffset, srcOffset + regionW * 4), dstOffset);
    }
  }

  #boxBlur(
    source: Uint8Array,
    width: number,
    height: number,
    radius: number,
  ): Uint8Array {
    const intermediate = new Uint8Array(width * height * 4);
    const output = new Uint8Array(width * height * 4);

    // Pass 1: Horizontal blur using prefix sums
    const cumR = new Float64Array(width + 1);
    const cumG = new Float64Array(width + 1);
    const cumB = new Float64Array(width + 1);
    const cumA = new Float64Array(width + 1);

    for (let row = 0; row < height; row += 1) {
      const rowOffset = row * width * 4;
      cumR[0] = 0;
      cumG[0] = 0;
      cumB[0] = 0;
      cumA[0] = 0;
      for (let col = 0; col < width; col += 1) {
        const offset = rowOffset + col * 4;
        cumR[col + 1] = (cumR[col] ?? 0) + (source[offset] ?? 0);
        cumG[col + 1] = (cumG[col] ?? 0) + (source[offset + 1] ?? 0);
        cumB[col + 1] = (cumB[col] ?? 0) + (source[offset + 2] ?? 0);
        cumA[col + 1] = (cumA[col] ?? 0) + (source[offset + 3] ?? 0);
      }

      for (let col = 0; col < width; col += 1) {
        const c0 = Math.max(0, col - radius);
        const c1 = Math.min(width, col + radius + 1);
        const span = c1 - c0;
        const dst = rowOffset + col * 4;
        intermediate[dst] = Math.round(((cumR[c1] ?? 0) - (cumR[c0] ?? 0)) / span);
        intermediate[dst + 1] = Math.round(((cumG[c1] ?? 0) - (cumG[c0] ?? 0)) / span);
        intermediate[dst + 2] = Math.round(((cumB[c1] ?? 0) - (cumB[c0] ?? 0)) / span);
        intermediate[dst + 3] = Math.round(((cumA[c1] ?? 0) - (cumA[c0] ?? 0)) / span);
      }
    }

    // Pass 2: Vertical blur using prefix sums
    const vCumR = new Float64Array(height + 1);
    const vCumG = new Float64Array(height + 1);
    const vCumB = new Float64Array(height + 1);
    const vCumA = new Float64Array(height + 1);

    for (let col = 0; col < width; col += 1) {
      vCumR[0] = 0;
      vCumG[0] = 0;
      vCumB[0] = 0;
      vCumA[0] = 0;
      for (let row = 0; row < height; row += 1) {
        const offset = (row * width + col) * 4;
        vCumR[row + 1] = (vCumR[row] ?? 0) + (intermediate[offset] ?? 0);
        vCumG[row + 1] = (vCumG[row] ?? 0) + (intermediate[offset + 1] ?? 0);
        vCumB[row + 1] = (vCumB[row] ?? 0) + (intermediate[offset + 2] ?? 0);
        vCumA[row + 1] = (vCumA[row] ?? 0) + (intermediate[offset + 3] ?? 0);
      }

      for (let row = 0; row < height; row += 1) {
        const r0 = Math.max(0, row - radius);
        const r1 = Math.min(height, row + radius + 1);
        const span = r1 - r0;
        const dst = (row * width + col) * 4;
        output[dst] = Math.round(((vCumR[r1] ?? 0) - (vCumR[r0] ?? 0)) / span);
        output[dst + 1] = Math.round(((vCumG[r1] ?? 0) - (vCumG[r0] ?? 0)) / span);
        output[dst + 2] = Math.round(((vCumB[r1] ?? 0) - (vCumB[r0] ?? 0)) / span);
        output[dst + 3] = Math.round(((vCumA[r1] ?? 0) - (vCumA[r0] ?? 0)) / span);
      }
    }

    return output;
  }

  public strokeRect(bounds: Bounds, color: Rgba, thickness = 1): void {
    this.fillRect({ ...bounds, height: thickness }, color);
    this.fillRect(
      {
        x: bounds.x,
        y: bounds.y + bounds.height - thickness,
        width: bounds.width,
        height: thickness,
      },
      color,
    );
    this.fillRect({ ...bounds, width: thickness }, color);
    this.fillRect(
      {
        x: bounds.x + bounds.width - thickness,
        y: bounds.y,
        width: thickness,
        height: bounds.height,
      },
      color,
    );
  }

  public drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Rgba,
    thickness = 1,
  ): void {
    const halfThick = Math.max(0.5, thickness / 2);
    // Fast path: axis-aligned straight lines
    if (Math.round(y0) === Math.round(y1)) {
      const y = Math.round(y0 - halfThick);
      const startX = Math.min(x0, x1);
      const len = Math.abs(x1 - x0);
      this.fillRect(
        {
          x: Math.round(startX),
          y,
          width: Math.max(1, Math.round(len)),
          height: Math.max(1, Math.round(thickness)),
        },
        color,
      );
      return;
    }
    if (Math.round(x0) === Math.round(x1)) {
      const x = Math.round(x0 - halfThick);
      const startY = Math.min(y0, y1);
      const len = Math.abs(y1 - y0);
      this.fillRect(
        {
          x,
          y: Math.round(startY),
          width: Math.max(1, Math.round(thickness)),
          height: Math.max(1, Math.round(len)),
        },
        color,
      );
      return;
    }

    const clip = this.#clip;
    const minX = Math.max(clip.left, Math.floor(Math.min(x0, x1) - halfThick - 1));
    const maxX = Math.min(clip.right, Math.ceil(Math.max(x0, x1) + halfThick + 1));
    const minY = Math.max(clip.top, Math.floor(Math.min(y0, y1) - halfThick - 1));
    const maxY = Math.min(clip.bottom, Math.ceil(Math.max(y0, y1) + halfThick + 1));

    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      this.fillCircle(x0, y0, halfThick, color);
      return;
    }

    const colorAlpha = color[3] / 255;
    for (let row = minY; row < maxY; row += 1) {
      const py = row + 0.5;
      for (let col = minX; col < maxX; col += 1) {
        const px = col + 0.5;
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
        const projX = x0 + t * dx;
        const projY = y0 + t * dy;
        const dist = Math.hypot(px - projX, py - projY);
        const coverage = Math.min(1, Math.max(0, 0.5 + halfThick - dist));
        if (coverage > 0) {
          this.#blendOffset((row * this.width + col) * 4, color, colorAlpha * coverage);
        }
      }
    }
  }

  public fillCircle(centerX: number, centerY: number, radius: number, color: Rgba): void {
    if (radius <= 0) return;
    const clip = this.#clip;
    const left = Math.max(clip.left, Math.floor(centerX - radius - 1));
    const right = Math.min(clip.right, Math.ceil(centerX + radius + 1));
    const top = Math.max(clip.top, Math.floor(centerY - radius - 1));
    const bottom = Math.min(clip.bottom, Math.ceil(centerY + radius + 1));
    const colorAlpha = color[3] / 255;
    for (let row = top; row < bottom; row += 1) {
      const py = row + 0.5;
      const dy = py - centerY;
      const dy2 = dy * dy;
      for (let col = left; col < right; col += 1) {
        const px = col + 0.5;
        const dx = px - centerX;
        const dist = Math.sqrt(dx * dx + dy2);
        const coverage = Math.min(1, Math.max(0, 0.5 + radius - dist));
        if (coverage > 0) {
          this.#blendOffset((row * this.width + col) * 4, color, colorAlpha * coverage);
        }
      }
    }
  }

  public strokeCircle(
    centerX: number,
    centerY: number,
    radius: number,
    color: Rgba,
    thickness = 1,
  ): void {
    if (radius <= 0 || thickness <= 0) return;
    const clip = this.#clip;
    const halfThick = thickness / 2;
    const outerRadius = radius + halfThick;
    const left = Math.max(clip.left, Math.floor(centerX - outerRadius - 1));
    const right = Math.min(clip.right, Math.ceil(centerX + outerRadius + 1));
    const top = Math.max(clip.top, Math.floor(centerY - outerRadius - 1));
    const bottom = Math.min(clip.bottom, Math.ceil(centerY + outerRadius + 1));
    const colorAlpha = color[3] / 255;
    for (let row = top; row < bottom; row += 1) {
      const py = row + 0.5;
      const dy = py - centerY;
      const dy2 = dy * dy;
      for (let col = left; col < right; col += 1) {
        const px = col + 0.5;
        const dx = px - centerX;
        const dist = Math.sqrt(dx * dx + dy2);
        const distFromStrokeCenter = Math.abs(dist - radius);
        const coverage = Math.min(1, Math.max(0, 0.5 + halfThick - distFromStrokeCenter));
        if (coverage > 0) {
          this.#blendOffset((row * this.width + col) * 4, color, colorAlpha * coverage);
        }
      }
    }
  }

  public fillPolygon(points: readonly (readonly [number, number])[], color: Rgba): void {
    if (points.length < 3) return;
    const minimumY = Math.floor(Math.min(...points.map((point) => point[1])));
    const maximumY = Math.ceil(Math.max(...points.map((point) => point[1])));
    const clip = this.#clip;
    const colorAlpha = color[3] / 255;
    for (let y = minimumY; y <= maximumY; y += 1) {
      if (y < clip.top || y >= clip.bottom) continue;
      const intersections: number[] = [];
      for (let index = 0; index < points.length; index += 1) {
        const first = points[index];
        const second = points[(index + 1) % points.length];
        if (first === undefined || second === undefined) continue;
        if ((first[1] <= y && second[1] > y) || (second[1] <= y && first[1] > y))
          intersections.push(
            first[0] + ((y - first[1]) * (second[0] - first[0])) / (second[1] - first[1]),
          );
      }
      intersections.sort((left, right) => left - right);
      for (let index = 0; index < intersections.length; index += 2) {
        const start = intersections[index];
        const end = intersections[index + 1];
        if (start === undefined || end === undefined || end <= start) continue;
        const leftPixel = Math.floor(start);
        const rightPixel = Math.floor(end);

        if (leftPixel === rightPixel) {
          const coverage = Math.max(0, Math.min(1, end - start));
          if (leftPixel >= clip.left && leftPixel < clip.right && coverage > 0) {
            this.#blendOffset(
              (y * this.width + leftPixel) * 4,
              color,
              colorAlpha * coverage,
            );
          }
        } else {
          const startCov = Math.max(0, Math.min(1, leftPixel + 1 - start));
          if (leftPixel >= clip.left && leftPixel < clip.right && startCov > 0) {
            this.#blendOffset(
              (y * this.width + leftPixel) * 4,
              color,
              colorAlpha * startCov,
            );
          }
          const innerLeft = Math.max(clip.left, leftPixel + 1);
          const innerRight = Math.min(clip.right, rightPixel);
          if (innerRight > innerLeft) {
            this.fillRect(
              { x: innerLeft, y, width: innerRight - innerLeft, height: 1 },
              color,
            );
          }
          const endCov = Math.max(0, Math.min(1, end - rightPixel));
          if (rightPixel >= clip.left && rightPixel < clip.right && endCov > 0) {
            this.#blendOffset(
              (y * this.width + rightPixel) * 4,
              color,
              colorAlpha * endCov,
            );
          }
        }
      }
    }
  }

  public measureText(text: string, scale: number): number {
    if (text.length === 0) return 0;
    const normalizedScale = Math.max(1, Math.round(scale));
    let total = 0;
    for (const character of text) {
      if (character === "\uFE0F" || character === "\uFE0E" || character === "\u200D")
        continue;
      total +=
        resolveAtlasGlyph(character, scale)?.advance ??
        getCharacterAdvance(character, normalizedScale);
    }
    return Math.max(0, total);
  }

  public truncateText(text: string, scale: number, maxWidth: number): string {
    if (maxWidth <= 0) return "";
    if (this.measureText(text, scale) <= maxWidth) return text;
    const ellipsis = "…";
    const ellipsisWidth = this.measureText(ellipsis, scale);
    if (ellipsisWidth > maxWidth) return "";
    const chars = Array.from(text);
    let low = 0;
    let high = chars.length;
    let best = "";
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = `${chars.slice(0, mid).join("").trimEnd()}${ellipsis}`;
      if (this.measureText(candidate, scale) <= maxWidth) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  public drawText(
    text: string,
    x: number,
    y: number,
    scale: number,
    color: Rgba,
    align: "start" | "center" | "end" = "start",
    maxWidth = Number.POSITIVE_INFINITY,
  ): void {
    const normalizedScale = Math.max(1, Math.round(scale));
    const renderText = Number.isFinite(maxWidth)
      ? this.truncateText(text, scale, maxWidth)
      : text;
    if (renderText.length === 0) return;
    const renderWidth = this.measureText(renderText, scale);
    let cursorX =
      align === "center"
        ? Math.round(x - renderWidth / 2)
        : align === "end"
          ? Math.round(x - renderWidth)
          : Math.round(x);
    const startX = cursorX;
    for (const character of renderText) {
      if (character === "\uFE0F" || character === "\uFE0E" || character === "\u200D")
        continue;
      const code = character.charCodeAt(0);
      if (code < 32 || code === 127) continue;
      const atlasGlyph = resolveAtlasGlyph(character, scale);
      const advance =
        atlasGlyph?.advance ?? getCharacterAdvance(character, normalizedScale);
      if (cursorX + advance - startX > maxWidth) break;
      const glyph = atlasGlyph ?? resolveGlyphMask(character, normalizedScale);
      const glyphX =
        atlasGlyph === undefined ? cursorX - 1 : Math.round(cursorX + atlasGlyph.left);
      const glyphY =
        atlasGlyph === undefined
          ? Math.round(y) - 1
          : Math.round(y + atlasGlyph.ascent + atlasGlyph.top);
      const clip = this.#clip;
      const colorAlpha = color[3] / 255;
      for (let row = 0; row < glyph.height; row += 1) {
        const targetY = glyphY + row;
        if (targetY < clip.top || targetY >= clip.bottom) continue;
        for (let column = 0; column < glyph.width; column += 1) {
          const targetX = glyphX + column;
          if (targetX < clip.left || targetX >= clip.right) continue;
          const alpha = glyph.alpha[row * glyph.width + column] ?? 0;
          if (alpha === 0) continue;
          this.#blendOffset(
            (targetY * this.width + targetX) * 4,
            color,
            colorAlpha * (alpha / 255),
          );
        }
      }
      cursorX += atlasGlyph?.advance ?? advance;
    }
  }

  public drawBitmap(
    source: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    bounds: Bounds,
    opacity = 1,
  ): void {
    if (
      sourceWidth < 1 ||
      sourceHeight < 1 ||
      source.byteLength !== sourceWidth * sourceHeight * 4 ||
      bounds.width <= 0 ||
      bounds.height <= 0
    )
      return;
    const clip = this.#clip;
    const startX = Math.max(clip.left, Math.floor(bounds.x));
    const startY = Math.max(clip.top, Math.floor(bounds.y));
    const endX = Math.min(clip.right, Math.ceil(bounds.x + bounds.width));
    const endY = Math.min(clip.bottom, Math.ceil(bounds.y + bounds.height));
    for (let targetY = startY; targetY < endY; targetY += 1) {
      const sourceY = Math.max(
        0,
        Math.min(
          sourceHeight - 1,
          Math.floor(((targetY - bounds.y) / bounds.height) * sourceHeight),
        ),
      );
      for (let targetX = startX; targetX < endX; targetX += 1) {
        const sourceX = Math.max(
          0,
          Math.min(
            sourceWidth - 1,
            Math.floor(((targetX - bounds.x) / bounds.width) * sourceWidth),
          ),
        );
        const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
        const color: Rgba = [
          source[sourceOffset] ?? 0,
          source[sourceOffset + 1] ?? 0,
          source[sourceOffset + 2] ?? 0,
          source[sourceOffset + 3] ?? 255,
        ];
        this.#blendOffset(
          (targetY * this.width + targetX) * 4,
          color,
          (color[3] / 255) * opacity,
        );
      }
    }
  }

  get #clip(): Clip {
    return (
      this.#clips.at(-1) ?? {
        left: 0,
        top: 0,
        right: this.width,
        bottom: this.height,
      }
    );
  }

  #blendOffset(offset: number, color: Rgba, alpha: number): void {
    this.pixels[offset] = Math.round(
      color[0] * alpha + (this.pixels[offset] ?? 0) * (1 - alpha),
    );
    this.pixels[offset + 1] = Math.round(
      color[1] * alpha + (this.pixels[offset + 1] ?? 0) * (1 - alpha),
    );
    this.pixels[offset + 2] = Math.round(
      color[2] * alpha + (this.pixels[offset + 2] ?? 0) * (1 - alpha),
    );
    this.pixels[offset + 3] = 255;
  }
}

function parseColor(value: string): Rgba {
  const key = value.trim().toLowerCase();
  const cached = COLOR_CACHE.get(key);
  if (cached !== undefined) return cached;
  const color = parseNormalizedColor(key);
  COLOR_CACHE.set(key, color);
  return color;
}

function parseNormalizedColor(hex: string): Rgba {
  if (hex === "transparent") return [0, 0, 0, 0];
  if (/^#[0-9a-f]{3}$/.test(hex))
    return [
      Number.parseInt(hex.charAt(1).repeat(2), 16),
      Number.parseInt(hex.charAt(2).repeat(2), 16),
      Number.parseInt(hex.charAt(3).repeat(2), 16),
      255,
    ];
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex))
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
      hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) : 255,
    ];
  const match =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      hex,
    );
  if (match !== null)
    return [
      clampByte(Number(match[1])),
      clampByte(Number(match[2])),
      clampByte(Number(match[3])),
      clampByte(match[4] === undefined ? 255 : Number(match[4]) * 255),
    ];
  return [255, 0, 255, 255];
}

function withAlpha(color: Rgba, multiplier: number): Rgba {
  return [color[0], color[1], color[2], clampByte(color[3] * multiplier)];
}

function interpolateRgba(first: Rgba, second: Rgba, progress: number): Rgba {
  const amount = clampUnit(progress);
  return [
    clampByte(first[0] + (second[0] - first[0]) * amount),
    clampByte(first[1] + (second[1] - first[1]) * amount),
    clampByte(first[2] + (second[2] - first[2]) * amount),
    clampByte(first[3] + (second[3] - first[3]) * amount),
  ];
}

interface ResolvedRadii {
  readonly topLeft: number;
  readonly topRight: number;
  readonly bottomLeft: number;
  readonly bottomRight: number;
}

function resolveRadii(
  bounds: Bounds,
  radius: number,
  radii?: NativeCornerRadii,
): ResolvedRadii {
  const maxR = Math.max(0, Math.min(bounds.width / 2, bounds.height / 2));
  const tl = Math.max(0, Math.min(radii?.topLeft ?? radius, maxR));
  const tr = Math.max(0, Math.min(radii?.topRight ?? radius, maxR));
  const bl = Math.max(0, Math.min(radii?.bottomLeft ?? radius, maxR));
  const br = Math.max(0, Math.min(radii?.bottomRight ?? radius, maxR));
  return { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br };
}

function pointInsideRoundedRectRadii(
  x: number,
  y: number,
  bounds: Bounds,
  radii: ResolvedRadii,
): boolean {
  if (
    x < bounds.x ||
    x >= bounds.x + bounds.width ||
    y < bounds.y ||
    y >= bounds.y + bounds.height
  )
    return false;
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  let r: number;
  let cx: number;
  let cy: number;
  if (x < midX && y < midY) {
    r = radii.topLeft;
    if (x >= bounds.x + r || y >= bounds.y + r) return true;
    cx = bounds.x + r;
    cy = bounds.y + r;
  } else if (x >= midX && y < midY) {
    r = radii.topRight;
    if (x < bounds.x + bounds.width - r || y >= bounds.y + r) return true;
    cx = bounds.x + bounds.width - r;
    cy = bounds.y + r;
  } else if (x < midX && y >= midY) {
    r = radii.bottomLeft;
    if (x >= bounds.x + r || y < bounds.y + bounds.height - r) return true;
    cx = bounds.x + r;
    cy = bounds.y + bounds.height - r;
  } else {
    r = radii.bottomRight;
    if (x < bounds.x + bounds.width - r || y < bounds.y + bounds.height - r) return true;
    cx = bounds.x + bounds.width - r;
    cy = bounds.y + bounds.height - r;
  }
  if (r <= 0) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;
}

function getCornerDistance(
  px: number,
  py: number,
  bounds: Bounds,
  radii: ResolvedRadii,
): { r: number; dist: number; isCorner: boolean } {
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  let r: number;
  let cx: number;
  let cy: number;
  if (px < midX && py < midY) {
    r = radii.topLeft;
    cx = bounds.x + r;
    cy = bounds.y + r;
    if (px >= cx || py >= cy) return { r, dist: 0, isCorner: false };
  } else if (px >= midX && py < midY) {
    r = radii.topRight;
    cx = bounds.x + bounds.width - r;
    cy = bounds.y + r;
    if (px <= cx || py >= cy) return { r, dist: 0, isCorner: false };
  } else if (px < midX && py >= midY) {
    r = radii.bottomLeft;
    cx = bounds.x + r;
    cy = bounds.y + bounds.height - r;
    if (px >= cx || py <= cy) return { r, dist: 0, isCorner: false };
  } else {
    r = radii.bottomRight;
    cx = bounds.x + bounds.width - r;
    cy = bounds.y + bounds.height - r;
    if (px <= cx || py <= cy) return { r, dist: 0, isCorner: false };
  }
  if (r <= 0) return { r: 0, dist: 0, isCorner: false };
  return { r, dist: Math.hypot(px - cx, py - cy), isCorner: true };
}

function roundedRectDistanceWithRadii(
  x: number,
  y: number,
  bounds: Bounds,
  radii: ResolvedRadii,
): number {
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  let r: number;
  let innerX: number;
  let innerY: number;
  if (x < midX && y < midY) {
    r = radii.topLeft;
    innerX = bounds.x + r;
    innerY = bounds.y + r;
  } else if (x >= midX && y < midY) {
    r = radii.topRight;
    innerX = bounds.x + bounds.width - r;
    innerY = bounds.y + r;
  } else if (x < midX && y >= midY) {
    r = radii.bottomLeft;
    innerX = bounds.x + r;
    innerY = bounds.y + bounds.height - r;
  } else {
    r = radii.bottomRight;
    innerX = bounds.x + bounds.width - r;
    innerY = bounds.y + bounds.height - r;
  }
  const qx = x < midX ? innerX - x : x - innerX;
  const qy = y < midY ? innerY - y : y - innerY;
  const signed =
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.max(0, signed);
}

function sampleStops(
  stops: readonly { readonly offset: number; readonly color: Rgba }[],
  t: number,
): Rgba {
  if (stops.length === 0) return [0, 0, 0, 255];
  const first = stops[0];
  if (first === undefined) return [0, 0, 0, 255];
  if (stops.length === 1 || t <= first.offset) return first.color;
  const last = stops[stops.length - 1];
  if (last === undefined) return first.color;
  if (t >= last.offset) return last.color;

  for (let i = 0; i < stops.length - 1; i += 1) {
    const s0 = stops[i];
    const s1 = stops[i + 1];
    if (s0 !== undefined && s1 !== undefined && t >= s0.offset && t <= s1.offset) {
      const span = s1.offset - s0.offset;
      const progress = span > 0 ? (t - s0.offset) / span : 0;
      return interpolateRgba(s0.color, s1.color, progress);
    }
  }
  return last.color;
}

function resolveShadowMask(
  width: number,
  height: number,
  radius: number,
  shadow: DesktopShadowAppearance | NativeShadow,
  radii?: NativeCornerRadii,
): ShadowMask {
  const offX = "y" in shadow && shadow.x !== undefined ? shadow.x : 0;
  const offY = "y" in shadow ? shadow.y : shadow.offsetY;
  const resolved = resolveRadii({ x: 0, y: 0, width, height }, radius, radii);
  const key = [
    width,
    height,
    resolved.topLeft,
    resolved.topRight,
    resolved.bottomLeft,
    resolved.bottomRight,
    shadow.blur,
    offX,
    offY,
  ].join(":");
  const cached = SHADOW_MASK_CACHE.get(key);
  if (cached !== undefined) return cached;
  const extent = Math.max(1, shadow.blur * 0.62);
  const offsetX = Math.floor(Math.min(0, offX) - extent);
  const offsetY = Math.floor(Math.min(0, offY) - extent);
  const maskWidth = Math.ceil(width + Math.max(0, offX) + extent) - offsetX;
  const maskHeight = Math.ceil(height + Math.max(0, offY) + extent) - offsetY;
  const alpha = new Uint8Array(maskWidth * maskHeight);
  const bounds = { x: 0, y: 0, width, height };
  const source = { x: offX, y: offY, width, height };
  for (let row = 0; row < maskHeight; row += 1)
    for (let column = 0; column < maskWidth; column += 1) {
      const x = column + offsetX;
      const y = row + offsetY;
      if (pointInsideRoundedRectRadii(x, y, bounds, resolved)) continue;
      const distance = roundedRectDistanceWithRadii(x, y, source, resolved);
      if (distance >= extent) continue;
      const falloff = 1 - distance / extent;
      alpha[row * maskWidth + column] = clampByte(falloff * falloff * 0.68 * 255);
    }
  const mask = Object.freeze({
    offsetX,
    offsetY,
    width: maskWidth,
    height: maskHeight,
    alpha,
  });
  if (SHADOW_MASK_CACHE.size >= MAXIMUM_SHADOW_MASKS) {
    const oldest = SHADOW_MASK_CACHE.keys().next().value;
    if (oldest !== undefined) SHADOW_MASK_CACHE.delete(oldest);
  }
  SHADOW_MASK_CACHE.set(key, mask);
  return mask;
}

function resolveGlyphMask(character: string, scale: number): GlyphMask {
  if (character === "\uFE0F" || character === "\uFE0E" || character === "\u200D") {
    return Object.freeze({ width: 0, height: 0, alpha: new Uint8Array(0) });
  }
  const key = `${character}:${String(scale)}`;
  const cached = GLYPH_MASK_CACHE.get(key);
  if (cached !== undefined) return cached;
  const glyph = FONT[character] ?? FONT["?"] ?? [];
  const glyphHeight = 9;
  const width = Math.max(1, 5 * scale + 2);
  const height = Math.max(1, glyphHeight * scale + 2);
  const alpha = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let sampleSum = 0;
      for (const [dx, dy] of [
        [-0.25, -0.25],
        [0.25, -0.25],
        [-0.25, 0.25],
        [0.25, 0.25],
      ] as const) {
        const sourceX = (column + dx - 0.5) / scale - 0.5;
        const sourceY = (row + dy - 0.5) / scale - 0.5;
        const left = Math.floor(sourceX);
        const top = Math.floor(sourceY);
        const horizontal = sourceX - left;
        const vertical = sourceY - top;
        const s00 = glyphSample(glyph, left, top);
        const s10 = glyphSample(glyph, left + 1, top);
        const s01 = glyphSample(glyph, left, top + 1);
        const s11 = glyphSample(glyph, left + 1, top + 1);
        const coverage =
          s00 * (1 - horizontal) * (1 - vertical) +
          s10 * horizontal * (1 - vertical) +
          s01 * (1 - horizontal) * vertical +
          s11 * horizontal * vertical;
        sampleSum += coverage;
      }
      const avg = sampleSum / 4;
      const t = Math.max(0, Math.min(1, (avg - 0.18) / 0.62));
      const smoothCoverage = t * t * (3 - 2 * t);
      alpha[row * width + column] = clampByte(smoothCoverage * 255);
    }
  }
  const mask = Object.freeze({ width, height, alpha });
  GLYPH_MASK_CACHE.set(key, mask);
  return mask;
}

function loadFontAtlas(): FontAtlas | undefined {
  const candidatePaths = [
    process.env["SEVYN_FONT_ATLAS"],
    "/usr/local/share/sevynos/font-atlas.json",
    "/run/sevynos/font-atlas.json",
  ].filter((p): p is string => typeof p === "string" && p.trim() !== "");

  for (const path of candidatePaths) {
    try {
      if (existsSync(path)) {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isFontAtlas(parsed)) return parsed;
      }
    } catch {
      // Ignore unreadable or invalid font atlas files
    }
  }
  return undefined;
}

function isFontAtlas(value: unknown): value is FontAtlas {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly family?: unknown; readonly sizes?: unknown };
  return (
    typeof candidate.family === "string" &&
    typeof candidate.sizes === "object" &&
    candidate.sizes !== null
  );
}

function resolveAtlasGlyph(
  character: string,
  scale: number,
): DecodedAtlasGlyph | undefined {
  if (FONT_ATLAS === undefined) return undefined;
  const size = Math.max(8, Math.min(32, Math.round(scale * 7)));
  const key = `${String(size)}:${character}`;
  const cached = ATLAS_GLYPH_CACHE.get(key);
  if (cached !== undefined) return cached;
  const atlasSize = FONT_ATLAS.sizes[String(size)];
  const source = atlasSize?.glyphs[character] ?? atlasSize?.glyphs["?"];
  if (atlasSize === undefined || source === undefined) return undefined;
  const alpha = Uint8Array.from(Buffer.from(source.alpha, "base64"));
  if (alpha.byteLength !== source.width * source.height) return undefined;
  const glyph: DecodedAtlasGlyph = Object.freeze({
    advance: source.advance,
    left: source.left,
    top: source.top,
    width: source.width,
    height: source.height,
    ascent: atlasSize.ascent,
    alpha,
  });
  ATLAS_GLYPH_CACHE.set(key, glyph);
  return glyph;
}

function glyphSample(glyph: readonly number[], column: number, row: number): number {
  if (column < 0 || column >= 5 || row < 0 || row >= glyph.length) return 0;
  return ((glyph[row] ?? 0) & (1 << (4 - column))) === 0 ? 0 : 1;
}

function packRgba(color: Rgba): number {
  return packChannels(color[0], color[1], color[2], color[3]);
}

function packChannels(red: number, green: number, blue: number, alpha = 255): number {
  return (
    ((clampByte(alpha) << 24) |
      (clampByte(blue) << 16) |
      (clampByte(green) << 8) |
      clampByte(red)) >>>
    0
  );
}

function mixChannel(first: number, second: number, progress: number): number {
  return clampByte(first + (second - first) * clampUnit(progress));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const FONT: Readonly<Record<string, readonly number[]>> = Object.freeze({
  " ": [0, 0, 0, 0, 0, 0, 0],
  "!": [4, 4, 4, 4, 4, 0, 4],
  '"': [10, 10, 10, 0, 0, 0, 0],
  "#": [10, 31, 10, 10, 31, 10, 0],
  "%": [17, 2, 4, 8, 17, 0, 0],
  "&": [12, 18, 20, 8, 21, 18, 13],
  "'": [4, 4, 4, 0, 0, 0, 0],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  "*": [0, 21, 14, 31, 14, 21, 0],
  "+": [0, 4, 4, 31, 4, 4, 0],
  ",": [0, 0, 0, 0, 0, 0, 12, 4, 8],
  "-": [0, 0, 0, 31, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0, 14],
  "/": [1, 2, 4, 8, 16, 0, 0],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  ":": [0, 12, 0, 0, 12, 0, 0],
  ";": [0, 12, 0, 0, 0, 0, 12, 4, 8],
  "<": [2, 4, 8, 16, 8, 4, 2],
  "=": [0, 0, 31, 0, 31, 0, 0],
  ">": [8, 4, 2, 1, 2, 4, 8],
  "?": [14, 17, 1, 2, 4, 0, 4],
  "@": [14, 17, 23, 21, 23, 16, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 30, 17, 17, 17, 30],
  c: [0, 0, 14, 17, 16, 17, 14],
  d: [1, 1, 15, 17, 17, 17, 15],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 9, 8, 28, 8, 8, 8],
  g: [0, 0, 15, 17, 17, 15, 1, 17, 14],
  h: [16, 16, 30, 17, 17, 17, 17],
  i: [4, 0, 12, 4, 4, 4, 14],
  j: [4, 0, 4, 4, 4, 4, 4, 20, 12],
  k: [16, 16, 18, 20, 24, 20, 18],
  l: [12, 4, 4, 4, 4, 4, 14],
  m: [0, 0, 26, 21, 21, 21, 21],
  n: [0, 0, 30, 17, 17, 17, 17],
  o: [0, 0, 14, 17, 17, 17, 14],
  p: [0, 0, 30, 17, 17, 30, 16, 16, 16],
  q: [0, 0, 15, 17, 17, 15, 1, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16],
  s: [0, 0, 15, 16, 14, 1, 30],
  t: [8, 8, 28, 8, 8, 9, 6],
  u: [0, 0, 17, 17, 17, 19, 13],
  v: [0, 0, 17, 17, 17, 10, 4],
  w: [0, 0, 17, 17, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 0, 17, 17, 17, 15, 1, 17, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
  "[": [14, 8, 8, 8, 8, 8, 14],
  "\\": [16, 8, 4, 2, 1, 0, 0],
  "]": [14, 2, 2, 2, 2, 2, 14],
  "^": [4, 10, 17, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  "`": [8, 4, 0, 0, 0, 0, 0],
  "{": [2, 4, 4, 8, 4, 4, 2],
  "|": [4, 4, 4, 4, 4, 4, 4],
  "}": [8, 4, 4, 2, 4, 4, 8],
  "~": [0, 0, 13, 22, 0, 0, 0],
  "·": [0, 0, 0, 4, 0, 0, 0],
  "•": [0, 0, 14, 14, 14, 0, 0],
  "●": [0, 14, 31, 31, 31, 14, 0],
  "○": [0, 14, 17, 17, 17, 14, 0],
  "◆": [4, 14, 31, 14, 4, 0, 0],
  "◇": [4, 10, 17, 10, 4, 0, 0],
  "…": [0, 0, 0, 0, 0, 0, 21],
  "—": [0, 0, 0, 31, 0, 0, 0],
  "–": [0, 0, 0, 14, 0, 0, 0],
  "✓": [0, 0, 1, 2, 20, 8, 0],
  "✕": [0, 17, 10, 4, 10, 17, 0],
  "▌": [24, 24, 24, 24, 24, 24, 24],
  "▶": [16, 24, 28, 30, 28, 24, 16],
  "◀": [1, 3, 7, 15, 7, 3, 1],
  "▲": [4, 14, 14, 31, 31, 0, 0],
  "▼": [0, 0, 31, 31, 14, 14, 4],
  "■": [0, 31, 31, 31, 31, 31, 0],
  "📁": [14, 31, 17, 31, 31, 31, 0],
  "📄": [14, 25, 31, 23, 23, 31, 0],
  "⚙": [10, 14, 31, 17, 31, 14, 10],
  "📊": [1, 1, 9, 9, 25, 25, 31],
  "🌐": [14, 21, 27, 31, 27, 21, 14],
  "💾": [30, 18, 31, 31, 21, 31, 0],
  "🗑": [14, 31, 17, 21, 21, 17, 14],
  "⚡": [6, 12, 24, 31, 3, 6, 12],
  "🔍": [14, 17, 17, 14, 2, 1, 0],
  "➕": [0, 4, 4, 31, 4, 4, 0],
  "−": [0, 0, 0, 31, 0, 0, 0],
  "↑": [4, 14, 21, 4, 4, 4, 0],
  "↓": [4, 4, 4, 21, 14, 4, 0],
  "←": [0, 4, 8, 31, 8, 4, 0],
  "→": [0, 4, 2, 31, 2, 4, 0],
  "📝": [14, 31, 19, 23, 27, 31, 0],
  "🎨": [14, 31, 27, 17, 25, 14, 0],
  "📦": [14, 31, 21, 31, 21, 31, 14],
  "💻": [31, 17, 17, 17, 31, 31, 14],
  "🏠": [4, 14, 31, 27, 27, 27, 0],
  "📖": [14, 27, 27, 31, 27, 27, 0],
  "🖼": [31, 17, 21, 25, 17, 31, 0],
  "🛠": [10, 14, 4, 4, 4, 14, 10],
  "🚀": [4, 14, 14, 31, 21, 17, 10],
  "⟳": [14, 17, 25, 29, 1, 17, 14],
  "↻": [14, 17, 25, 29, 1, 17, 14],
});

function getCharacterAdvance(character: string, scale: number): number {
  const fontSize = scale * 7;
  return getNativeCharacterAdvance(character, fontSize);
}

function resolveWindowBadge(title: string): string {
  const lower = title.toLocaleLowerCase();
  if (lower.includes("studio") || lower.includes("ide")) return "</>";
  if (lower.includes("console") || lower.includes("terminal")) return ">_";
  if (lower.includes("browser") || lower.includes("web")) return "WB";
  if (lower.includes("file")) return "FL";
  if (lower.includes("setting")) return "⚙";
  if (lower.includes("monitor")) return "SM";
  if (lower.includes("note")) return "NT";
  if (lower.includes("gallery")) return "UI";
  return title.charAt(0) || "•";
}
