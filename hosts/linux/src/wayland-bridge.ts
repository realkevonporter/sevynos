import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  RenderResult,
  type DisplayRenderPlan,
  type RendererState,
} from "@sevynos/graphics";
import {
  createKeyboardInputEvent,
  createPointerInputEvent,
  type KeyboardInputEvent,
  type PointerInputEvent,
} from "@sevynos/input";
import type { DesktopScene } from "@sevynos/desktop-shell";
import type {
  LinuxClipboardAdapter,
  LinuxDiagnosticsExporter,
  LinuxDisplayAdapter,
  LinuxFramePresenter,
  LinuxKeyboardAdapter,
  LinuxPersistenceAdapter,
  LinuxPointerAdapter,
  LinuxShutdownAdapter,
} from "./host-adapters.js";
import type { BinaryFramePacket } from "./binary-frame-protocol.js";
import { FramebufferPool } from "./framebuffer-pool.js";
import { IncrementalFrameRenderer } from "./incremental-frame-renderer.js";
import {
  validateLinuxHostMessage,
  validateNativeBridgeMessage,
  type LinuxHostMessage,
  type LinuxHostPayload,
  type NativeBridgeMessage,
} from "./native-ipc-protocol.js";

export interface NativeBridgeTransport {
  send(message: LinuxHostMessage, onFlushed?: (error?: Error) => void): void;
  sendFrame(
    frame: BinaryFramePacket,
    onFlushed?: (error: Error | undefined, status: "sent" | "replaced") => void,
  ): void;
  subscribe(listener: (message: unknown) => void): () => void;
  close(): Promise<void>;
}

export class WaylandBridgeConnection {
  readonly #listeners = new Set<(message: NativeBridgeMessage) => void>();
  readonly #unsubscribe: () => void;
  #sequence = 0;
  #lastInboundSequence = -1;
  public constructor(readonly transport: NativeBridgeTransport) {
    this.#unsubscribe = transport.subscribe((candidate) => {
      const message = validateNativeBridgeMessage(candidate);
      if (message.sequence <= this.#lastInboundSequence)
        throw new Error("Native bridge message is stale or out of order.");
      this.#lastInboundSequence = message.sequence;
      for (const listener of this.#listeners) listener(message);
    });
  }
  public subscribe(listener: (message: NativeBridgeMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public send(message: LinuxHostPayload, onFlushed?: (error?: Error) => void): void {
    this.#sequence += 1;
    const candidate = validateLinuxHostMessage({
      protocolVersion: 1,
      sequence: this.#sequence,
      ...message,
    });
    this.transport.send(candidate, onFlushed);
  }
  public sendFrame(
    frame: BinaryFramePacket,
    onFlushed?: (error: Error | undefined, status: "sent" | "replaced") => void,
  ): void {
    this.transport.sendFrame(frame, onFlushed);
  }
  public async close(): Promise<void> {
    this.#unsubscribe();
    this.#listeners.clear();
    await this.transport.close();
  }
}

export class WaylandDisplayAdapter implements LinuxDisplayAdapter {
  #displays: readonly NativeBridgeMessage[] = [];
  readonly #ready: Promise<void>;
  public constructor(readonly connection: WaylandBridgeConnection) {
    this.#ready = new Promise((resolve) => {
      connection.subscribe((message) => {
        if (message.type === "ready" || message.type === "display-configured") {
          this.#displays = [message];
          resolve();
        }
      });
    });
  }
  public async discover() {
    await this.#ready;
    const message = this.#displays.at(-1);
    if (message?.type !== "ready" && message?.type !== "display-configured") return [];
    return message.displays.map((display) =>
      Object.freeze({
        id: display.id,
        bounds: Object.freeze({
          x: display.x,
          y: display.y,
          width: display.width,
          height: display.height,
        }),
        scaleFactor: display.scaleFactor,
        refreshRate: display.refreshRate,
        primary: display.primary,
      }),
    );
  }
}

export class WaylandPointerAdapter implements LinuxPointerAdapter {
  public constructor(readonly connection: WaylandBridgeConnection) {}
  public subscribe(listener: (event: PointerInputEvent) => void): () => void {
    return this.connection.subscribe((message) => {
      if (message.type !== "pointer") return;
      const event = createPointerInputEvent({
        type: pointerEventType(message.event),
        eventId: `linux-pointer-${String(message.sequence)}`,
        deviceId: "linux-wayland-pointer",
        deviceKind: "mouse",
        timestamp: message.timestamp,
        pointerId: message.pointerId,
        position: { x: message.x, y: message.y },
        button: pointerButton(message.button),
        buttons: pressedButtons(message.buttons),
        pressure: message.event === "down" ? 1 : 0,
      });
      listener(
        message.traceId === undefined
          ? event
          : Object.freeze({ ...event, traceId: message.traceId }),
      );
    });
  }
}

function normalizeLinuxKey(rawKey: string): string {
  if (rawKey === "\r" || rawKey === "\n" || rawKey === "Return") return "Enter";
  if (rawKey === "\x08" || rawKey === "\x7f" || rawKey === "BackSpace")
    return "Backspace";
  if (rawKey === "\x1b" || rawKey === "Escape") return "Escape";
  if (rawKey === "\t" || rawKey === "Tab") return "Tab";
  if (rawKey === "Delete") return "Delete";
  if (rawKey === "Up") return "ArrowUp";
  if (rawKey === "Down") return "ArrowDown";
  if (rawKey === "Left") return "ArrowLeft";
  if (rawKey === "Right") return "ArrowRight";
  return rawKey;
}

export class WaylandKeyboardAdapter implements LinuxKeyboardAdapter {
  public constructor(readonly connection: WaylandBridgeConnection) {}
  public subscribe(listener: (event: KeyboardInputEvent) => void): () => void {
    return this.connection.subscribe((message) => {
      if (message.type !== "keyboard") return;
      listener(
        createKeyboardInputEvent({
          type: message.event === "down" ? "key-down" : "key-up",
          eventId: `linux-keyboard-${String(message.sequence)}`,
          deviceId: "linux-wayland-keyboard",
          deviceKind: "keyboard",
          timestamp: message.timestamp,
          key: normalizeLinuxKey(message.key),
          code: message.code,
          repeat: message.repeat,
          composing: false,
          modifiers: {
            shift: message.shift,
            alt: message.alt,
            control: message.control,
            meta: message.meta,
          },
        }),
      );
    });
  }
}

export class WaylandFramePresenter implements LinuxFramePresenter<DesktopScene> {
  public state: RendererState = "created";
  #frame = 0;
  #loggedFirstFrame = false;
  #queuedFirstFrameDiagnostic = false;
  #lastFrameDimensions: string | undefined;
  #traceId: string | undefined;
  #lastFrameSubmitted = false;
  readonly #framebuffers = new FramebufferPool(3);
  readonly #rasterizer = new IncrementalFrameRenderer();
  public constructor(
    readonly connection: WaylandBridgeConnection,
    readonly diagnostic: (value: string) => void = () => undefined,
  ) {}
  public initialize(): void {
    this.state = "initialized";
  }
  public setHardwareCursor(enabled: boolean): void {
    this.#rasterizer.setIncludeCursor(!enabled);
  }
  public get lastFrameSubmitted(): boolean {
    return this.#lastFrameSubmitted;
  }
  public traceNextFrame(traceId: string | undefined): void {
    this.#traceId = traceId;
  }
  public render(plan: DisplayRenderPlan<DesktopScene>): RenderResult {
    if (this.state !== "initialized")
      throw new Error("Wayland presenter is not initialized.");
    const width = plan.displayBounds.width;
    const height = plan.displayBounds.height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    )
      throw new Error(
        `Wayland render plan ${plan.displayId} has invalid bounds ${String(width)}x${String(height)}.`,
      );
    this.#frame += 1;
    const frameId = this.#frame;
    const traceId = this.#traceId;
    this.#traceId = undefined;
    const framebuffer = this.#framebuffers.acquire(width, height);
    const rasterStarted = performance.now();
    let frame: ReturnType<IncrementalFrameRenderer["render"]>;
    try {
      frame = this.#rasterizer.render(plan.scene, width, height, framebuffer.pixels);
      this.#framebuffers.submit(framebuffer);
    } catch (error) {
      this.#framebuffers.release(framebuffer);
      throw error;
    }
    if (frame.damage.length === 0) {
      this.#lastFrameSubmitted = false;
      this.#framebuffers.release(framebuffer);
      return new RenderResult({
        frameNumber: frameId,
        displayId: plan.displayId,
        status: "rendered",
        startedAt: new Date(),
        completedAt: new Date(),
        commandCount: 0,
      });
    }
    this.#lastFrameSubmitted = true;
    const rasterDuration = performance.now() - rasterStarted;
    if (traceId !== undefined)
      this.diagnostic(
        `TS_FRAME_RASTERIZED traceId=${traceId} frameId=${String(frameId)} durationMs=${rasterDuration.toFixed(3)}`,
      );
    const frameDimensions = `${String(frame.width)}x${String(frame.height)}:${String(frame.stride)}`;
    if (frameDimensions !== this.#lastFrameDimensions) {
      this.#lastFrameDimensions = frameDimensions;
      this.diagnostic(
        `FRAMEBUFFER SIZE width=${String(frame.width)} height=${String(frame.height)} stride=${String(frame.stride)} bytes=${String(frame.pixels.byteLength)}`,
      );
    }
    const expectedBytes = frame.stride * frame.height;
    if (frame.pixels.byteLength !== expectedBytes)
      throw new Error(
        `Rendered frame ${String(frameId)} has ${String(frame.pixels.byteLength)} bytes; expected ${String(expectedBytes)} for ${String(frame.width)}x${String(frame.height)} stride ${String(frame.stride)}.`,
      );
    const diagnoseFirstFrame =
      !this.#loggedFirstFrame && !this.#queuedFirstFrameDiagnostic;
    if (diagnoseFirstFrame) {
      this.#queuedFirstFrameDiagnostic = true;
      this.diagnostic(
        `GENESIS_FRAME_RENDERED width=${String(frame.width)} height=${String(frame.height)} stride=${String(frame.stride)} bytes=${String(frame.pixels.byteLength)}`,
      );
    }
    const encodedBytes = frame.pixels.byteLength;
    if (traceId !== undefined)
      this.diagnostic(
        `TS_FRAME_ENCODED traceId=${traceId} frameId=${String(frameId)} durationMs=0.000 encodedBytes=${String(encodedBytes)} transport=binary-pipe`,
      );
    const sendStarted = performance.now();
    this.connection.sendFrame(
      {
        frameId,
        displayId: plan.displayId,
        width: frame.width,
        height: frame.height,
        stride: frame.stride,
        format: "rgba8888",
        pixels: frame.pixels,
        damage: frame.damage,
        ...(traceId === undefined ? {} : { traceId }),
      },
      (error, status) => {
        this.#framebuffers.release(framebuffer);
        if (error !== undefined) {
          console.error(
            `GENESIS_PRESENT_MESSAGE_FAILED frameId=${String(frameId)} error=${error.message}`,
          );
          return;
        }
        if (traceId !== undefined)
          this.diagnostic(
            `TS_FRAME_SENT traceId=${traceId} frameId=${String(frameId)} durationMs=${(performance.now() - sendStarted).toFixed(3)} status=${status}`,
          );
        if (diagnoseFirstFrame) {
          this.#loggedFirstFrame = true;
          this.diagnostic(`GENESIS_PRESENT_MESSAGE_SENT frameId=${String(frameId)}`);
        }
      },
    );
    return new RenderResult({
      frameNumber: frameId,
      displayId: plan.displayId,
      status: "rendered",
      startedAt: new Date(),
      completedAt: new Date(),
      commandCount: plan.scene.nodes.length,
    });
  }
  public present(plan: DisplayRenderPlan<DesktopScene>): Promise<void> {
    this.render(plan);
    return Promise.resolve();
  }
  public shutdown(): void {
    this.#rasterizer.reset();
    this.state = "shutdown";
  }
}

export class WaylandClipboardAdapter implements LinuxClipboardAdapter {
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (text: string) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();
  #request = 0;
  public constructor(readonly connection: WaylandBridgeConnection) {
    connection.subscribe((message) => {
      if (message.type !== "clipboard-text") return;
      const pending = this.#pending.get(message.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timeout);
      pending.resolve(message.text);
      this.#pending.delete(message.requestId);
    });
  }
  public readText(): Promise<string> {
    this.#request += 1;
    const requestId = `clipboard-${String(this.#request)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("Wayland clipboard read timed out."));
      }, 2_000);
      this.#pending.set(requestId, { resolve, timeout });
      this.connection.send({ type: "clipboard-read", requestId });
    });
  }
  public writeText(text: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024)
      return Promise.reject(new Error("Clipboard text exceeds the 1 MiB size limit."));
    this.#request += 1;
    const requestId = `clipboard-${String(this.#request)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("Wayland clipboard write timed out."));
      }, 2_000);
      this.#pending.set(requestId, {
        resolve: () => {
          resolve();
        },
        timeout,
      });
      this.connection.send({ type: "clipboard-write", requestId, text });
    });
  }
}

export class FileLinuxPersistenceAdapter implements LinuxPersistenceAdapter {
  public constructor(readonly directory: string) {}
  public async load(key: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8"));
    } catch {
      return undefined;
    }
  }
  public async save(key: string, value: unknown): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  }
  public async clear(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  private path(key: string): string {
    if (!/^[a-z0-9-]+$/i.test(key)) throw new Error("Persistence key is invalid.");
    return `${this.directory}/${key}.json`;
  }
}

export class FileLinuxApplicationStorage {
  readonly #values = new Map<string, string>();
  private constructor(
    readonly persistence: FileLinuxPersistenceAdapter,
    readonly quotaBytes = 1024 * 1024,
  ) {}
  public static async create(
    persistence: FileLinuxPersistenceAdapter,
  ): Promise<FileLinuxApplicationStorage> {
    const storage = new FileLinuxApplicationStorage(persistence);
    const loaded = await persistence.load("application-storage");
    if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded))
      return storage;
    for (const [key, value] of Object.entries(loaded))
      if (
        key.length <= 512 &&
        typeof value === "string" &&
        value.length <= storage.quotaBytes
      )
        storage.#values.set(key, value);
    return storage;
  }
  public get(applicationId: string, key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(`${applicationId}:${key}`));
  }
  public async set(applicationId: string, key: string, value: string): Promise<void> {
    const prefix = `${applicationId}:`;
    const storageKey = `${prefix}${key}`;
    const current = [...this.#values.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix))
      .reduce(
        (total, [candidate, content]) => total + candidate.length + content.length,
        0,
      );
    const next =
      current - (this.#values.get(storageKey)?.length ?? 0) + key.length + value.length;
    if (next > this.quotaBytes) throw new Error("Application storage quota exceeded.");
    this.#values.set(storageKey, value);
    await this.persistence.save("application-storage", Object.fromEntries(this.#values));
  }
}

export class FileLinuxDiagnosticsExporter implements LinuxDiagnosticsExporter {
  public async export(snapshot: unknown, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

export class WaylandShutdownAdapter implements LinuxShutdownAdapter {
  readonly #listeners = new Set<() => void>();
  public constructor(readonly connection: WaylandBridgeConnection) {
    connection.subscribe((message) => {
      if (message.type === "shutdown-requested")
        for (const listener of this.#listeners) listener();
    });
  }
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public requestShutdown(): Promise<void> {
    this.connection.send({ type: "shutdown-complete" });
    return Promise.resolve();
  }
}

function pointerEventType(
  event: "move" | "down" | "up" | "cancel",
): "pointer-move" | "pointer-down" | "pointer-up" | "pointer-cancel" {
  switch (event) {
    case "move":
      return "pointer-move";
    case "down":
      return "pointer-down";
    case "up":
      return "pointer-up";
    case "cancel":
      return "pointer-cancel";
  }
}
type LinuxPointerButton =
  "none" | "primary" | "secondary" | "middle" | "back" | "forward";
function pointerButton(button: number): LinuxPointerButton {
  switch (button) {
    case 0:
      return "primary";
    case 1:
      return "middle";
    case 2:
      return "secondary";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}
function pressedButtons(mask: number): readonly LinuxPointerButton[] {
  const buttons: LinuxPointerButton[] = [];
  if ((mask & 1) !== 0) buttons.push("primary");
  if ((mask & 2) !== 0) buttons.push("secondary");
  if ((mask & 4) !== 0) buttons.push("middle");
  return Object.freeze(buttons);
}
