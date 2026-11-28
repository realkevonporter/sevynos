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
// Pointer-move subscribers. A listener
// receives {x, y} and returns true only when it changed state.
export interface PointerMoveEvent {
  x: number;
  y: number;
}
export function subscribePointerMove(
  fn: (ev: PointerMoveEvent) => boolean | void,
): () => void;
// Pointer-up subscribers (gap unit 14, audit #23). A listener is
// called on left-button release and on pointer-leave (a drag ending
// off-surface), receives the release position, and returns true only
// when it changed state — the renderer re-presents only then, the
// same contract as the move listeners. A leave carries the far-off
// position, so a listener that needs the last real position must
// remember it from the moves.
export interface PointerUpEvent {
  x: number;
  y: number;
}
export function subscribePointerUp(
  fn: (ev: PointerUpEvent) => boolean | void,
): () => void;
// Context-menu key handler (gap unit 9, audit #12). The open
// ContextMenu (./context-menu.js) registers a handler that owns the
// navigation keys while it is mounted; handleKey offers each pressed
// key to it before the TextInput / focus keys. The handler receives
// the raw key event ({key: <linux keycode>, pressed: bool, ...}) and
// returns true when it consumed the key. Pass null (or a
// non-function) to unregister.
export interface ContextMenuKeyEvent {
  key: number;
  pressed: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;
  meta?: boolean;
}
export function setContextMenuKeyHandler(
  fn: ((ev: ContextMenuKeyEvent) => boolean) | null,
): void;
// A view's press handler (gap unit 13, audit #22). The renderer
// calls onPress with the modifier keys held at the moment of the
// press — a plain click, Ctrl/Cmd-click and Shift-click all arrive
// here, so the Files list can tell them apart. Keyboard activation
// (Tab+Enter / Space) passes the activating key's modifiers the
// same way. Declared here so TSX consumers get the event shape;
// the JSX intrinsics themselves are `any` (see apps/src/jsx.d.ts
// and shell/src/jsx.d.ts).
export interface PressEvent {
  nativeEvent: {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    // The pointer position at the moment of the press (gap unit 14,
    // audit #23: the marquee starts from an onPress). Present on
    // pointer presses only — keyboard activation (Tab+Enter / Space)
    // has no position, so a handler can tell the two apart by
    // whether these keys exist.
    x?: number;
    y?: number;
  };
}
export type PressHandler = (ev: PressEvent) => void;
// A view's right-click handler (gap unit 9, audit #12). The renderer
// calls it — instead of onPress — on a right-button press on the hit
// view, with the pointer position the menu anchors on. Views without
// it ignore a right-click. Declared here so TSX consumers get the
// event shape; the JSX intrinsics themselves are `any` (see
// apps/src/jsx.d.ts and shell/src/jsx.d.ts).
export interface ContextMenuEvent {
  nativeEvent: {
    x: number;
    y: number;
    button: number;
  };
}
export type ContextMenuHandler = (ev: ContextMenuEvent) => void;
// Surface-size store for useSyncExternalStore (the dock's
// shrink-to-fit); the snapshot is replaced on host resize.
export interface SurfaceSizeSnapshot {
  width: number;
  height: number;
}
export function subscribeSurfaceSize(fn: () => void): () => void;
export function getSurfaceSizeSnapshot(): SurfaceSizeSnapshot;
