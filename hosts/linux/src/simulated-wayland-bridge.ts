import type { LinuxHostMessage, NativeBridgePayload } from "./native-ipc-protocol.js";
import type { BinaryFramePacket } from "./binary-frame-protocol.js";
import type { NativeBridgeTransport } from "./wayland-bridge.js";

export class SimulatedWaylandBridgeTransport implements NativeBridgeTransport {
  readonly sent: LinuxHostMessage[] = [];
  readonly frames: BinaryFramePacket[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();
  #sequence = 0;
  clipboard = "";
  autoPresentFrames = true;
  public send(message: LinuxHostMessage, onFlushed?: (error?: Error) => void): void {
    this.sent.push(message);
    if (message.type === "clipboard-read")
      this.emit({
        type: "clipboard-text",
        requestId: message.requestId,
        text: this.clipboard,
      });
    if (message.type === "clipboard-write") {
      this.clipboard = message.text;
      this.emit({
        type: "clipboard-text",
        requestId: message.requestId,
        text: message.text,
      });
    }
    onFlushed?.();
  }
  public sendFrame(
    frame: BinaryFramePacket,
    onFlushed?: (error: Error | undefined, status: "sent" | "replaced") => void,
  ): void {
    this.frames.push(frame);
    onFlushed?.(undefined, "sent");
    if (this.autoPresentFrames) this.presentFrame(frame.frameId);
  }
  public subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public close(): Promise<void> {
    this.#listeners.clear();
    return Promise.resolve();
  }
  public ready(width = 1280, height = 720, scaleFactor = 1): void {
    this.emit({
      type: "diagnostic",
      severity: "info",
      event: "input-devices-initialized",
      message: "The simulated pointer and keyboard capabilities are ready.",
    });
    this.emit({
      type: "diagnostic",
      severity: "info",
      event: "visible-surface-configured",
      message: `The simulated Wayland surface is configured at ${String(width)}x${String(height)}.`,
    });
    this.emit({
      type: "ready",
      displays: [
        {
          id: "wayland-output-1",
          x: 0,
          y: 0,
          width,
          height,
          pixelWidth: width * scaleFactor,
          pixelHeight: height * scaleFactor,
          scaleFactor,
          refreshRate: 60,
          primary: true,
        },
      ],
    });
  }
  public pointer(
    event: "move" | "down" | "up" | "cancel",
    x: number,
    y: number,
    traceId?: string,
  ): void {
    this.emit({
      type: "pointer",
      event,
      pointerId: 1,
      x,
      y,
      button: 0,
      buttons: event === "down" ? 1 : 0,
      timestamp: Date.now(),
      ...(traceId === undefined ? {} : { traceId }),
    });
  }
  public presentFrame(frameId: number): void {
    const frame = this.frames.find((candidate) => candidate.frameId === frameId);
    if (frame === undefined) throw new Error(`Frame ${String(frameId)} was not sent.`);
    this.emit({
      type: "frame-presented",
      frameId: frame.frameId,
      displayId: frame.displayId,
      ...(frame.traceId === undefined ? {} : { traceId: frame.traceId }),
    });
  }
  public keyboard(event: "down" | "up", key: string, code = key): void {
    this.emit({
      type: "keyboard",
      event,
      key,
      code,
      repeat: false,
      shift: false,
      alt: false,
      control: false,
      meta: false,
      timestamp: Date.now(),
    });
  }
  public resize(width: number, height: number, scaleFactor: number): void {
    this.emit({
      type: "display-configured",
      displays: [
        {
          id: "wayland-output-1",
          x: 0,
          y: 0,
          width,
          height,
          pixelWidth: width * scaleFactor,
          pixelHeight: height * scaleFactor,
          scaleFactor,
          refreshRate: 60,
          primary: true,
        },
      ],
    });
  }
  public shutdown(): void {
    this.emit({ type: "shutdown-requested", reason: "compositor-closed" });
  }
  private emit(message: NativeBridgePayload): void {
    this.#sequence += 1;
    const value = { protocolVersion: 1 as const, sequence: this.#sequence, ...message };
    for (const listener of this.#listeners) listener(value);
  }
}
