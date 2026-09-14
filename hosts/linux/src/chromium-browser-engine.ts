import { spawn, type ChildProcess } from "node:child_process";
import { chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import WebSocket, { type RawData } from "ws";
import type {
  BrowserEngineSnapshot,
  SevynBrowserEngine,
} from "@sevynos/react-native/internal";

interface ChromiumBrowserEngineOptions {
  readonly width?: number;
  readonly height?: number;
  readonly executable?: string;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly userDataDirectory?: string;
  readonly downloadDirectory?: string;
}

interface ChromiumVersion {
  readonly webSocketDebuggerUrl?: string;
}

const blankSnapshot = (width: number, height: number): BrowserEngineSnapshot =>
  Object.freeze({
    ready: false,
    loading: false,
    url: "",
    title: "New Tab",
    width,
    height,
  });

export class ChromiumBrowserEngine implements SevynBrowserEngine {
  readonly #listeners = new Set<() => void>();
  readonly #executable: string;
  readonly #delay: (milliseconds: number) => Promise<void>;
  #current: BrowserEngineSnapshot;
  #connection: CdpConnection | undefined;
  #process: ChildProcess | undefined;
  #userDataDirectory: string | undefined;
  readonly #configuredUserDataDirectory: string | undefined;
  readonly #downloadDirectory: string | undefined;
  #captureTimer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  public constructor(options: ChromiumBrowserEngineOptions = {}) {
    this.#current = blankSnapshot(options.width ?? 878, options.height ?? 501);
    this.#executable = options.executable ?? "/usr/bin/chromium";
    const stateDirectory = process.env["SEVYN_STATE_DIRECTORY"];
    this.#configuredUserDataDirectory =
      options.userDataDirectory ??
      (stateDirectory === undefined
        ? undefined
        : join(stateDirectory, "browser-profile"));
    this.#downloadDirectory =
      options.downloadDirectory ??
      (stateDirectory === undefined ? undefined : join(stateDirectory, "Downloads"));
    this.#delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  public snapshot(): BrowserEngineSnapshot {
    return this.#current;
  }

  public navigate(address: string): Promise<BrowserEngineSnapshot> {
    const candidate = new URL(address);
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:")
      return Promise.reject(new Error("Only HTTP and HTTPS addresses are supported."));
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      await connection.send("Page.navigate", { url: candidate.toString() });
      await this.#delay(650);
      return await this.#capture();
    });
  }

  public back(): Promise<BrowserEngineSnapshot> {
    return this.#history(-1);
  }

  public forward(): Promise<BrowserEngineSnapshot> {
    return this.#history(1);
  }

  public reload(): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      await connection.send("Page.reload", { ignoreCache: false });
      await this.#delay(500);
      return await this.#capture();
    });
  }

  public resize(width: number, height: number): Promise<BrowserEngineSnapshot> {
    const nextWidth = Math.max(320, Math.min(3840, Math.round(width)));
    const nextHeight = Math.max(240, Math.min(2160, Math.round(height)));
    if (nextWidth === this.#current.width && nextHeight === this.#current.height)
      return Promise.resolve(this.#current);
    this.#current = Object.freeze({
      ...this.#current,
      width: nextWidth,
      height: nextHeight,
    });
    this.#emit();
    if (this.#connection === undefined) return Promise.resolve(this.#current);
    return this.#enqueue(async () => {
      await this.#setViewport();
      return await this.#capture();
    });
  }

  public click(x: number, y: number): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      const point = {
        x: Math.max(0, Math.min(this.#current.width - 1, Math.round(x))),
        y: Math.max(0, Math.min(this.#current.height - 1, Math.round(y))),
      };
      await connection.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await connection.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await this.#delay(250);
      return await this.#capture();
    });
  }

  public pointerDown(x: number, y: number, button = 0): Promise<BrowserEngineSnapshot> {
    return this.#pointer("mousePressed", x, y, button, false);
  }

  public pointerUp(x: number, y: number, button = 0): Promise<BrowserEngineSnapshot> {
    return this.#pointer("mouseReleased", x, y, button, true);
  }

  public scroll(deltaY: number): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      await connection.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(this.#current.width / 2),
        y: Math.round(this.#current.height / 2),
        deltaX: 0,
        deltaY,
      });
      await this.#delay(120);
      return await this.#capture();
    });
  }

  public key(
    key: string,
    code: string,
    modifiers?: { shift: boolean; alt: boolean; control: boolean; meta: boolean },
  ): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      const modifierMask =
        (modifiers?.alt === true ? 1 : 0) |
        (modifiers?.control === true ? 2 : 0) |
        (modifiers?.meta === true ? 4 : 0) |
        (modifiers?.shift === true ? 8 : 0);
      const text = key.length === 1 && modifierMask === 0 ? key : undefined;
      const virtualKeyCode = chromiumVirtualKeyCode(key);
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        modifiers: modifierMask,
        ...(virtualKeyCode === undefined
          ? {}
          : {
              windowsVirtualKeyCode: virtualKeyCode,
              nativeVirtualKeyCode: virtualKeyCode,
            }),
        ...(text === undefined ? {} : { text }),
      });
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        modifiers: modifierMask,
        ...(virtualKeyCode === undefined
          ? {}
          : {
              windowsVirtualKeyCode: virtualKeyCode,
              nativeVirtualKeyCode: virtualKeyCode,
            }),
      });
      await this.#delay(80);
      return await this.#capture();
    });
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #pointer(
    type: "mousePressed" | "mouseReleased",
    x: number,
    y: number,
    button: number,
    capture: boolean,
  ): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      await connection.send("Input.dispatchMouseEvent", {
        type,
        x: Math.max(0, Math.min(this.#current.width - 1, Math.round(x))),
        y: Math.max(0, Math.min(this.#current.height - 1, Math.round(y))),
        button: button === 1 ? "middle" : button === 2 ? "right" : "left",
        clickCount: 1,
      });
      if (!capture)
        return this.#publish(Object.freeze({ ...this.#current, loading: false }));
      await this.#delay(100);
      return this.#capture();
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection?.close();
    this.#connection = undefined;
    this.#process?.kill("SIGTERM");
    this.#process = undefined;
    const directory = this.#userDataDirectory;
    this.#userDataDirectory = undefined;
    if (this.#captureTimer !== undefined) clearTimeout(this.#captureTimer);
    this.#captureTimer = undefined;
    if (
      this.#configuredUserDataDirectory === undefined &&
      directory?.startsWith(join(tmpdir(), "sevyn-browser-")) === true
    )
      await rm(directory, { recursive: true, force: true });
  }

  #history(offset: number): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      const history = await connection.send<{
        readonly currentIndex: number;
        readonly entries: readonly { readonly id: number }[];
      }>("Page.getNavigationHistory");
      const entry = history.entries[history.currentIndex + offset];
      if (entry === undefined) return this.#capture();
      await connection.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await this.#delay(350);
      return await this.#capture();
    });
  }

  #enqueue(
    operation: () => Promise<BrowserEngineSnapshot>,
  ): Promise<BrowserEngineSnapshot> {
    const run = async (): Promise<BrowserEngineSnapshot> => {
      if (this.#closed) throw new Error("The browser has closed.");
      this.#publish(Object.freeze({ ...this.#current, loading: true, error: undefined }));
      try {
        return await operation();
      } catch (error: unknown) {
        return this.#publish(
          Object.freeze({
            ...this.#current,
            loading: false,
            error: error instanceof Error ? error.message : "The browser request failed.",
          }),
        );
      }
    };
    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async #requireConnection(): Promise<CdpConnection> {
    if (this.#connection !== undefined) return this.#connection;
    const port = 32_000 + Math.floor(Math.random() * 8_000);
    const directory =
      this.#configuredUserDataDirectory ??
      (await mkdtemp(join(tmpdir(), "sevyn-browser-")));
    await mkdir(directory, { recursive: true });
    if (this.#downloadDirectory !== undefined)
      await mkdir(this.#downloadDirectory, { recursive: true });
    this.#userDataDirectory = directory;
    const runningAsRoot = process.getuid?.() === 0;
    if (runningAsRoot) {
      await chown(directory, 65_534, 65_534);
      if (this.#downloadDirectory !== undefined)
        await chown(this.#downloadDirectory, 65_534, 65_534);
    }
    this.#process = spawn(
      this.#executable,
      [
        "--headless=new",
        "--disable-dev-shm-usage",
        "--disable-component-update",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--remote-allow-origins=*",
        `--remote-debugging-port=${String(port)}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${directory}`,
        `--window-size=${String(this.#current.width)},${String(this.#current.height)}`,
        // Running as root on bare-metal requires --no-sandbox; Chromium
        // refuses to start inside user namespaces when uid is 0.
        ...(runningAsRoot ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        ...(runningAsRoot ? { uid: 65_534, gid: 65_534 } : {}),
        env: {
          ...process.env,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
          XDG_CACHE_HOME: directory,
        },
      },
    );
    let processError = "";
    this.#process.stderr?.setEncoding("utf8");
    this.#process.stderr?.on("data", (chunk: string) => {
      processError += chunk;
    });
    this.#process.once("exit", () => {
      this.#connection = undefined;
    });
    let browserDebuggerUrl: string | undefined;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        const versionResponse = await fetch(
          `http://127.0.0.1:${String(port)}/json/version`,
          { signal: AbortSignal.timeout(500) },
        );
        const version: unknown = await versionResponse.json();
        if (typeof version === "object" && version !== null)
          browserDebuggerUrl = (version as ChromiumVersion).webSocketDebuggerUrl;
      } catch {
        // Chromium has not opened its local debugging endpoint yet.
      }
      if (browserDebuggerUrl !== undefined) break;
      await this.#delay(100);
    }
    if (browserDebuggerUrl === undefined)
      throw new Error(
        processError.trim() || "The standards-based browser engine could not start.",
      );
    this.#connection = await CdpConnection.connect(browserDebuggerUrl);
    const target = await this.#connection.send<{ readonly targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const attached = await this.#connection.send<{ readonly sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
    );
    this.#connection.useSession(attached.sessionId);
    this.#connection.onEvent((method) => {
      if (
        method === "Page.loadEventFired" ||
        method === "Page.frameNavigated" ||
        method === "Page.navigatedWithinDocument"
      )
        this.#scheduleCapture();
    });
    await this.#connection.send("Page.enable");
    await this.#connection.send("Runtime.enable");
    if (this.#downloadDirectory !== undefined)
      await this.#connection.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: this.#downloadDirectory,
      });
    await this.#setViewport();
    this.#scheduleCapture(500);
    return this.#connection;
  }

  async #setViewport(): Promise<void> {
    await this.#connection?.send("Emulation.setDeviceMetricsOverride", {
      width: this.#current.width,
      height: this.#current.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async #capture(): Promise<BrowserEngineSnapshot> {
    const connection = await this.#requireConnection();
    const screenshot = await connection.send<{ readonly data: string }>(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
    );
    const page = await connection.send<{
      readonly result?: {
        readonly value?: { readonly title?: string; readonly url?: string };
      };
    }>("Runtime.evaluate", {
      expression: "({title: document.title, url: location.href})",
      returnByValue: true,
    });
    const decoded = decodePng(Buffer.from(screenshot.data, "base64"));
    return this.#publish(
      Object.freeze({
        ready: true,
        loading: false,
        url: page.result?.value?.url ?? this.#current.url,
        title:
          page.result?.value?.title === undefined || page.result.value.title === ""
            ? "New Tab"
            : page.result.value.title,
        width: decoded.width,
        height: decoded.height,
        pixels: decoded.pixels,
      }),
    );
  }

  #publish(snapshot: BrowserEngineSnapshot): BrowserEngineSnapshot {
    this.#current = snapshot;
    this.#emit();
    return snapshot;
  }

  #scheduleCapture(delayMilliseconds = 100): void {
    if (this.#closed) return;
    if (this.#captureTimer !== undefined) clearTimeout(this.#captureTimer);
    this.#captureTimer = setTimeout(() => {
      this.#captureTimer = undefined;
      const capture = this.#queue.then(
        () => this.#capture(),
        () => this.#capture(),
      );
      this.#queue = capture.then(
        () => {
          this.#scheduleCapture(500);
        },
        () => {
          this.#scheduleCapture(500);
        },
      );
    }, delayMilliseconds);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  #nextId = 0;
  #sessionId: string | undefined;
  readonly #eventListeners = new Set<(method: string) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const value: unknown = JSON.parse(rawDataText(data));
      if (typeof value !== "object" || value === null) return;
      const message = value as {
        readonly id?: unknown;
        readonly method?: unknown;
        readonly result?: unknown;
        readonly error?: { readonly message?: unknown };
      };
      if (typeof message.method === "string") {
        for (const listener of this.#eventListeners) listener(message.method);
      }
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined)
        pending.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message
              : "The browser engine rejected a request.",
          ),
        );
      else pending.resolve(message.result ?? {});
    });
    socket.on("close", () => {
      for (const pending of this.#pending.values()) clearTimeout(pending.timer);
      for (const pending of this.#pending.values())
        pending.reject(new Error("The browser engine connection closed."));
      this.#pending.clear();
    });
  }

  public static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("open", () => {
        resolve(new CdpConnection(socket));
      });
      socket.once("error", () => {
        reject(new Error("Unable to connect to the browser engine."));
      });
    });
  }

  public send<T = Record<string, never>>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The browser engine timed out while running ${method}.`));
      }, 12_000);
      this.#pending.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        }),
      );
    });
  }

  public useSession(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  public onEvent(listener: (method: string) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  public close(): void {
    this.#socket.close();
  }
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function chromiumVirtualKeyCode(key: string): number | undefined {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    " ": 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
  }[key];
}

export function decodePng(input: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
} {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => input[index] !== value))
    throw new Error("The browser returned an invalid image.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  let interlace = -1;
  const compressed: Uint8Array[] = [];
  while (offset + 12 <= input.byteLength) {
    const length = readUint32(input, offset);
    const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > input.byteLength) throw new Error("The browser image is truncated.");
    if (type === "IHDR") {
      width = readUint32(input, start);
      height = readUint32(input, start + 4);
      bitDepth = input[start + 8] ?? -1;
      colorType = input[start + 9] ?? -1;
      interlace = input[start + 12] ?? -1;
    } else if (type === "IDAT") compressed.push(input.slice(start, end));
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (
    width < 1 ||
    height < 1 ||
    width > 3_840 ||
    height > 2_160 ||
    bitDepth !== 8 ||
    (colorType !== 6 && colorType !== 2) ||
    interlace !== 0
  )
    throw new Error("The browser returned an unsupported image format.");
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const inflated = inflateSync(
    Buffer.concat(compressed.map((chunk) => Buffer.from(chunk))),
  );
  if (inflated.byteLength !== (rowBytes + 1) * height)
    throw new Error("The browser image has an unexpected size.");
  const raw = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (rowBytes + 1)] ?? -1;
    const sourceStart = row * (rowBytes + 1) + 1;
    const targetStart = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const value = inflated[sourceStart + column] ?? 0;
      const left =
        column >= bytesPerPixel ? (raw[targetStart + column - bytesPerPixel] ?? 0) : 0;
      const above = row > 0 ? (raw[targetStart + column - rowBytes] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? (raw[targetStart + column - rowBytes - bytesPerPixel] ?? 0)
          : 0;
      raw[targetStart + column] =
        filter === 0
          ? value
          : filter === 1
            ? (value + left) & 255
            : filter === 2
              ? (value + above) & 255
              : filter === 3
                ? (value + Math.floor((left + above) / 2)) & 255
                : filter === 4
                  ? (value + paeth(left, above, upperLeft)) & 255
                  : (() => {
                      throw new Error("The browser image uses an invalid filter.");
                    })();
    }
  }
  if (colorType === 6) return Object.freeze({ width, height, pixels: raw });
  const pixels = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < raw.length; source += 3, target += 4) {
    pixels[target] = raw[source] ?? 0;
    pixels[target + 1] = raw[source + 1] ?? 0;
    pixels[target + 2] = raw[source + 2] ?? 0;
    pixels[target + 3] = 255;
  }
  return Object.freeze({ width, height, pixels });
}

function readUint32(input: Uint8Array, offset: number): number {
  return (
    ((input[offset] ?? 0) * 0x1000000 +
      ((input[offset + 1] ?? 0) << 16) +
      ((input[offset + 2] ?? 0) << 8) +
      (input[offset + 3] ?? 0)) >>>
    0
  );
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
}
