import type { DisplayRenderPlan, GenesisRenderer, WindowBounds } from "@sevynos/graphics";
import type { KeyboardInputEvent, PointerInputEvent } from "@sevynos/input";
import type {
  ApplicationWorkerExecutor,
  ApplicationWorkerTransport,
  ApplicationWorkerDescriptor,
} from "@sevynos/react-native/internal";

export interface LinuxDisplayDescriptor {
  readonly id: string;
  readonly bounds: WindowBounds;
  readonly scaleFactor: number;
  readonly refreshRate: number;
  readonly primary: boolean;
}
export interface LinuxDisplayAdapter {
  discover(): Promise<readonly LinuxDisplayDescriptor[]>;
}
export interface LinuxPointerAdapter {
  subscribe(listener: (event: PointerInputEvent) => void): () => void;
}
export interface LinuxKeyboardAdapter {
  subscribe(listener: (event: KeyboardInputEvent) => void): () => void;
}
export interface LinuxClipboardAdapter {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
export interface LinuxFramePresenter<TScene> extends GenesisRenderer<TScene> {
  present(plan: DisplayRenderPlan<TScene>): Promise<void>;
}
export interface LinuxPersistenceAdapter {
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  clear(key: string): Promise<void>;
}
export interface LinuxDiagnosticsExporter {
  export(snapshot: unknown, destination: string): Promise<void>;
}
export interface LinuxShutdownAdapter {
  requestShutdown(): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface FutureWaylandAdapter {
  readonly protocol: "wayland";
  connect(): Promise<void>;
}
export interface FutureDrmKmsAdapter {
  readonly backend: "drm-kms";
  initialize(): Promise<void>;
}
export interface FutureLibinputAdapter {
  readonly source: "libinput";
  connect(): Promise<void>;
}

export interface LinuxProcessApplicationExecutor extends ApplicationWorkerExecutor {
  readonly isolation: "process";
}

export class HeadlessWorkerApplicationExecutor implements ApplicationWorkerExecutor {
  public constructor(
    readonly createTransport: (
      descriptor: ApplicationWorkerDescriptor,
    ) => Promise<ApplicationWorkerTransport>,
  ) {}
  public create(
    descriptor: ApplicationWorkerDescriptor,
  ): Promise<ApplicationWorkerTransport> {
    return this.createTransport(descriptor);
  }
}
