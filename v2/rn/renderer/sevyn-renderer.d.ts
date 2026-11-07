// Type declarations for the Sevyn renderer (plain JS, ../renderer).
// The shell imports the renderer API from here; esbuild bundles the
// .js implementation.

export interface ScrollViewInstance {
  yogaId: number;
  contentWidth: number;
  contentHeight: number;
  scrollX: number;
  scrollY: number;
}

export function render(
  element: any,
  options?: { width?: number; height?: number; backgroundColor?: string },
): any;
export function update(element: any): any;
export function unmount(): void;
export function scrollBy(instance: ScrollViewInstance, dx: number, dy: number): void;
export function scrollTo(instance: ScrollViewInstance, x: number, y: number): void;
export function subscribeStatus(fn: () => void): () => void;
export function getStatusSnapshot(): { [key: string]: string };
