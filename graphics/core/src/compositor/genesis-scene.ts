import type { SceneId } from "./scene-id.js";
import type { SceneGroupNode, WindowSceneNode } from "./scene-node.js";

export interface GenesisSceneProperties {
  readonly id: SceneId;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly root: SceneGroupNode;
}

export class GenesisScene {
  public readonly id: SceneId;

  public readonly sequence: number;

  public readonly createdAt: Date;

  public readonly root: SceneGroupNode;

  public constructor(properties: GenesisSceneProperties) {
    if (!Number.isInteger(properties.sequence) || properties.sequence < 1) {
      throw new RangeError("Scene sequence must be a positive integer.");
    }

    this.id = properties.id;
    this.sequence = properties.sequence;

    this.createdAt = new Date(properties.createdAt);

    this.root = properties.root;
  }

  public listWindows(): readonly WindowSceneNode[] {
    return this.root.children.filter(
      (node): node is WindowSceneNode => node.kind === "window",
    );
  }

  public getTopWindow(): WindowSceneNode | undefined {
    return this.listWindows().at(-1);
  }

  public getFocusedWindow(): WindowSceneNode | undefined {
    return this.listWindows().find((node) => node.focused);
  }
}
