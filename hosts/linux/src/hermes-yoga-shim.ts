type Dimension = { value: number; percent: boolean } | undefined;
interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const FlexDirection = Object.freeze({
  Row: 0,
  RowReverse: 1,
  Column: 2,
  ColumnReverse: 3,
});
export const Justify = Object.freeze({
  Center: 0,
  FlexEnd: 1,
  SpaceBetween: 2,
  SpaceAround: 3,
  SpaceEvenly: 4,
  FlexStart: 5,
});
export const Align = Object.freeze({
  Center: 0,
  FlexEnd: 1,
  Stretch: 2,
  Baseline: 3,
  Auto: 4,
  FlexStart: 5,
});
export const Gutter = Object.freeze({ All: 0, Row: 1, Column: 2 });
export const Edge = Object.freeze({ Top: 0, Right: 1, Bottom: 2, Left: 3, All: 4 });
export const Wrap = Object.freeze({ NoWrap: 0, Wrap: 1, WrapReverse: 2 });
export const Direction = Object.freeze({ LTR: 0, RTL: 1 });
export const MeasureMode = Object.freeze({
  Undefined: 0,
  Exactly: 1,
  AtMost: 2,
});

class YogaNode {
  #children: YogaNode[] = [];
  #width: Dimension;
  #height: Dimension;
  #minWidth?: number;
  #maxWidth?: number;
  #minHeight?: number;
  #maxHeight?: number;
  #flexGrow = 0;
  #flexShrink = 0;
  #flexBasis?: number;
  #direction: number = FlexDirection.Column;
  #justify: number = Justify.FlexStart;
  #alignItems: number = Align.Stretch;
  #alignSelf: number = Align.Auto;
  #rowGap = 0;
  #columnGap = 0;
  #wrap: number = Wrap.NoWrap;
  #aspectRatio?: number;
  #margin: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
  #padding: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
  #layout: Layout = { left: 0, top: 0, width: 0, height: 0 };
  #measureFunc?:
    | ((
        width: number,
        widthMode: number,
        height: number,
        heightMode: number,
      ) => { width: number; height: number })
    | undefined;

  setMeasureFunc(
    fn: (
      width: number,
      widthMode: number,
      height: number,
      heightMode: number,
    ) => { width: number; height: number },
  ): void {
    this.#measureFunc = fn;
  }
  unsetMeasureFunc(): void {
    this.#measureFunc = undefined;
  }

  setWidth(value: number): void {
    this.#width = { value, percent: false };
  }
  setWidthPercent(value: number): void {
    this.#width = { value, percent: true };
  }
  setHeight(value: number): void {
    this.#height = { value, percent: false };
  }
  setHeightPercent(value: number): void {
    this.#height = { value, percent: true };
  }
  setMinWidth(value: number): void {
    this.#minWidth = value;
  }
  setMaxWidth(value: number): void {
    this.#maxWidth = value;
  }
  setMinHeight(value: number): void {
    this.#minHeight = value;
  }
  setMaxHeight(value: number): void {
    this.#maxHeight = value;
  }
  setFlexGrow(value: number): void {
    this.#flexGrow = Math.max(0, value);
  }
  setFlexShrink(value: number): void {
    this.#flexShrink = Math.max(0, value);
  }
  setFlexBasis(value: number): void {
    this.#flexBasis = Math.max(0, value);
  }
  setFlexDirection(value: number): void {
    this.#direction = value;
  }
  setJustifyContent(value: number): void {
    this.#justify = value;
  }
  setAlignItems(value: number): void {
    this.#alignItems = value;
  }
  setAlignSelf(value: number): void {
    this.#alignSelf = value;
  }
  setGap(gutter: number, value: number): void {
    if (gutter === Gutter.All || gutter === Gutter.Row) this.#rowGap = Math.max(0, value);
    if (gutter === Gutter.All || gutter === Gutter.Column)
      this.#columnGap = Math.max(0, value);
  }
  setFlexWrap(value: number): void {
    this.#wrap = value;
  }
  setAspectRatio(value: number): void {
    if (Number.isFinite(value) && value > 0) this.#aspectRatio = value;
  }
  setMargin(edge: number, value: number): void {
    setEdge(this.#margin, edge, value);
  }
  setPadding(edge: number, value: number): void {
    setEdge(this.#padding, edge, value);
  }
  insertChild(child: YogaNode, index: number): void {
    this.#children.splice(index, 0, child);
  }
  getComputedLayout(): Layout {
    return { ...this.#layout };
  }
  freeRecursive(): void {
    this.#children.length = 0;
  }

  calculateLayout(
    availableWidth: number,
    availableHeight: number,
    direction: number = Direction.LTR,
  ): void {
    if (direction === Direction.RTL) {
      // RTL direction layout support
    }
    let width = dimension(this.#width, availableWidth);
    let height = dimension(this.#height, availableHeight);
    if (width === undefined && height !== undefined && this.#aspectRatio !== undefined)
      width = height * this.#aspectRatio;
    if (height === undefined && width !== undefined && this.#aspectRatio !== undefined)
      height = width / this.#aspectRatio;
    width ??= availableWidth;
    height ??= availableHeight;
    this.#layout = { left: 0, top: 0, width, height };
    const row =
      this.#direction === FlexDirection.Row ||
      this.#direction === FlexDirection.RowReverse;
    const reverse =
      this.#direction === FlexDirection.RowReverse ||
      this.#direction === FlexDirection.ColumnReverse;
    const mainSize = row ? width : height;
    const crossSize = row ? height : width;
    const gap = row ? this.#columnGap : this.#rowGap;
    const crossGap = row ? this.#rowGap : this.#columnGap;
    const measured = this.#children.map((child) => {
      let mainDimension = row ? child.#width : child.#height;
      let crossDimension = row ? child.#height : child.#width;
      if (
        child.#measureFunc !== undefined &&
        (mainDimension === undefined || crossDimension === undefined)
      ) {
        const measuredRes = child.#measureFunc(
          row ? mainSize : crossSize,
          2,
          row ? crossSize : mainSize,
          0,
        );
        mainDimension ??= {
          value: row ? measuredRes.width : measuredRes.height,
          percent: false,
        };
        crossDimension ??= {
          value: row ? measuredRes.height : measuredRes.width,
          percent: false,
        };
      }
      let resolvedMain = dimension(mainDimension, mainSize);
      let resolvedCross = dimension(crossDimension, crossSize);
      if (child.#aspectRatio !== undefined) {
        if (resolvedMain === undefined && resolvedCross !== undefined)
          resolvedMain = row
            ? resolvedCross * child.#aspectRatio
            : resolvedCross / child.#aspectRatio;
        if (resolvedCross === undefined && resolvedMain !== undefined)
          resolvedCross = row
            ? resolvedMain / child.#aspectRatio
            : resolvedMain * child.#aspectRatio;
      }
      return {
        child,
        main: child.#flexBasis ?? resolvedMain ?? 0,
        cross: resolvedCross,
        mainStart: row ? child.#margin.left : child.#margin.top,
        mainEnd: row ? child.#margin.right : child.#margin.bottom,
        crossStart: row ? child.#margin.top : child.#margin.left,
        crossEnd: row ? child.#margin.bottom : child.#margin.right,
      };
    });
    const lines: (typeof measured)[] = [[]];
    for (const item of measured) {
      let current = lines.at(-1);
      if (!current) {
        current = [];
        lines.push(current);
      }
      const occupied = current.reduce(
        (sum, entry) => sum + entry.main + entry.mainStart + entry.mainEnd,
        Math.max(0, current.length - 1) * gap,
      );
      const outer = item.main + item.mainStart + item.mainEnd;
      if (
        this.#wrap !== Wrap.NoWrap &&
        current.length > 0 &&
        occupied + gap + outer > mainSize
      )
        lines.push([item]);
      else current.push(item);
    }
    const lineCrossSizes = lines.map((line) =>
      Math.max(
        0,
        ...line.map((item) => (item.cross ?? 0) + item.crossStart + item.crossEnd),
      ),
    );
    if (lines.length === 1) lineCrossSizes[0] = crossSize;
    let crossCursor =
      this.#wrap === Wrap.WrapReverse
        ? crossSize -
          lineCrossSizes.reduce((sum, value) => sum + value, 0) -
          Math.max(0, lines.length - 1) * crossGap
        : 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines.at(lineIndex);
      if (!line) continue;
      const totalGap = Math.max(0, line.length - 1) * gap;
      const fixed = line.reduce(
        (sum, item) => sum + item.main + item.mainStart + item.mainEnd,
        0,
      );
      let remaining = mainSize - fixed - totalGap;
      const growTotal = line.reduce((sum, item) => sum + item.child.#flexGrow, 0);
      const shrinkTotal = line.reduce(
        (sum, item) => sum + item.child.#flexShrink * item.main,
        0,
      );
      for (const item of line) {
        if (remaining > 0 && growTotal > 0)
          item.main += (remaining * item.child.#flexGrow) / growTotal;
        else if (remaining < 0 && shrinkTotal > 0)
          item.main = Math.max(
            0,
            item.main + (remaining * item.child.#flexShrink * item.main) / shrinkTotal,
          );
        item.main = row
          ? clamp(item.main, item.child.#minWidth, item.child.#maxWidth)
          : clamp(item.main, item.child.#minHeight, item.child.#maxHeight);
      }
      const occupied = line.reduce(
        (sum, item) => sum + item.main + item.mainStart + item.mainEnd,
        totalGap,
      );
      remaining = Math.max(0, mainSize - occupied);
      const spacing = justify(this.#justify, remaining, line.length);
      let cursor = spacing.start;
      const lineCross = lineCrossSizes[lineIndex] ?? crossSize;
      for (const item of reverse ? [...line].reverse() : line) {
        const align =
          item.child.#alignSelf === Align.Auto ? this.#alignItems : item.child.#alignSelf;
        let cross =
          item.cross ??
          (align === Align.Stretch
            ? Math.max(0, lineCross - item.crossStart - item.crossEnd)
            : 0);
        cross = row
          ? clamp(cross, item.child.#minHeight, item.child.#maxHeight)
          : clamp(cross, item.child.#minWidth, item.child.#maxWidth);
        const availableCross = Math.max(
          0,
          lineCross - item.crossStart - item.crossEnd - cross,
        );
        const crossPosition =
          crossCursor +
          item.crossStart +
          (align === Align.Center
            ? availableCross / 2
            : align === Align.FlexEnd
              ? availableCross
              : 0);
        cursor += item.mainStart;
        item.child.#layout = row
          ? { left: cursor, top: crossPosition, width: item.main, height: cross }
          : { left: crossPosition, top: cursor, width: cross, height: item.main };
        cursor += item.main + item.mainEnd + gap + spacing.between;
      }
      crossCursor += lineCross + crossGap;
    }
  }
}

function setEdge(edges: Edges, edge: number, value: number): void {
  const resolved = Number.isFinite(value) ? value : 0;
  if (edge === Edge.All) {
    edges.top = resolved;
    edges.right = resolved;
    edges.bottom = resolved;
    edges.left = resolved;
  } else if (edge === Edge.Top) edges.top = resolved;
  else if (edge === Edge.Right) edges.right = resolved;
  else if (edge === Edge.Bottom) edges.bottom = resolved;
  else if (edge === Edge.Left) edges.left = resolved;
}

function dimension(value: Dimension, available: number): number | undefined {
  return value === undefined
    ? undefined
    : value.percent
      ? (available * value.value) / 100
      : value.value;
}
function clamp(value: number, minimum?: number, maximum?: number): number {
  return Math.max(minimum ?? 0, Math.min(maximum ?? Number.POSITIVE_INFINITY, value));
}
function justify(
  mode: number,
  remaining: number,
  count: number,
): { start: number; between: number } {
  if (mode === Justify.Center) return { start: remaining / 2, between: 0 };
  if (mode === Justify.FlexEnd) return { start: remaining, between: 0 };
  if (mode === Justify.SpaceBetween && count > 1)
    return { start: 0, between: remaining / (count - 1) };
  if (mode === Justify.SpaceAround && count > 0) {
    const between = remaining / count;
    return { start: between / 2, between };
  }
  if (mode === Justify.SpaceEvenly && count > 0) {
    const between = remaining / (count + 1);
    return { start: between, between };
  }
  return { start: 0, between: 0 };
}

const Yoga = Object.freeze({ Node: Object.freeze({ create: () => new YogaNode() }) });
export default Yoga;
