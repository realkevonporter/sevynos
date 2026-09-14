import {
  GenesisCompositor,
  GenesisWindowManager,
  SceneGraph,
  SurfaceManager,
} from "@sevynos/genesis";

export interface ShellGenesis {
  readonly compositor: GenesisCompositor;
  readonly sceneGraph: SceneGraph;
  readonly surfaceManager: SurfaceManager;
  readonly windowManager: GenesisWindowManager;
}

export function createShellGenesis(): ShellGenesis {
  const sceneGraph = new SceneGraph();

  const surfaceManager = new SurfaceManager();

  const compositor = new GenesisCompositor(sceneGraph, surfaceManager);

  const windowManager = new GenesisWindowManager(compositor);

  return {
    compositor,
    sceneGraph,
    surfaceManager,
    windowManager,
  };
}
