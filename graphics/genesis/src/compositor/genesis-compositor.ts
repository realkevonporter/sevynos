import {
  SceneGraph,
  SceneNodeKind,
  type SceneNode,
  type SceneNodeBounds,
} from "../scene";
import { SurfaceManager, type GenesisSurface } from "../surfaces";

export interface MountApplicationSurfaceOptions {
  readonly surface: GenesisSurface;
  readonly bounds: SceneNodeBounds;
  readonly zIndex?: number;
}

export interface MountOverlayOptions {
  readonly id: string;
  readonly bounds: SceneNodeBounds;
  readonly zIndex?: number;
}

export class GenesisCompositor {
  public constructor(
    private readonly sceneGraph: SceneGraph,
    private readonly surfaceManager: SurfaceManager,
  ) {}

  public mountApplicationSurface(options: MountApplicationSurfaceOptions): SceneNode {
    const { surface, bounds, zIndex = 0 } = options;

    if (!this.surfaceManager.hasSurface(surface.id)) {
      this.surfaceManager.registerSurface(surface);
    }

    const node: SceneNode = {
      id: this.createApplicationNodeId(surface.id),
      kind: SceneNodeKind.ApplicationSurface,
      bounds,
      visible: true,
      zIndex,
      surfaceId: surface.id,
    };

    this.sceneGraph.upsertNode(node);

    return node;
  }

  public unmountApplicationSurface(surfaceId: string): void {
    this.sceneGraph.removeNode(this.createApplicationNodeId(surfaceId));

    this.surfaceManager.removeSurface(surfaceId);
  }

  public mountOverlay(options: MountOverlayOptions): SceneNode {
    const { id, bounds, zIndex = 100 } = options;

    const node: SceneNode = {
      id,
      kind: SceneNodeKind.Overlay,
      bounds,
      visible: true,
      zIndex,
    };

    this.sceneGraph.upsertNode(node);

    return node;
  }

  public unmountOverlay(nodeId: string): boolean {
    return this.sceneGraph.removeNode(nodeId);
  }

  public setSurfaceVisibility(surfaceId: string, visible: boolean): void {
    const currentNode = this.getApplicationNode(surfaceId);

    this.sceneGraph.updateNode({
      ...currentNode,
      visible,
    });
  }

  public updateSurfaceBounds(surfaceId: string, bounds: SceneNodeBounds): void {
    const currentNode = this.getApplicationNode(surfaceId);

    this.sceneGraph.updateNode({
      ...currentNode,
      bounds,
    });
  }

  public updateApplicationSurface(options: {
    readonly surfaceId: string;
    readonly zIndex: number;
  }): void {
    const currentNode = this.getApplicationNode(options.surfaceId);

    this.sceneGraph.updateNode({
      ...currentNode,
      zIndex: options.zIndex,
    });
  }

  public compose(): readonly SceneNode[] {
    return this.sceneGraph.getVisibleNodes();
  }

  private getApplicationNode(surfaceId: string): SceneNode {
    const nodeId = this.createApplicationNodeId(surfaceId);

    const node = this.sceneGraph.getNode(nodeId);

    if (node === undefined) {
      throw new Error(`No scene node exists for surface "${surfaceId}".`);
    }

    return node;
  }

  private createApplicationNodeId(surfaceId: string): string {
    return `application:${surfaceId}`;
  }
}
