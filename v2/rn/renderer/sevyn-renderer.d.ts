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
export interface AppSnapshot {
  apps: {
    id: string;
    name: string;
    version: string;
    color: string;
    glyph: string;
    system: boolean;
    protected: boolean;
    permissions: string[];
    // Per-app single-instance flag (default true): a dock click on a
    // running single-instance app focuses it; a running multi-instance
    // app opens a new window instead.
    singleInstance: boolean;
  }[];
  running: string[];
  lastEvent: { kind: string; id: string } | null;
  seq: number;
}
export function subscribeApps(fn: () => void): () => void;
export function getAppsSnapshot(): AppSnapshot;
// Window state store for useSyncExternalStore (title-bar ▢ / ❐).
export interface WindowStateSnapshot {
  maximized: boolean;
}
export function subscribeWindowState(fn: () => void): () => void;
export function getWindowStateSnapshot(): WindowStateSnapshot;
