export enum SceneNodeKind {
  ApplicationSurface = "application-surface",
  SystemOverlay = "system-overlay",
  Overlay = "overlay",
}

export interface SceneNodeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SceneNode {
  readonly id: string;
  readonly kind: SceneNodeKind;
  readonly bounds: SceneNodeBounds;
  readonly visible: boolean;
  readonly zIndex: number;
  readonly surfaceId?: string;
}
