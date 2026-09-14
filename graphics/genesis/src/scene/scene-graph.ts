import type { SceneNode } from "./scene-node";

export type SceneGraphListener = () => void;

export class SceneGraph {
  private readonly nodes = new Map<string, SceneNode>();

  private readonly listeners = new Set<SceneGraphListener>();

  private version = 0;

  public addNode(node: SceneNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Scene node "${node.id}" is already registered.`);
    }

    this.nodes.set(node.id, node);
    this.emitChange();
  }

  public updateNode(node: SceneNode): void {
    if (!this.nodes.has(node.id)) {
      throw new Error(`Scene node "${node.id}" is not registered.`);
    }

    this.nodes.set(node.id, node);
    this.emitChange();
  }

  public upsertNode(node: SceneNode): void {
    this.nodes.set(node.id, node);
    this.emitChange();
  }

  public removeNode(nodeId: string): boolean {
    const removed = this.nodes.delete(nodeId);

    if (removed) {
      this.emitChange();
    }

    return removed;
  }

  public getNode(nodeId: string): SceneNode | undefined {
    return this.nodes.get(nodeId);
  }

  public getNodes(): readonly SceneNode[] {
    return [...this.nodes.values()].sort(
      (left, right): number => left.zIndex - right.zIndex,
    );
  }

  public getVisibleNodes(): readonly SceneNode[] {
    return this.getNodes().filter((node): boolean => node.visible);
  }

  public hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  public clear(): void {
    if (this.nodes.size === 0) {
      return;
    }

    this.nodes.clear();
    this.emitChange();
  }

  public subscribe(listener: SceneGraphListener): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public getVersion(): number {
    return this.version;
  }

  public get size(): number {
    return this.nodes.size;
  }

  private emitChange(): void {
    this.version += 1;

    for (const listener of this.listeners) {
      listener();
    }
  }
}
