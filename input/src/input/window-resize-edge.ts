export type WindowResizeEdge =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export function resizesFromTop(edge: WindowResizeEdge): boolean {
  return edge === "top" || edge === "top-left" || edge === "top-right";
}

export function resizesFromRight(edge: WindowResizeEdge): boolean {
  return edge === "right" || edge === "top-right" || edge === "bottom-right";
}

export function resizesFromBottom(edge: WindowResizeEdge): boolean {
  return edge === "bottom" || edge === "bottom-left" || edge === "bottom-right";
}

export function resizesFromLeft(edge: WindowResizeEdge): boolean {
  return edge === "left" || edge === "top-left" || edge === "bottom-left";
}
