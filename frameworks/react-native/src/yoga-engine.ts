import Yoga, {
  FlexDirection,
  Justify,
  Align,
  Gutter,
  Edge,
  Direction,
  MeasureMode,
  Wrap,
} from "yoga-layout";
import type { NativeBounds, NativeHostNode, NativeStyle } from "./native-types.js";
import { measureNativeText } from "./font-metrics.js";
import { sevynTokens } from "./tokens.js";

function extractTextContent(node: NativeHostNode): string {
  if (typeof node.props.text === "string") return node.props.text;
  if (typeof node.props.value === "string") return node.props.value;
  if (typeof node.props.label === "string") return node.props.label;
  return node.children
    .map((child) => (child.kind === "raw-text" ? child.text : extractTextContent(child)))
    .join("");
}

function applyStylesToYogaNode(
  nodeYoga: ReturnType<typeof Yoga.Node.create>,
  style: NativeStyle,
  isScrollChild: boolean,
  includeSpacing = true,
): void {
  // Flex direction
  if (style.flexDirection === "row" || style.direction === "row") {
    nodeYoga.setFlexDirection(FlexDirection.Row);
  } else if (style.flexDirection === "row-reverse") {
    nodeYoga.setFlexDirection(FlexDirection.RowReverse);
  } else if (style.flexDirection === "column-reverse") {
    nodeYoga.setFlexDirection(FlexDirection.ColumnReverse);
  } else {
    nodeYoga.setFlexDirection(FlexDirection.Column);
  }

  // JustifyContent
  if (style.justifyContent === "center") nodeYoga.setJustifyContent(Justify.Center);
  else if (style.justifyContent === "flex-end")
    nodeYoga.setJustifyContent(Justify.FlexEnd);
  else if (style.justifyContent === "space-between")
    nodeYoga.setJustifyContent(Justify.SpaceBetween);
  else if (style.justifyContent === "space-around")
    nodeYoga.setJustifyContent(Justify.SpaceAround);
  else if (style.justifyContent === "space-evenly")
    nodeYoga.setJustifyContent(Justify.SpaceEvenly);
  else nodeYoga.setJustifyContent(Justify.FlexStart);

  // AlignItems
  if (style.alignItems === "center") nodeYoga.setAlignItems(Align.Center);
  else if (style.alignItems === "flex-start") nodeYoga.setAlignItems(Align.FlexStart);
  else if (style.alignItems === "flex-end") nodeYoga.setAlignItems(Align.FlexEnd);
  else if (style.alignItems === "stretch") nodeYoga.setAlignItems(Align.Stretch);
  else if (style.alignItems === "baseline") nodeYoga.setAlignItems(Align.Baseline);
  else nodeYoga.setAlignItems(Align.Stretch);

  if (style.flexWrap === "wrap") nodeYoga.setFlexWrap(Wrap.Wrap);
  else if (style.flexWrap === "wrap-reverse") nodeYoga.setFlexWrap(Wrap.WrapReverse);
  else nodeYoga.setFlexWrap(Wrap.NoWrap);

  // Gap
  if (typeof style.gap === "number" && style.gap > 0) {
    nodeYoga.setGap(Gutter.All, style.gap);
  }
  if (typeof style.rowGap === "number" && style.rowGap > 0) {
    nodeYoga.setGap(Gutter.Row, style.rowGap);
  }
  if (typeof style.columnGap === "number" && style.columnGap > 0) {
    nodeYoga.setGap(Gutter.Column, style.columnGap);
  }

  // Width
  if (typeof style.width === "number") {
    nodeYoga.setWidth(style.width);
  } else if (typeof style.width === "string" && style.width.endsWith("%")) {
    nodeYoga.setWidthPercent(parseFloat(style.width));
  }
  if (typeof style.minWidth === "number") nodeYoga.setMinWidth(style.minWidth);
  if (typeof style.maxWidth === "number") nodeYoga.setMaxWidth(style.maxWidth);

  // Height
  if (typeof style.height === "number") {
    nodeYoga.setHeight(style.height);
  } else if (typeof style.height === "string" && style.height.endsWith("%")) {
    nodeYoga.setHeightPercent(parseFloat(style.height));
  }
  if (typeof style.minHeight === "number") nodeYoga.setMinHeight(style.minHeight);
  if (typeof style.maxHeight === "number") nodeYoga.setMaxHeight(style.maxHeight);
  if (typeof style.aspectRatio === "number" && Number.isFinite(style.aspectRatio))
    nodeYoga.setAspectRatio(style.aspectRatio);
  else if (typeof style.aspectRatio === "string") {
    const ratio = Number.parseFloat(style.aspectRatio);
    if (Number.isFinite(ratio)) nodeYoga.setAspectRatio(ratio);
  }

  if (includeSpacing) {
    const margin = resolveEdges(style, "margin");
    nodeYoga.setMargin(Edge.Top, margin.top);
    nodeYoga.setMargin(Edge.Right, margin.right);
    nodeYoga.setMargin(Edge.Bottom, margin.bottom);
    nodeYoga.setMargin(Edge.Left, margin.left);
    const padding = resolveEdges(style, "padding");
    nodeYoga.setPadding(Edge.Top, padding.top);
    nodeYoga.setPadding(Edge.Right, padding.right);
    nodeYoga.setPadding(Edge.Bottom, padding.bottom);
    nodeYoga.setPadding(Edge.Left, padding.left);
  }

  // Flex properties
  if (typeof style.flexGrow === "number") {
    nodeYoga.setFlexGrow(style.flexGrow);
  } else if (typeof style.flex === "number" && style.flex > 0) {
    nodeYoga.setFlexGrow(style.flex);
  }

  if (typeof style.flexShrink === "number") {
    nodeYoga.setFlexShrink(style.flexShrink);
  } else if (isScrollChild) {
    nodeYoga.setFlexShrink(0);
  }
  if (typeof style.flexBasis === "number") {
    nodeYoga.setFlexBasis(style.flexBasis);
  }

  // AlignSelf
  if (style.alignSelf === "center") nodeYoga.setAlignSelf(Align.Center);
  else if (style.alignSelf === "flex-start") nodeYoga.setAlignSelf(Align.FlexStart);
  else if (style.alignSelf === "flex-end") nodeYoga.setAlignSelf(Align.FlexEnd);
  else if (style.alignSelf === "stretch") nodeYoga.setAlignSelf(Align.Stretch);
  else if (style.alignSelf === "baseline") nodeYoga.setAlignSelf(Align.Baseline);
  else if (style.alignSelf === "auto") nodeYoga.setAlignSelf(Align.Auto);
}

function resolveEdges(
  style: NativeStyle,
  kind: "margin" | "padding",
): { top: number; right: number; bottom: number; left: number } {
  const source = style[kind];
  const all = typeof source === "number" ? source : (source?.all ?? 0);
  const vertical = typeof source === "number" ? source : (source?.vertical ?? all);
  const horizontal = typeof source === "number" ? source : (source?.horizontal ?? all);
  return {
    top:
      style[`${kind}Top`] ??
      (typeof source === "number" ? source : source?.top) ??
      vertical,
    right:
      style[`${kind}Right`] ??
      (typeof source === "number" ? source : source?.right) ??
      horizontal,
    bottom:
      style[`${kind}Bottom`] ??
      (typeof source === "number" ? source : source?.bottom) ??
      vertical,
    left:
      style[`${kind}Left`] ??
      (typeof source === "number" ? source : source?.left) ??
      horizontal,
  };
}

function attachTextMeasure(
  nodeYoga: ReturnType<typeof Yoga.Node.create>,
  node: NativeHostNode,
): void {
  const cStyle = node.props.style ?? {};
  const textContent = extractTextContent(node);
  const fontSize = cStyle.fontSize ?? sevynTokens.typography.body.size;
  const fontWeight = cStyle.fontWeight ?? sevynTokens.typography.body.weight;
  const lineHeight = cStyle.lineHeight ?? Math.round(fontSize * 1.4);

  nodeYoga.setMeasureFunc((width, widthMode, height, heightMode) => {
    const maxWidth =
      widthMode === MeasureMode.Undefined || Number.isNaN(width)
        ? Number.POSITIVE_INFINITY
        : width;
    const measured = measureNativeText(textContent, fontSize, maxWidth, {
      weight: fontWeight,
      letterSpacing: cStyle.letterSpacing,
      fontFamily: cStyle.fontFamily,
      lineHeight,
    });
    return {
      width: widthMode === MeasureMode.Exactly ? width : Math.ceil(measured.width),
      height: heightMode === MeasureMode.Exactly ? height : Math.ceil(measured.height),
    };
  });
}

function populateChildren(
  parentYoga: ReturnType<typeof Yoga.Node.create>,
  children: readonly NativeHostNode[],
  depth: number,
): void {
  if (depth > 6) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child === undefined) continue;
    const cStyle = child.props.style ?? {};
    const childYoga = Yoga.Node.create();
    applyStylesToYogaNode(childYoga, cStyle, false);

    const isText = child.type === "text" || child.props.role === "heading";
    if (isText && (cStyle.width === undefined || cStyle.height === undefined)) {
      attachTextMeasure(childYoga, child);
    } else {
      const subChildren = child.children.filter(
        (c): c is NativeHostNode =>
          !c.hidden && c.kind === "host" && c.props.style?.position !== "absolute",
      );
      if (subChildren.length > 0) {
        populateChildren(childYoga, subChildren, depth + 1);
      }
    }
    parentYoga.insertChild(childYoga, i);
  }
}

/**
 * Computes Flexbox layout for children using Meta's official Yoga engine.
 */
export function computeYogaLayout(
  parent: NativeHostNode,
  content: NativeBounds,
  style: NativeStyle,
  relativeChildren: readonly NativeHostNode[],
): Map<string, NativeBounds> {
  const computedMap = new Map<string, NativeBounds>();
  if (relativeChildren.length === 0) return computedMap;

  const isScroll = parent.type === "scroll" || style.overflow === "scroll";
  const isRow =
    style.flexDirection === "row" ||
    style.direction === "row" ||
    style.flexDirection === "row-reverse";
  const isHorizontalScroll = isScroll && isRow;
  const isVerticalScroll = isScroll && !isHorizontalScroll;

  const root = Yoga.Node.create();
  if (isVerticalScroll) {
    root.setWidth(content.width);
    root.setHeight(Number.NaN);
  } else if (isHorizontalScroll) {
    root.setWidth(Number.NaN);
    root.setHeight(content.height);
  } else {
    root.setWidth(content.width);
    root.setHeight(content.height);
  }

  // `content` has already had the parent's padding removed by the renderer.
  applyStylesToYogaNode(root, style, false, false);

  const childNodes: {
    node: NativeHostNode;
    yoga: ReturnType<typeof Yoga.Node.create>;
  }[] = [];

  for (let i = 0; i < relativeChildren.length; i++) {
    const child = relativeChildren[i];
    if (child === undefined) continue;
    const cStyle = child.props.style ?? {};
    const childYoga = Yoga.Node.create();

    applyStylesToYogaNode(childYoga, cStyle, isScroll);

    const isText = child.type === "text" || child.props.role === "heading";
    if (isText && (cStyle.width === undefined || cStyle.height === undefined)) {
      attachTextMeasure(childYoga, child);
    } else {
      const subChildren = child.children.filter(
        (c): c is NativeHostNode =>
          !c.hidden && c.kind === "host" && c.props.style?.position !== "absolute",
      );
      if (subChildren.length > 0) {
        populateChildren(childYoga, subChildren, 1);
      }
    }

    root.insertChild(childYoga, i);
    childNodes.push({ node: child, yoga: childYoga });
  }

  const calcWidth = isHorizontalScroll ? Number.NaN : content.width;
  const calcHeight = isVerticalScroll ? Number.NaN : content.height;
  root.calculateLayout(calcWidth, calcHeight, Direction.LTR);

  for (const { node, yoga } of childNodes) {
    const layout = yoga.getComputedLayout();
    computedMap.set(node.id, {
      x: content.x + layout.left,
      y: content.y + layout.top,
      width: layout.width,
      height: layout.height,
    });
  }

  root.freeRecursive();
  return computedMap;
}
