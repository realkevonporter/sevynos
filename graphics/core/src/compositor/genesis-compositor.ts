import type { GenesisWindow } from "../window/genesis-window.js";
import type { WindowRegistry } from "../window/window-registry.js";
import { GenesisScene } from "./genesis-scene.js";
import type { SceneId, SceneNodeId } from "./scene-id.js";
import { IDENTITY_SCENE_TRANSFORM } from "./scene-node.js";
import type { SceneGroupNode, WindowSceneNode } from "./scene-node.js";

export interface GenesisCompositorDependencies {
  readonly windows: WindowRegistry;

  readonly createSceneId: () => SceneId;

  readonly createSceneNodeId: () => SceneNodeId;

  readonly now: () => Date;
}

export class GenesisCompositor {
  readonly #windows: WindowRegistry;

  readonly #createSceneId: () => SceneId;

  readonly #createSceneNodeId: () => SceneNodeId;

  readonly #now: () => Date;

  #sequence = 0;

  public constructor(dependencies: GenesisCompositorDependencies) {
    this.#windows = dependencies.windows;

    this.#createSceneId = dependencies.createSceneId;

    this.#createSceneNodeId = dependencies.createSceneNodeId;

    this.#now = dependencies.now;
  }

  public compose(): GenesisScene {
    this.#sequence += 1;

    const windowNodes = this.#getRenderableWindows().map((window) =>
      this.#createWindowNode(window),
    );

    const root: SceneGroupNode = {
      id: this.#createSceneNodeId(),
      kind: "group",
      opacity: 1,
      visible: true,
      transform: IDENTITY_SCENE_TRANSFORM,
      children: windowNodes,
    };

    return new GenesisScene({
      id: this.#createSceneId(),
      sequence: this.#sequence,
      createdAt: this.#now(),
      root,
    });
  }

  #getRenderableWindows(): readonly GenesisWindow[] {
    return this.#windows
      .list()
      .filter((window) => window.state === "visible" || window.state === "focused")
      .sort((first, second) => {
        if (first.zIndex !== second.zIndex) {
          return first.zIndex - second.zIndex;
        }

        return first.id.localeCompare(second.id);
      });
  }

  #createWindowNode(window: GenesisWindow): WindowSceneNode {
    return {
      id: this.#createSceneNodeId(),
      kind: "window",
      windowId: window.id,
      bounds: window.bounds,
      zIndex: window.zIndex,
      focused: window.state === "focused",
      opacity: 1,
      visible: true,
      transform: IDENTITY_SCENE_TRANSFORM,
    };
  }
}
