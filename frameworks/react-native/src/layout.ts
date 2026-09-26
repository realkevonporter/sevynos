import type {
  AccessibilityNode,
  Dimension,
  NativeBounds,
  NativeChild,
  NativeEdges,
  NativeHostNode,
  NativeRuntimeSnapshot,
  NativeStyle,
} from "./native-types.js";
import type { NativeInteractionState, NativeRenderCommand } from "./surface.js";
import { resolveSevynColors, sevynTokens, type SevynAppearance } from "./tokens.js";
import { computeYogaLayout } from "./yoga-engine.js";
import {
  measureNativeText,
  measureTextWidth,
  wrapTextToLines,
  getCharacterAdvance,
  clearFontMetricsCache,
  DEJAVU_SANS_GLYPH_RATIOS,
  type TextMeasurementOptions,
  type MeasuredTextResult,
} from "./font-metrics.js";

export {
  measureNativeText,
  measureTextWidth,
  wrapTextToLines,
  getCharacterAdvance,
  clearFontMetricsCache,
  DEJAVU_SANS_GLYPH_RATIOS,
  type TextMeasurementOptions,
  type MeasuredTextResult,
};

interface LayoutContext {
  readonly appearance: SevynAppearance;
  readonly accent: string;
  readonly reducedMotion: boolean;
  readonly focusId?: string;
  readonly pressedId?: string;
  readonly hoveredId?: string;
  readonly changed: Set<string>;
  readonly boundsById: Map<string, NativeBounds>;
  readonly commandCache: Map<string, NativeRenderCommand>;
}
interface LayoutResult {
  readonly commands: NativeRenderCommand[];
  readonly accessibility: AccessibilityNode[];
  readonly overlays: string[];
}
const dimension = (
  value: Dimension | undefined,
  available: number,
): number | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "string"
      ? (available * Number.parseFloat(value)) / 100
      : undefined;
function edges(
  value: number | NativeEdges | undefined,
): Required<Pick<NativeEdges, "top" | "right" | "bottom" | "left">> {
  if (typeof value === "number")
    return { top: value, right: value, bottom: value, left: value };
  const all = value?.all ?? 0;
  return {
    top: value?.top ?? value?.vertical ?? all,
    right: value?.right ?? value?.horizontal ?? all,
    bottom: value?.bottom ?? value?.vertical ?? all,
    left: value?.left ?? value?.horizontal ?? all,
  };
}

function resolvePadding(
  style: NativeStyle,
): Required<Pick<NativeEdges, "top" | "right" | "bottom" | "left">> {
  const base = edges(style.padding);
  return {
    top: style.paddingTop ?? style.paddingVertical ?? base.top,
    right: style.paddingRight ?? style.paddingHorizontal ?? base.right,
    bottom: style.paddingBottom ?? style.paddingVertical ?? base.bottom,
    left: style.paddingLeft ?? style.paddingHorizontal ?? base.left,
  };
}

function resolveMargin(
  style: NativeStyle,
): Required<Pick<NativeEdges, "top" | "right" | "bottom" | "left">> {
  const base = edges(style.margin);
  return {
    top: style.marginTop ?? style.marginVertical ?? base.top,
    right: style.marginRight ?? style.marginHorizontal ?? base.right,
    bottom: style.marginBottom ?? style.marginVertical ?? base.bottom,
    left: style.marginLeft ?? style.marginHorizontal ?? base.left,
  };
}

function resolveDirection(style: NativeStyle): "row" | "column" {
  if (
    style.direction === "row" ||
    style.flexDirection === "row" ||
    style.flexDirection === "row-reverse"
  )
    return "row";
  return "column";
}

function resolveRadius(style: NativeStyle, defaultRadius: number): number {
  return style.radius ?? style.borderRadius ?? defaultRadius;
}

function resolveFlexGrow(style: NativeStyle): number {
  if (style.flexGrow !== undefined) return style.flexGrow;
  if (typeof style.flex === "number" && style.flex > 0) return style.flex;
  return 0;
}

function resolveFontWeight(
  weight: number | string | undefined,
  defaultWeight: number,
): number {
  if (typeof weight === "number") return weight;
  if (typeof weight === "string") {
    if (weight === "bold") return 700;
    if (weight === "normal") return 400;
    const parsed = Number.parseInt(weight, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return defaultWeight;
}
function constrained(
  value: number,
  min: number | undefined,
  max: number | undefined,
): number {
  return Math.max(min ?? 0, Math.min(max ?? Number.POSITIVE_INFINITY, value));
}
function textOf(node: NativeHostNode): string {
  return (
    node.props.text ??
    node.children
      .map((child) => (child.kind === "raw-text" ? child.text : textOf(child)))
      .join("")
  );
}
function command(
  context: LayoutContext,
  value: NativeRenderCommand,
): NativeRenderCommand {
  const signature = JSON.stringify(value);
  const cached = context.commandCache.get(signature);
  if (cached !== undefined) return cached;
  context.commandCache.set(signature, value);
  return value;
}

export function layoutNativeTree(options: {
  readonly roots: readonly NativeChild[];
  readonly bounds: NativeBounds;
  readonly appearance: SevynAppearance;
  readonly accent: string;
  readonly reducedMotion: boolean;
  readonly revision: number;
  readonly changedNodeIds: readonly string[];
  readonly focusId?: string;
  readonly pressedId?: string;
  readonly hoveredId?: string;
  readonly commandCache?: Map<string, NativeRenderCommand>;
}): {
  readonly snapshot: NativeRuntimeSnapshot;
  readonly boundsById: ReadonlyMap<string, NativeBounds>;
  readonly commandCache: Map<string, NativeRenderCommand>;
} {
  const context: LayoutContext = {
    appearance: options.appearance,
    accent: options.accent,
    reducedMotion: options.reducedMotion,
    ...(options.focusId === undefined ? {} : { focusId: options.focusId }),
    ...(options.pressedId === undefined ? {} : { pressedId: options.pressedId }),
    ...(options.hoveredId === undefined ? {} : { hoveredId: options.hoveredId }),
    changed: new Set(options.changedNodeIds),
    boundsById: new Map(),
    commandCache: options.commandCache ?? new Map<string, NativeRenderCommand>(),
  };
  const result: LayoutResult = { commands: [], accessibility: [], overlays: [] };
  const visibleRoots = options.roots.filter((node) => !node.hidden);
  visibleRoots.forEach((node) => {
    layoutChild(node, options.bounds, context, result, 0);
  });
  const snapshot: NativeRuntimeSnapshot = Object.freeze({
    revision: options.revision,
    commands: Object.freeze(result.commands),
    accessibility: Object.freeze(result.accessibility),
    ...(options.focusId === undefined ? {} : { focusId: options.focusId }),
    overlays: Object.freeze(result.overlays),
    changedNodeIds: Object.freeze([...options.changedNodeIds]),
  });
  return { snapshot, boundsById: context.boundsById, commandCache: context.commandCache };
}

function layoutChild(
  child: NativeChild,
  bounds: NativeBounds,
  context: LayoutContext,
  output: LayoutResult,
  focusOrder: number,
  resolvedByParent = false,
): void {
  if (child.hidden) return;
  if (child.kind === "raw-text") return;
  const style =
    child.props.breakpoint !== undefined && bounds.width <= child.props.breakpoint.compact
      ? { ...child.props.style, ...child.props.breakpoint.compactStyle }
      : (child.props.style ?? {});
  const margin = resolveMargin(style);
  const padded = resolvePadding(style);
  const width = resolvedByParent
    ? bounds.width
    : constrained(
        dimension(style.width, bounds.width) ??
          (child.type === "text"
            ? bounds.width
            : Math.max(0, bounds.width - margin.left - margin.right)),
        style.minWidth,
        style.maxWidth,
      );
  const minHeight = child.type === "text" ? 0 : 24;
  const height = resolvedByParent
    ? bounds.height
    : constrained(
        dimension(style.height, bounds.height) ??
          (child.type === "text"
            ? bounds.height
            : Math.max(minHeight, bounds.height - margin.top - margin.bottom)),
        style.minHeight,
        style.maxHeight,
      );
  const x =
    style.position === "absolute"
      ? bounds.x +
        (style.left ??
          (style.right === undefined ? 0 : bounds.width - width - style.right))
      : bounds.x + (resolvedByParent ? 0 : margin.left);
  const y =
    style.position === "absolute"
      ? bounds.y +
        (style.top ??
          (style.bottom === undefined ? 0 : bounds.height - height - style.bottom))
      : bounds.y + (resolvedByParent ? 0 : margin.top);
  let transformTranslateX = style.translateX ?? 0;
  let transformTranslateY = style.translateY ?? 0;
  let transformScaleX = style.scale ?? 1;
  let transformScaleY = style.scale ?? 1;
  for (const operation of style.transform ?? []) {
    if (typeof operation["translateX"] === "number")
      transformTranslateX += operation["translateX"];
    if (typeof operation["translateY"] === "number")
      transformTranslateY += operation["translateY"];
    if (typeof operation["scale"] === "number") {
      transformScaleX *= operation["scale"];
      transformScaleY *= operation["scale"];
    }
    if (typeof operation["scaleX"] === "number") transformScaleX *= operation["scaleX"];
    if (typeof operation["scaleY"] === "number") transformScaleY *= operation["scaleY"];
  }
  const own = Object.freeze({
    x: x + transformTranslateX,
    y: y + transformTranslateY,
    width: width * transformScaleX,
    height: height * transformScaleY,
  });
  context.boundsById.set(child.id, own);
  paintNode(child, own, style, context, output);
  const role = child.props.role;
  const accessibilityChildren: AccessibilityNode[] = [];
  const childOutput: LayoutResult = {
    commands: output.commands,
    accessibility: accessibilityChildren,
    overlays: output.overlays,
  };
  const content: NativeBounds = {
    x: own.x + padded.left,
    y: own.y + padded.top - (style.scrollOffset ?? 0),
    width: Math.max(0, own.width - padded.left - padded.right),
    height: Math.max(0, own.height - padded.top - padded.bottom),
  };
  const isScroll = style.overflow === "scroll" || child.type === "scroll";
  const clipped = style.overflow === "hidden" || isScroll;
  if (clipped)
    output.commands.push(
      command(
        context,
        Object.freeze({ kind: "clip-start", id: `${child.id}.clip`, bounds: own }),
      ),
    );
  layoutChildren(child, content, style, context, childOutput, focusOrder + 1);
  if (clipped)
    output.commands.push(
      command(
        context,
        Object.freeze({ kind: "clip-end", id: `${child.id}.clip-end`, bounds: own }),
      ),
    );
  if (isScroll && child.props.showsVerticalScrollIndicator !== false) {
    let maxBottom = content.y;
    for (const c of child.children) {
      if (c.kind === "host") {
        const b = context.boundsById.get(c.id);
        if (b !== undefined) {
          maxBottom = Math.max(maxBottom, b.y + b.height);
        }
      }
    }
    const scrollOffset = Math.max(0, style.scrollOffset ?? 0);
    const contentTop = own.y + padded.top - scrollOffset;
    const contentHeight = Math.max(content.height, maxBottom - contentTop);
    const visibleHeight = content.height;

    if (contentHeight > visibleHeight + 4) {
      const trackPadding = 4;
      const trackHeight = Math.max(16, own.height - trackPadding * 2);
      const thumbHeight = Math.max(
        18,
        Math.min(trackHeight, Math.round(trackHeight * (visibleHeight / contentHeight))),
      );
      const maxScroll = Math.max(1, contentHeight - visibleHeight);
      const progress = Math.min(1, Math.max(0, scrollOffset / maxScroll));
      const thumbY = Math.round(
        own.y + trackPadding + progress * (trackHeight - thumbHeight),
      );
      const thumbX = Math.round(own.x + own.width - 6);
      const thumbColor =
        context.appearance === "light"
          ? "rgba(0, 0, 0, 0.28)"
          : "rgba(255, 255, 255, 0.32)";

      output.commands.push(
        command(
          context,
          Object.freeze({
            kind: "material",
            id: `${child.id}.scrollbar-thumb`,
            bounds: Object.freeze({
              x: thumbX,
              y: thumbY,
              width: 4,
              height: thumbHeight,
            }),
            color: thumbColor,
            radius: 2,
          }),
        ),
      );
    }
  }
  const label = child.props.label ?? (child.type === "text" ? textOf(child) : "");
  if (role !== undefined)
    output.accessibility.push(
      Object.freeze({
        id: child.id,
        role,
        label,
        ...(child.props.description === undefined
          ? {}
          : { description: child.props.description }),
        disabled: child.props.disabled ?? false,
        selected: child.props.selected ?? false,
        ...(child.props.checked === undefined && child.props.defaultChecked === undefined
          ? {}
          : { checked: child.props.checked ?? child.props.defaultChecked ?? false }),
        focusOrder: child.props.focusOrder ?? focusOrder,
        bounds: own,
        children: Object.freeze(accessibilityChildren),
      }),
    );
  else output.accessibility.push(...accessibilityChildren);
  if (child.type === "overlay") output.overlays.push(child.id);
  child.dirty = false;
}

function intrinsicMainSize(
  child: NativeHostNode,
  direction: "row" | "column",
  grow: number,
): number | undefined {
  if (direction !== "row" || grow === 0) return undefined;
  if (
    (child.props.style?.flexGrow !== undefined && child.props.style.flexGrow > 0) ||
    (typeof child.props.style?.flex === "number" && child.props.style.flex > 0)
  ) {
    return undefined;
  }
  if (child.props.style?.width !== undefined) return undefined;
  const label =
    child.props.label ??
    (child.type === "text" || child.props.role === "button" ? textOf(child) : undefined);
  if (label !== undefined && label.length > 0) {
    return Math.max(36, Math.round(label.length * 8 + 24));
  }
  return undefined;
}

function layoutChildren(
  parent: NativeHostNode,
  content: NativeBounds,
  style: NativeStyle,
  context: LayoutContext,
  output: LayoutResult,
  focusOrder: number,
): void {
  const children = parent.children.filter(
    (child): child is NativeHostNode => !child.hidden && child.kind === "host",
  );
  const relative = children.filter((child) => child.props.style?.position !== "absolute");
  const absolute = children.filter((child) => child.props.style?.position === "absolute");

  // Compute layout with Meta's Yoga engine
  try {
    const yogaBounds = computeYogaLayout(parent, content, style, relative);
    if (yogaBounds.size === relative.length && relative.length > 0) {
      relative.forEach((child, index) => {
        const childBounds = yogaBounds.get(child.id);
        if (childBounds === undefined) {
          throw new Error(`Missing Yoga bounds for child ${child.id}`);
        }
        layoutChild(child, childBounds, context, output, focusOrder + index, true);
      });
      absolute.forEach((child, index) => {
        layoutChild(
          child,
          content,
          context,
          output,
          focusOrder + relative.length + index,
        );
      });
      return;
    }
  } catch {
    // Fallback to in-tree flex calculation below
  }

  const direction = resolveDirection(style);
  const gap = style.gap ?? 0;
  const mainAvailable = direction === "row" ? content.width : content.height;
  const grow = relative.reduce(
    (total, child) => total + resolveFlexGrow(child.props.style ?? {}),
    0,
  );
  const fixed =
    relative.reduce(
      (total, child) =>
        total +
        (dimension(
          direction === "row" ? child.props.style?.width : child.props.style?.height,
          mainAvailable,
        ) ??
          intrinsicMainSize(child, direction, grow) ??
          0),
      0,
    ) +
    Math.max(0, relative.length - 1) * gap;
  let cursor = direction === "row" ? content.x : content.y;
  relative.forEach((child, index) => {
    const requested =
      dimension(
        direction === "row" ? child.props.style?.width : child.props.style?.height,
        mainAvailable,
      ) ?? intrinsicMainSize(child, direction, grow);
    const childGrow = resolveFlexGrow(child.props.style ?? {});
    const main =
      requested ??
      (grow > 0
        ? (Math.max(0, mainAvailable - fixed) * childGrow) / grow
        : Math.max(0, mainAvailable - fixed) / Math.max(1, relative.length));
    const childBounds =
      direction === "row"
        ? { x: cursor, y: content.y, width: main, height: content.height }
        : { x: content.x, y: cursor, width: content.width, height: main };
    layoutChild(child, childBounds, context, output, focusOrder + index);
    cursor += main + gap;
  });
  absolute.forEach((child, index) => {
    layoutChild(child, content, context, output, focusOrder + relative.length + index);
  });
}

const DROPPED_STYLE_PROPS = ["zIndex", "textDecorationLine"] as const;

const warnedDroppedProps = new Set<string>();

export function resetDroppedPropWarnings(): void {
  warnedDroppedProps.clear();
}

function formatComponentName(node: NativeHostNode): string {
  const role = node.props.accessibilityRole ?? node.props.role;
  const label = node.props.accessibilityLabel ?? node.props.label;
  if (role !== undefined && label !== undefined) {
    return `<${node.type} role="${role}"> ("${label}", id: ${node.id})`;
  }
  if (role !== undefined) {
    return `<${node.type} role="${role}"> (id: ${node.id})`;
  }
  if (label !== undefined) {
    return `<${node.type}> ("${label}", id: ${node.id})`;
  }
  return `<${node.type}> (id: ${node.id})`;
}

function warnDroppedStyleProps(node: NativeHostNode, style: NativeStyle): void {
  if (typeof process !== "undefined" && process.env["NODE_ENV"] === "production") {
    return;
  }

  for (const prop of DROPPED_STYLE_PROPS) {
    const value = (style as Record<string, unknown>)[prop];
    if (value !== undefined) {
      const key = `${node.id}:${prop}`;
      if (!warnedDroppedProps.has(key)) {
        warnedDroppedProps.add(key);
        console.warn(
          `[SevynOS RN Dev] Style prop "${prop}" on component ${formatComponentName(node)} was dropped and is not supported by the render command protocol.`,
        );
      }
    }
  }
}

function paintNode(
  node: NativeHostNode,
  bounds: NativeBounds,
  style: NativeStyle,
  context: LayoutContext,
  output: LayoutResult,
): void {
  warnDroppedStyleProps(node, style);
  const colors = resolveSevynColors(context.appearance, context.accent);

  const radii: import("./surface.js").NativeCornerRadii | undefined =
    style.borderTopLeftRadius !== undefined ||
    style.borderTopRightRadius !== undefined ||
    style.borderBottomLeftRadius !== undefined ||
    style.borderBottomRightRadius !== undefined ||
    style.borderStartStartRadius !== undefined ||
    style.borderStartEndRadius !== undefined ||
    style.borderEndStartRadius !== undefined ||
    style.borderEndEndRadius !== undefined
      ? {
          ...(style.borderTopLeftRadius !== undefined ||
          style.borderStartStartRadius !== undefined
            ? { topLeft: style.borderTopLeftRadius ?? style.borderStartStartRadius }
            : {}),
          ...(style.borderTopRightRadius !== undefined ||
          style.borderStartEndRadius !== undefined
            ? { topRight: style.borderTopRightRadius ?? style.borderStartEndRadius }
            : {}),
          ...(style.borderBottomLeftRadius !== undefined ||
          style.borderEndStartRadius !== undefined
            ? { bottomLeft: style.borderBottomLeftRadius ?? style.borderEndStartRadius }
            : {}),
          ...(style.borderBottomRightRadius !== undefined ||
          style.borderEndEndRadius !== undefined
            ? { bottomRight: style.borderBottomRightRadius ?? style.borderEndEndRadius }
            : {}),
        }
      : undefined;

  const borderColor =
    style.borderColor ??
    style.borderTopColor ??
    style.borderRightColor ??
    style.borderBottomColor ??
    style.borderLeftColor;
  const borderWidth =
    style.borderWidth ??
    style.borderTopWidth ??
    style.borderRightWidth ??
    style.borderBottomWidth ??
    style.borderLeftWidth;
  const borderStyle = style.borderStyle;

  let shadow: import("./surface.js").NativeShadow | undefined;
  if (
    style.shadowColor !== undefined ||
    style.shadowOffset !== undefined ||
    style.shadowOpacity !== undefined ||
    style.shadowRadius !== undefined ||
    style.elevation !== undefined
  ) {
    const shadowColor =
      style.shadowColor ??
      (style.elevation !== undefined ? "rgba(0, 0, 0, 0.45)" : "black");
    const shadowBlur = style.shadowRadius ?? (style.elevation ?? 0) * 2;
    const shadowY = style.shadowOffset?.height ?? style.elevation ?? 0;
    const shadowX = style.shadowOffset?.width ?? 0;
    const shadowOpacity = style.shadowOpacity ?? 1;
    shadow = {
      color: shadowColor,
      blur: shadowBlur,
      y: shadowY,
      x: shadowX,
      opacity: shadowOpacity,
    };
  }

  if (
    node.type !== "text" &&
    node.type !== "icon" &&
    node.type !== "button" &&
    (style.backgroundColor !== undefined ||
      style.borderRadius !== undefined ||
      style.radius !== undefined ||
      style.borderWidth !== undefined ||
      style.borderColor !== undefined ||
      node.type !== "view")
  )
    output.commands.push(
      command(
        context,
        Object.freeze({
          kind: "material",
          id: `${node.id}.background`,
          bounds,
          color:
            style.backgroundColor ??
            (node.type === "overlay" ? colors.materialStrong : colors.material),
          radius: resolveRadius(style, sevynTokens.radius.sm),
          ...(radii === undefined ? {} : { radii }),
          ...(borderColor === undefined ? {} : { borderColor }),
          ...(borderWidth === undefined ? {} : { borderWidth }),
          ...(borderStyle === undefined ? {} : { borderStyle }),
          ...(shadow === undefined ? {} : { shadow }),
          ...(node.type === "overlay"
            ? { backdropBlur: sevynTokens.material.strong.blur }
            : {}),
          ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
        }),
      ),
    );
  if (node.type === "text") {
    const text = textOf(node);
    const textAlign =
      style.textAlign === "center"
        ? "center"
        : style.textAlign === "right"
          ? "end"
          : style.textAlign === "left"
            ? "start"
            : undefined;
    const fontSize = style.fontSize ?? sevynTokens.typography.body.size;
    const weight = resolveFontWeight(
      style.fontWeight,
      sevynTokens.typography.body.weight,
    );
    const measured = measureNativeText(text, fontSize, bounds.width, {
      weight,
      letterSpacing: style.letterSpacing,
      fontFamily: style.fontFamily,
      lineHeight: style.lineHeight,
    });
    output.commands.push(
      command(
        context,
        Object.freeze({
          kind: "text",
          id: `${node.id}.text`,
          bounds,
          text,
          lines: measured.lines,
          measuredWidth: measured.width,
          measuredHeight: measured.height,
          color: style.color ?? colors.text,
          size: fontSize,
          weight,
          ...(textAlign === undefined ? {} : { align: textAlign }),
          ...(style.lineHeight === undefined ? {} : { lineHeight: style.lineHeight }),
          ...(style.letterSpacing === undefined
            ? {}
            : { letterSpacing: style.letterSpacing }),
          ...(style.fontFamily === undefined ? {} : { fontFamily: style.fontFamily }),
          ...(style.fontStyle === undefined ? {} : { fontStyle: style.fontStyle }),
          ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
          ...(style.wrap === undefined ? {} : { wrap: style.wrap }),
        }),
      ),
    );
  }
  if (node.type === "input") {
    const inset = 10;
    const inputText = node.props.secureTextEntry
      ? "•".repeat(String(node.props.value ?? node.props.defaultValue ?? "").length)
      : String(node.props.value ?? node.props.defaultValue ?? "");
    const fontSize = style.fontSize ?? sevynTokens.typography.body.size;
    const rawSelection = node.props.selection ?? {
      start: inputText.length,
      end: inputText.length,
    };
    const selectionStart = Math.max(0, Math.min(inputText.length, rawSelection.start));
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(inputText.length, rawSelection.end),
    );
    const inputBounds = {
      x: bounds.x + inset,
      y: bounds.y + 4,
      width: Math.max(0, bounds.width - inset * 2),
      height: Math.max(0, bounds.height - 8),
    };
    if (inputText.length > 0) {
      if (selectionEnd > selectionStart && context.focusId === node.id) {
        const beforeWidth = measureNativeText(
          inputText.slice(0, selectionStart),
          fontSize,
        ).width;
        const selectionWidth = Math.max(
          2,
          measureNativeText(inputText.slice(selectionStart, selectionEnd), fontSize)
            .width,
        );
        output.commands.push(
          command(
            context,
            Object.freeze({
              kind: "material",
              id: `${node.id}.selection`,
              bounds: {
                x: bounds.x + inset + beforeWidth,
                y: inputBounds.y,
                width: Math.min(
                  selectionWidth,
                  Math.max(0, inputBounds.width - beforeWidth),
                ),
                height: inputBounds.height,
              },
              color: node.props.selectionColor ?? "rgba(215, 172, 87, 0.38)",
              radius: 2,
              ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
            }),
          ),
        );
      }
      output.commands.push(
        command(
          context,
          Object.freeze({
            kind: "text",
            id: `${node.id}.value`,
            bounds: inputBounds,
            text: inputText,
            color: style.color ?? colors.text,
            size: fontSize,
            weight: resolveFontWeight(
              style.fontWeight,
              sevynTokens.typography.body.weight,
            ),
            ...(style.lineHeight === undefined ? {} : { lineHeight: style.lineHeight }),
            ...(style.letterSpacing === undefined
              ? {}
              : { letterSpacing: style.letterSpacing }),
            ...(style.fontFamily === undefined ? {} : { fontFamily: style.fontFamily }),
            ...(style.fontStyle === undefined ? {} : { fontStyle: style.fontStyle }),
            ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
          }),
        ),
      );
    } else if (node.props.placeholder !== undefined) {
      output.commands.push(
        command(
          context,
          Object.freeze({
            kind: "text",
            id: `${node.id}.placeholder`,
            bounds: inputBounds,
            text: node.props.placeholder,
            color: node.props.placeholderTextColor ?? colors.textMuted,
            size: fontSize,
            weight: resolveFontWeight(
              style.fontWeight,
              sevynTokens.typography.body.weight,
            ),
            ...(style.lineHeight === undefined ? {} : { lineHeight: style.lineHeight }),
            ...(style.letterSpacing === undefined
              ? {}
              : { letterSpacing: style.letterSpacing }),
            ...(style.fontFamily === undefined ? {} : { fontFamily: style.fontFamily }),
            ...(style.fontStyle === undefined ? {} : { fontStyle: style.fontStyle }),
            ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
          }),
        ),
      );
    }
    // Blinking caret when input is focused
    if (
      (context.focusId === node.id || node.props.interactionState === "focused") &&
      node.props.caretHidden !== true
    ) {
      const caretX =
        bounds.x +
        inset +
        measureNativeText(inputText.slice(0, selectionEnd), fontSize).width;
      const caretHeight = Math.round(fontSize * 1.2);
      const caretY = bounds.y + Math.round((bounds.height - caretHeight) / 2);
      output.commands.push(
        command(
          context,
          Object.freeze({
            kind: "material",
            id: `${node.id}.caret`,
            bounds: {
              x: Math.min(caretX, bounds.x + bounds.width - inset - 2),
              y: caretY,
              width: 2,
              height: caretHeight,
            },
            color: colors.accent,
            radius: 1,
            // The compositor toggles this command on the caret blink phase
            // grid; see caretBlinkPhase in the Linux software frame renderer.
            blink: true,
            ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
          }),
        ),
      );
    }
  }
  if (node.type === "image" && node.props.source !== undefined)
    output.commands.push(
      command(
        context,
        Object.freeze({
          kind: "bitmap",
          id: `${node.id}.bitmap`,
          bounds,
          width: node.props.source.width,
          height: node.props.source.height,
          pixels: node.props.source.pixels,
          ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
        }),
      ),
    );
  if (node.type === "icon" && node.props.icon !== undefined)
    output.commands.push(
      command(
        context,
        Object.freeze({
          kind: "icon",
          id: `${node.id}.icon`,
          bounds,
          icon: node.props.icon,
          color: style.color ?? colors.textSecondary,
          ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
        }),
      ),
    );
  if (
    node.type === "button" ||
    ((node.type === "toggle" ||
      node.type === "slider" ||
      node.type === "segment" ||
      node.type === "select" ||
      node.type === "input") &&
      node.props.action !== undefined)
  ) {
    const isPressed = context.pressedId === node.id;
    const isHovered = context.hoveredId === node.id;
    const isFocused = context.focusId === node.id;
    const interactionState: NativeInteractionState = node.props.disabled
      ? "disabled"
      : isPressed
        ? "pressed"
        : isHovered
          ? "hovered"
          : isFocused
            ? "focused"
            : (node.props.interactionState ?? "idle");

    const active = interactionState === "focused" || interactionState === "pressed";
    const bg = style.backgroundColor ?? (active ? colors.accent : colors.surfaceRaised);
    const fg = style.color ?? (active ? "#19140a" : colors.text);
    const accent = style.borderColor ?? colors.accent;
    const radius = resolveRadius(style, sevynTokens.radius.sm);
    const value =
      typeof node.props.value === "string"
        ? node.props.value
        : node.props.defaultValue !== undefined
          ? String(node.props.defaultValue)
          : node.children.length === 0 &&
              typeof node.props.label === "string" &&
              node.props.label !== node.id
            ? node.props.label
            : "";

    output.commands.push(
      command(
        context,
        Object.freeze({
          kind: "control",
          id: `${node.id}.control`,
          bounds,
          action: node.props.action ?? "custom",
          label: typeof node.props.label === "string" ? node.props.label : node.id,
          value,
          state: interactionState,
          accent,
          foreground: fg,
          background: bg,
          radius,
          ...(style.borderWidth === undefined ? {} : { borderWidth: style.borderWidth }),
          ...(style.borderColor === undefined ? {} : { borderColor: style.borderColor }),
          ...(shadow === undefined ? {} : { shadow }),
          ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
        }),
      ),
    );
  }
}
