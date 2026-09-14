import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import {
  encodeBinaryFrame,
  type BinaryFramePacket,
  type EncodedBinaryFrame,
} from "./binary-frame-protocol.js";
import type { LinuxHostMessage } from "./native-ipc-protocol.js";
import type { NativeBridgeTransport } from "./wayland-bridge.js";

export class NativeProcessBridgeTransport implements NativeBridgeTransport {
  readonly #child;
  readonly #lines;
  readonly #frameStream: Writable;
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #pendingMessages: unknown[] = [];
  #pendingDeliveryScheduled = false;
  #frameWriting = false;
  #pendingFrame:
    | {
        readonly frame: EncodedBinaryFrame;
        readonly onFlushed:
          ((error: Error | undefined, status: "sent" | "replaced") => void) | undefined;
      }
    | undefined;
  #closed = false;
  public constructor(executable: string, argumentsValue: readonly string[] = []) {
    this.#child = spawn(executable, [...argumentsValue], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] ?? "/run/sevynos",
        WAYLAND_DISPLAY: process.env["WAYLAND_DISPLAY"] ?? "wayland-0",
        ...(process.env["SEVYN_FOCUS_TRACE"] === undefined
          ? {}
          : { SEVYN_FOCUS_TRACE: process.env["SEVYN_FOCUS_TRACE"] }),
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const frameStream = this.#child.stdio[3];
    if (frameStream === null || frameStream === undefined || !("write" in frameStream))
      throw new Error("The native bridge binary frame pipe was not created.");
    this.#frameStream = frameStream;
    this.#lines = createInterface({ input: this.#child.stdout });
    this.#child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.#child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE")
        console.error(`Genesis native bridge stdin failed: ${error.message}`);
    });
    this.#frameStream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE")
        console.error(`Genesis binary frame pipe failed: ${error.message}`);
    });
    this.#lines.on("line", (line) => {
      if (Buffer.byteLength(line, "utf8") > 4 * 1024 * 1024) {
        console.error("Genesis native bridge response exceeded the IPC size limit.");
        return;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (this.#listeners.size === 0 || this.#pendingDeliveryScheduled) {
          if (this.#pendingMessages.length === 256) {
            console.error(
              "Genesis native bridge startup-message buffer exceeded its limit.",
            );
            return;
          }
          this.#pendingMessages.push(value);
        } else {
          for (const listener of this.#listeners) listener(value);
        }
      } catch (error: unknown) {
        console.error(
          `Genesis native bridge emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  public send(message: LinuxHostMessage, onFlushed?: (error?: Error) => void): void {
    if (this.#closed) throw new Error("Native bridge is closed.");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
      const writeError = error ?? undefined;
      if (
        this.#closed &&
        (writeError as NodeJS.ErrnoException | undefined)?.code === "EPIPE"
      )
        return;
      onFlushed?.(writeError);
    });
  }
  public sendFrame(
    frame: BinaryFramePacket,
    onFlushed?: (error: Error | undefined, status: "sent" | "replaced") => void,
  ): void {
    if (this.#closed) throw new Error("Native bridge is closed.");
    const pending = { frame: encodeBinaryFrame(frame), onFlushed };
    if (this.#frameWriting) {
      this.#pendingFrame?.onFlushed?.(undefined, "replaced");
      this.#pendingFrame = pending;
      return;
    }
    this.#writeFrame(pending);
  }
  public get frameQueueDepth(): number {
    return (this.#frameWriting ? 1 : 0) + (this.#pendingFrame === undefined ? 0 : 1);
  }
  public subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    if (this.#pendingMessages.length > 0 && !this.#pendingDeliveryScheduled) {
      this.#pendingDeliveryScheduled = true;
      queueMicrotask(() => {
        if (this.#closed) return;
        const pending = this.#pendingMessages.splice(0);
        for (const message of pending)
          for (const subscribed of this.#listeners) subscribed(message);
        this.#pendingDeliveryScheduled = false;
      });
    }
    return () => this.#listeners.delete(listener);
  }
  public close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#lines.close();
    this.#child.stdin.end();
    this.#frameStream.end();
    this.#child.kill("SIGTERM");
    this.#listeners.clear();
    this.#pendingMessages.length = 0;
    return Promise.resolve();
  }
  #writeFrame(pending: {
    readonly frame: EncodedBinaryFrame;
    readonly onFlushed:
      ((error: Error | undefined, status: "sent" | "replaced") => void) | undefined;
  }): void {
    this.#frameWriting = true;
    this.#frameStream.cork();
    this.#frameStream.write(pending.frame.metadata);
    this.#frameStream.write(pending.frame.pixels, (error?: Error | null) => {
      this.#frameWriting = false;
      pending.onFlushed?.(error ?? undefined, "sent");
      const latest = this.#pendingFrame;
      this.#pendingFrame = undefined;
      if (latest !== undefined && !this.#closed) this.#writeFrame(latest);
    });
    this.#frameStream.uncork();
  }
}
