import {
  getNativeAdapters,
  NativeModuleUnavailableError,
} from "./native-adapter-contracts.js";

export interface WebSocketOpenEvent {
  readonly type: "open";
  readonly target: SevynWebSocket;
}
export interface WebSocketMessageEvent {
  readonly type: "message";
  readonly target: SevynWebSocket;
  readonly data: string | ArrayBuffer;
}
export interface WebSocketErrorEvent {
  readonly type: "error";
  readonly target: SevynWebSocket;
  readonly message: string;
}
export interface WebSocketCloseEvent {
  readonly type: "close";
  readonly target: SevynWebSocket;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}
export type SevynWebSocketEvent =
  WebSocketOpenEvent | WebSocketMessageEvent | WebSocketErrorEvent | WebSocketCloseEvent;
type WebSocketEventType = SevynWebSocketEvent["type"];
type WebSocketListener = (event: SevynWebSocketEvent) => void;

/** A browser-compatible WebSocket surface backed by the trusted Sevyn network broker. */
export class SevynWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public readonly url: string;
  public readonly binaryType = "arraybuffer" as const;
  public readonly extensions = "";
  public protocol = "";
  public bufferedAmount = 0;
  public readyState = SevynWebSocket.CONNECTING;
  public onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  public onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  public onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  public onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly #listeners = new Map<WebSocketEventType, Set<WebSocketListener>>();
  readonly #adapter = getNativeAdapters().webSocket;
  #id: string | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #closeRequested: { readonly code: number; readonly reason: string } | undefined;

  public constructor(url: string, protocols?: string | readonly string[]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      throw new SyntaxError("WebSocket URL must use ws:// or wss://.");
    this.url = parsed.toString();
    if (this.#adapter === undefined) throw new NativeModuleUnavailableError("webSocket");
    const protocolList = normalizeProtocols(protocols);
    void this.#adapter
      .open(this.url, protocolList.length === 0 ? undefined : protocolList)
      .then(
        (opened) => {
          this.#id = opened.id;
          this.protocol = opened.protocol;
          if (this.#closeRequested !== undefined) {
            this.readyState = SevynWebSocket.CLOSING;
            void this.#adapter
              ?.close(opened.id, this.#closeRequested.code, this.#closeRequested.reason)
              .then(
                () => {
                  this.#finalizeClose(true);
                },
                (error: unknown) => {
                  this.#fail(error);
                },
              );
            return;
          }
          this.readyState = SevynWebSocket.OPEN;
          this.#dispatch({ type: "open", target: this });
          this.#pollTimer = setInterval(() => {
            void this.#poll();
          }, 25);
        },
        (error: unknown) => {
          this.#fail(error);
        },
      );
  }

  public addEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<WebSocketListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(
    type: WebSocketEventType,
    listener: WebSocketListener,
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== SevynWebSocket.OPEN || this.#id === undefined)
      throw new Error("WebSocket is not open.");
    const payload =
      typeof data === "string" ? { text: data } : { base64: encodeBase64(toBytes(data)) };
    this.bufferedAmount +=
      typeof data === "string" ? data.length : toBytes(data).byteLength;
    const id = this.#id;
    void this.#adapter?.send(id, payload).then(
      () => {
        this.bufferedAmount = 0;
      },
      (error: unknown) => {
        this.#fail(error);
      },
    );
  }

  public close(code = 1000, reason = ""): void {
    if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999)))
      throw new RangeError("WebSocket close code is invalid.");
    if (reason.length > 123) throw new SyntaxError("WebSocket close reason is too long.");
    if (
      this.readyState === SevynWebSocket.CLOSED ||
      this.readyState === SevynWebSocket.CLOSING
    )
      return;
    this.#closeRequested = { code, reason };
    this.readyState = SevynWebSocket.CLOSING;
    if (this.#id === undefined) return;
    void this.#adapter?.close(this.#id, code, reason).then(
      () => {
        this.#finalizeClose(true);
      },
      (error: unknown) => {
        this.#fail(error);
      },
    );
  }

  #dispatch(event: SevynWebSocketEvent): void {
    if (event.type === "open") this.onopen?.(event);
    else if (event.type === "message") this.onmessage?.(event);
    else if (event.type === "error") this.onerror?.(event);
    else this.onclose?.(event);
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
  }

  async #poll(): Promise<void> {
    if (
      this.#polling ||
      this.readyState !== SevynWebSocket.OPEN ||
      this.#id === undefined
    )
      return;
    this.#polling = true;
    try {
      const event = await this.#adapter?.receive(this.#id);
      if (event === undefined || event.type === "timeout") return;
      if (event.type === "message") {
        const data =
          event.base64 === undefined ? (event.text ?? "") : decodeBase64(event.base64);
        this.#dispatch({ type: "message", target: this, data });
      } else if (event.type === "error") {
        this.#dispatch({
          type: "error",
          target: this,
          message: event.message ?? "WebSocket error.",
        });
      } else {
        this.#finalizeClose(
          event.code === 1000 || event.code === 1001,
          event.code,
          event.reason ?? "",
        );
      }
    } catch (error: unknown) {
      this.#fail(error);
    } finally {
      this.#polling = false;
    }
  }

  #fail(error: unknown): void {
    if (this.readyState === SevynWebSocket.CLOSED) return;
    this.#dispatch({
      type: "error",
      target: this,
      message: error instanceof Error ? error.message : String(error),
    });
    this.#finalizeClose(false, 1006, "");
  }

  #finalizeClose(
    wasClean: boolean,
    code = this.#closeRequested?.code ?? 1000,
    reason = this.#closeRequested?.reason ?? "",
  ): void {
    if (this.readyState === SevynWebSocket.CLOSED) return;
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.readyState = SevynWebSocket.CLOSED;
    this.#dispatch({ type: "close", target: this, code, reason, wasClean });
  }
}

export const WebSocket = SevynWebSocket;

function normalizeProtocols(protocols: string | readonly string[] | undefined): string[] {
  if (protocols === undefined) return [];
  const values = typeof protocols === "string" ? [protocols] : [...protocols];
  const unique = new Set<string>();
  for (const value of values) {
    if (!/^[\x21-\x7e]+$/.test(value) || unique.has(value))
      throw new SyntaxError("WebSocket subprotocols are invalid or duplicated.");
    unique.add(value);
  }
  return values;
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return typeof btoa === "function" ? btoa(output) : base64EncodeFallback(bytes);
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = typeof atob === "function" ? atob(value) : base64DecodeFallback(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function base64EncodeFallback(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >> 2] ?? "";
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)] ?? "";
    result +=
      second === undefined
        ? "="
        : (alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)] ?? "");
    result += third === undefined ? "=" : (alphabet[third & 63] ?? "");
  }
  return result;
}

function base64DecodeFallback(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/=+$/, "");
  let buffer = 0;
  let bits = 0;
  let result = "";
  for (const character of clean) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid WebSocket binary payload.");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return result;
}
