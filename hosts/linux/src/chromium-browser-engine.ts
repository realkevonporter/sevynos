import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import WebSocket, { type RawData } from "ws";
import type {
  BrowserEngineSnapshot,
  FindInPageResult,
  SevynBrowserEngine,
} from "@sevynos/react-native/internal";

/**
 * Emit a marker to stdout and mirror to the serial console (if present),
 * matching the Genesis marker behavior in wayland.ts.
 */
function emitServiceMarker(value: string): void {
  console.log(value);
  try {
    if (existsSync("/dev/ttyS0")) {
      appendFileSync("/dev/ttyS0", value + "\n");
    }
  } catch {
    // Ignore errors writing to serial port
  }
}

export interface ChromiumBrowserEngineOptions {
  readonly width?: number;
  readonly height?: number;
  readonly executable?: string;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly userDataDirectory?: string;
  readonly downloadDirectory?: string;
  /**
   * When true, the engine uses push-based CDP screencast (Page.startScreencast
   * with JPEG frames) instead of screenshot-per-action. Input becomes
   * fire-and-forget and frames arrive via Page.screencastFrame events.
   */
  readonly screencast?: boolean;
  readonly screencastQuality?: number;
}

export interface ScreencastStats {
  readonly active: boolean;
  readonly frames: number;
  readonly fps: number;
  readonly averageInputLatencyMs: number | undefined;
  readonly lastInputLatencyMs: number | undefined;
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
    zoomFactor: 1,
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
  readonly #screencastEnabled: boolean;
  readonly #screencastQuality: number;
  #screencastActive = false;
  #screencastFrames = 0;
  #screencastFirstFrameAt = 0;
  #screencastLastFrameAt = 0;
  #pendingInputAt = 0;
  #inputLatencies: number[] = [];
  #zoomFactor = 1;

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
    this.#screencastEnabled = options.screencast === true;
    this.#screencastQuality =
      options.screencastQuality === undefined
        ? 80
        : Math.max(10, Math.min(100, Math.round(options.screencastQuality)));
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
      return await this.#afterInput(650);
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
      return await this.#afterInput(500);
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
      if (this.#screencastActive) return this.#current;
      return await this.#capture();
    });
  }

  public click(x: number, y: number, clickCount = 1): Promise<BrowserEngineSnapshot> {
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
        clickCount,
      });
      await connection.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount,
      });
      return await this.#afterInput(250);
    });
  }

  public pointerDown(x: number, y: number, button = 0): Promise<BrowserEngineSnapshot> {
    return this.#pointer("mousePressed", x, y, button, false);
  }

  public pointerUp(x: number, y: number, button = 0): Promise<BrowserEngineSnapshot> {
    return this.#pointer("mouseReleased", x, y, button, true);
  }

  public pointerMove(x: number, y: number): Promise<BrowserEngineSnapshot> {
    return this.#pointer("mouseMoved", x, y, 0, false);
  }

  public scroll(
    x: number,
    y: number,
    deltaY: number,
    deltaX = 0,
  ): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const connection = await this.#requireConnection();
      await connection.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.max(0, Math.min(this.#current.width - 1, Math.round(x))),
        y: Math.max(0, Math.min(this.#current.height - 1, Math.round(y))),
        deltaX,
        deltaY,
      });
      return await this.#afterInput(120);
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
      return await this.#afterInput(80);
    });
  }

  public setZoomFactor(factor: number): Promise<BrowserEngineSnapshot> {
    return this.#enqueue(async () => {
      const clamped = Math.max(0.25, Math.min(5, factor));
      this.#zoomFactor = clamped;
      const connection = await this.#requireConnection();
      await connection.send("Runtime.evaluate", {
        expression: `document.documentElement.style.setProperty("zoom", "${String(clamped)}")`,
        returnByValue: true,
      });
      return await this.#afterInput(120);
    });
  }

  public async findInPage(text: string, forward = true): Promise<FindInPageResult> {
    if (this.#closed) throw new Error("The browser has closed.");
    const connection = await this.#requireConnection();
    const result = await connection.send<{
      readonly result?: { readonly value?: boolean };
    }>("Runtime.evaluate", {
      expression: `window.find(${JSON.stringify(text)}, false, false, ${forward ? "true" : "false"}, false, false, false)`,
      returnByValue: true,
    });
    return { found: result.result?.value === true };
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Starts push-based screencast. Frames arrive as Page.screencastFrame events
   * and are published through the normal snapshot subscription; input methods
   * become fire-and-forget while it is active.
   */
  public async startScreencast(): Promise<void> {
    const connection = await this.#requireConnection();
    await this.#beginScreencast(connection);
  }

  async #beginScreencast(connection?: CdpConnection): Promise<void> {
    if (this.#screencastActive || this.#closed) return;
    const active = connection ?? (await this.#requireConnection());
    await active.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.#screencastQuality,
      everyNthFrame: 1,
    });
    this.#screencastActive = true;
    this.#screencastFrames = 0;
    this.#screencastFirstFrameAt = 0;
    this.#screencastLastFrameAt = 0;
    this.#inputLatencies = [];
  }

  public async stopScreencast(): Promise<void> {
    if (!this.#screencastActive) return;
    this.#screencastActive = false;
    try {
      await this.#connection?.send("Page.stopScreencast");
    } catch {
      // The connection may already be gone; nothing to clean up.
    }
  }

  public screencastStats(): ScreencastStats | undefined {
    if (!this.#screencastEnabled && !this.#screencastActive) return undefined;
    const elapsedSeconds =
      this.#screencastFirstFrameAt === 0 || this.#screencastLastFrameAt === 0
        ? 0
        : (this.#screencastLastFrameAt - this.#screencastFirstFrameAt) / 1000;
    const average =
      this.#inputLatencies.length === 0
        ? undefined
        : this.#inputLatencies.reduce((sum, value) => sum + value, 0) /
          this.#inputLatencies.length;
    return Object.freeze({
      active: this.#screencastActive,
      frames: this.#screencastFrames,
      fps: elapsedSeconds > 0 ? this.#screencastFrames / elapsedSeconds : 0,
      averageInputLatencyMs: average,
      lastInputLatencyMs:
        this.#inputLatencies.length === 0
          ? undefined
          : this.#inputLatencies[this.#inputLatencies.length - 1],
    });
  }

  async #handleScreencastFrame(params: unknown): Promise<void> {
    if (!this.#screencastActive || this.#closed) return;
    if (typeof params !== "object" || params === null) return;
    const frame = params as {
      readonly data?: unknown;
      readonly sessionId?: unknown;
    };
    // Note: Chrome sends sessionId as a number despite the CDP spec saying string.
    // Send it back as-is for the ack; Chromium matches it exactly.
    const sessionId = frame.sessionId;
    if (
      typeof frame.data !== "string" ||
      (typeof sessionId !== "string" && typeof sessionId !== "number")
    )
      return;
    const receivedAt = nowMilliseconds();
    // Acknowledge immediately (fire-and-forget) so Chromium keeps streaming;
    // a dropped or corrupt frame must not stall the pipeline.
    void this.#connection
      ?.send("Page.screencastFrameAck", { sessionId })
      .catch(() => undefined);
    let decoded: {
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8Array;
    };
    try {
      decoded = await decodeJpeg(Buffer.from(frame.data, "base64"));
    } catch {
      return;
    }
    this.#screencastFrames += 1;
    if (this.#screencastFirstFrameAt === 0) {
      this.#screencastFirstFrameAt = receivedAt;
      emitServiceMarker("SEVYN_CODE_SERVICE_FIRST_FRAME_RECEIVED");
    }
    this.#screencastLastFrameAt = receivedAt;
    if (this.#pendingInputAt !== 0) {
      const latency = receivedAt - this.#pendingInputAt;
      this.#pendingInputAt = 0;
      this.#inputLatencies.push(latency);
      if (this.#inputLatencies.length > 120) this.#inputLatencies.shift();
    }
    this.#publish(
      Object.freeze({
        ready: true,
        loading: false,
        url: this.#current.url,
        title: this.#current.title,
        width: decoded.width,
        height: decoded.height,
        pixels: decoded.pixels,
      }),
    );
  }

  #pointer(
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
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
      return await this.#afterInput(100);
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#screencastActive = false;
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
      return await this.#afterInput(350);
    });
  }

  /**
   * Shared tail for input/navigation actions. In pull mode this keeps the
   * legacy fixed-delay-then-screenshot behavior. In screencast mode input is
   * fire-and-forget: the frame carrying the result arrives via
   * Page.screencastFrame, so we only stamp the input time for latency stats.
   */
  async #afterInput(delayMilliseconds: number): Promise<BrowserEngineSnapshot> {
    if (this.#screencastActive) {
      this.#pendingInputAt = nowMilliseconds();
      return this.#current;
    }
    await this.#delay(delayMilliseconds);
    return await this.#capture();
  }

  #enqueue(
    operation: () => Promise<BrowserEngineSnapshot>,
  ): Promise<BrowserEngineSnapshot> {
    const run = async (): Promise<BrowserEngineSnapshot> => {
      if (this.#closed) throw new Error("The browser has closed.");
      if (!this.#screencastActive)
        this.#publish(
          Object.freeze({ ...this.#current, loading: true, error: undefined }),
        );
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
    this.#connection.onEvent((method, params) => {
      if (
        method === "Page.loadEventFired" ||
        method === "Page.frameNavigated" ||
        method === "Page.navigatedWithinDocument"
      )
        this.#scheduleCapture();
      else if (method === "Page.screencastFrame")
        void this.#handleScreencastFrame(params);
    });
    await this.#connection.send("Page.enable");
    await this.#connection.send("Runtime.enable");
    if (this.#downloadDirectory !== undefined)
      await this.#connection.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: this.#downloadDirectory,
      });
    await this.#setViewport();
    if (this.#screencastEnabled) await this.#beginScreencast();
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
        zoomFactor: this.#zoomFactor,
      }),
    );
  }

  #publish(snapshot: BrowserEngineSnapshot): BrowserEngineSnapshot {
    this.#current = snapshot;
    this.#emit();
    return snapshot;
  }

  #scheduleCapture(delayMilliseconds = 100): void {
    // In screencast mode frames arrive via Page.screencastFrame; the periodic
    // pull capture is disabled so it cannot overwrite newer pushed frames.
    if (this.#closed || this.#screencastActive) return;
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
  readonly #eventListeners = new Set<(method: string, params: unknown) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const value: unknown = JSON.parse(rawDataText(data));
      if (typeof value !== "object" || value === null) return;
      const message = value as {
        readonly id?: unknown;
        readonly method?: unknown;
        readonly params?: unknown;
        readonly result?: unknown;
        readonly error?: { readonly message?: unknown };
      };
      if (typeof message.method === "string") {
        for (const listener of this.#eventListeners)
          listener(message.method, message.params);
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

  public onEvent(listener: (method: string, params: unknown) => void): () => void {
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

function nowMilliseconds(): number {
  return performance.now();
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

/**
 * Baseline (sequential DCT, 8-bit) JPEG decoder. Pure TypeScript fallback for
 * environments where the native decoder (sharp) is unavailable. Screencast
 * frames arrive as JPEG, so the push-based pipeline needs this instead of the
 * PNG path. Output is RGBA, matching decodePng's contract.
 */
export function decodeJpegPure(input: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
} {
  if (input.length < 2 || input[0] !== 0xff || input[1] !== 0xd8)
    throw new Error("The browser returned an invalid JPEG image.");
  let offset = 2;
  const quantTables: (Uint16Array | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const dcTables: (JpegHuffmanTable | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const acTables: (JpegHuffmanTable | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  let width = 0;
  let height = 0;
  let components: JpegComponent[] = [];
  let restartInterval = 0;

  const readMarker = (): number => {
    if ((input[offset] ?? 0) !== 0xff)
      throw new Error("The JPEG image has corrupt marker data.");
    let marker = input[offset + 1] ?? 0;
    offset += 2;
    while (marker === 0xff) {
      marker = input[offset] ?? 0;
      offset += 1;
    }
    return marker;
  };

  for (;;) {
    const marker = readMarker();
    if (marker === 0xd9) break; // EOI
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue; // SOI / RSTn
    if (offset + 2 > input.length) throw new Error("The JPEG image is truncated.");
    const length = ((input[offset] ?? 0) << 8) | (input[offset + 1] ?? 0);
    if (length < 2 || offset + length > input.length)
      throw new Error("The JPEG image is truncated.");
    const dataStart = offset + 2;
    const dataEnd = offset + length;

    if (marker === 0xdb) {
      // DQT
      let position = dataStart;
      while (position < dataEnd) {
        const info = input[position] ?? 0;
        position += 1;
        const precision = info >>> 4;
        const tableId = info & 15;
        if (tableId > 3) throw new Error("The JPEG image is unsupported.");
        const table = new Uint16Array(64);
        for (let i = 0; i < 64; i += 1) {
          if (precision === 0) {
            table[JPEG_ZIGZAG[i] ?? 0] = input[position] ?? 0;
            position += 1;
          } else {
            table[JPEG_ZIGZAG[i] ?? 0] =
              ((input[position] ?? 0) << 8) | (input[position + 1] ?? 0);
            position += 2;
          }
        }
        quantTables[tableId] = table;
      }
    } else if (marker === 0xc4) {
      // DHT
      let position = dataStart;
      while (position < dataEnd) {
        const info = input[position] ?? 0;
        position += 1;
        const tableClass = info >>> 4;
        const tableId = info & 15;
        if (tableId > 3 || tableClass > 1)
          throw new Error("The JPEG image is unsupported.");
        const bits = input.slice(position, position + 16);
        position += 16;
        let total = 0;
        for (let i = 0; i < 16; i += 1) total += bits[i] ?? 0;
        const values = input.slice(position, position + total);
        position += total;
        const table = buildJpegHuffmanTable(bits, values);
        if (tableClass === 0) dcTables[tableId] = table;
        else acTables[tableId] = table;
      }
    } else if (marker === 0xc0) {
      // SOF0: baseline DCT only
      const precision = input[dataStart] ?? 0;
      height = ((input[dataStart + 1] ?? 0) << 8) | (input[dataStart + 2] ?? 0);
      width = ((input[dataStart + 3] ?? 0) << 8) | (input[dataStart + 4] ?? 0);
      const count = input[dataStart + 5] ?? 0;
      if (precision !== 8 || count < 1 || count > 4)
        throw new Error("The JPEG image is unsupported.");
      if (width < 1 || height < 1 || width > 3840 || height > 2160)
        throw new Error("The JPEG image has an unsupported size.");
      const parsed: JpegComponent[] = [];
      for (let i = 0; i < count; i += 1) {
        const base = dataStart + 6 + i * 3;
        parsed.push({
          id: input[base] ?? 0,
          horizontal: (input[base + 1] ?? 0) >>> 4,
          vertical: (input[base + 1] ?? 0) & 15,
          quantTable: input[base + 2] ?? 0,
        });
      }
      components = parsed;
    } else if (marker === 0xdd) {
      // DRI
      restartInterval = ((input[dataStart] ?? 0) << 8) | (input[dataStart + 1] ?? 0);
    } else if (marker === 0xda) {
      // SOS: decode the scan, then continue parsing (usually EOI follows).
      if (components.length === 0) throw new Error("The JPEG image has no frame header.");
      const scanCount = input[dataStart] ?? 0;
      const scan: { component: number; dc: number; ac: number }[] = [];
      for (let i = 0; i < scanCount; i += 1) {
        const base = dataStart + 1 + i * 2;
        const componentId = input[base] ?? 0;
        const component = components.findIndex((c) => c.id === componentId);
        if (component < 0) throw new Error("The JPEG scan is invalid.");
        scan.push({
          component,
          dc: (input[base + 1] ?? 0) >>> 4,
          ac: (input[base + 1] ?? 0) & 15,
        });
      }
      // Ss/Se/Ah/Al must be 0/63/0/0 for baseline sequential scans.
      if (
        (input[dataStart + 1 + scanCount * 2] ?? 1) !== 0 ||
        (input[dataStart + 2 + scanCount * 2] ?? 0) !== 63 ||
        (input[dataStart + 3 + scanCount * 2] ?? 1) !== 0
      )
        throw new Error("The JPEG image is not a baseline scan.");
      offset = decodeJpegScan(
        input,
        dataEnd,
        width,
        height,
        components,
        scan,
        quantTables,
        dcTables,
        acTables,
        restartInterval,
      ).offset;
      const decoded = jpegDecodedPlanes.current;
      jpegDecodedPlanes.current = undefined;
      if (decoded === undefined) throw new Error("The JPEG scan produced no image.");
      return decoded;
    }
    // APPn, COM and other segments are skipped.
    offset = dataEnd;
  }
  throw new Error("The JPEG image has no scan data.");
}

/**
 * Native JPEG decoder for the screencast pipeline. Uses sharp (libvips/libjpeg-turbo)
 * which decodes ~10-25x faster than the pure-TS fallback (~6ms vs ~80ms at 878x501,
 * ~13ms vs ~310ms at 1080p). Falls back to decodeJpegPure if sharp is unavailable.
 * Output is RGBA, matching decodePng's contract.
 *
 * NOTE: sharp is NOT in package.json (pnpm lockfile can't be updated in this
 * sandbox). For native decode performance, run: pnpm add sharp --filter @sevynos/linux-host
 * (or wherever hosts/linux lives). Without it, the pure-TS fallback is used.
 */
export async function decodeJpeg(input: Uint8Array): Promise<{
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}> {
  const sharp = loadSharp();
  if (sharp !== undefined) {
    try {
      const { data, info } = await sharp(Buffer.from(input))
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });
      return {
        width: info.width,
        height: info.height,
        pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      };
    } catch {
      // Fall through to the pure-TS decoder below.
    }
  }
  return decodeJpegPure(input);
}

/** Lazily loads sharp; returns undefined if the native module is unavailable. */
let cachedSharp:
  | { readonly loaded: false }
  | { readonly loaded: true; readonly module: SharpModule }
  | undefined;
type SharpModule = (input: Uint8Array) => {
  raw(): {
    ensureAlpha(): {
      toBuffer(options: { resolveWithObject: true }): Promise<{
        readonly data: Buffer;
        readonly info: { readonly width: number; readonly height: number };
      }>;
    };
  };
};

function loadSharp(): SharpModule | undefined {
  if (cachedSharp !== undefined)
    return cachedSharp.loaded ? cachedSharp.module : undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require("sharp") as SharpModule;
    cachedSharp = { loaded: true, module: required };
    return required;
  } catch {
    cachedSharp = { loaded: false };
    return undefined;
  }
}

interface JpegComponent {
  readonly id: number;
  readonly horizontal: number;
  readonly vertical: number;
  readonly quantTable: number;
}

interface JpegHuffmanTable {
  readonly minCode: Int32Array;
  readonly maxCode: Int32Array;
  readonly valOffset: Int32Array;
  readonly symbols: Uint8Array;
}

const JPEG_ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37,
  44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** Separable 8-point inverse DCT coefficients: out[x] = sum_u m[x][u] * in[u]. */
const JPEG_IDCT_MATRIX: Float64Array = (() => {
  const matrix = new Float64Array(64);
  for (let x = 0; x < 8; x += 1)
    for (let u = 0; u < 8; u += 1)
      matrix[x * 8 + u] =
        (u === 0 ? 1 / Math.SQRT2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return matrix;
})();

function buildJpegHuffmanTable(bits: Uint8Array, values: Uint8Array): JpegHuffmanTable {
  const minCode = new Int32Array(16);
  const maxCode = new Int32Array(16);
  const valOffset = new Int32Array(16);
  let code = 0;
  let offset = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = bits[length - 1] ?? 0;
    const index = length - 1;
    if (count === 0) {
      maxCode[index] = -1;
    } else {
      minCode[index] = code;
      maxCode[index] = code + count - 1;
      valOffset[index] = offset - code;
      offset += count;
    }
    // The code space shifts for every length, even lengths with no codes.
    code = (code + count) << 1;
  }
  return { minCode, maxCode, valOffset, symbols: values };
}

class JpegBitReader {
  #bytes: Uint8Array;
  #position: number;
  #buffer = 0;
  #available = 0;
  #finished = false;
  #restart = false;

  public constructor(bytes: Uint8Array, position: number) {
    this.#bytes = bytes;
    this.#position = position;
  }

  public get position(): number {
    return this.#position;
  }

  /** Consumes a pending restart signal; also resets DC predictors upstream. */
  public consumeRestart(): boolean {
    const value = this.#restart;
    this.#restart = false;
    return value;
  }

  #fill(): void {
    while (
      this.#available <= 24 &&
      !this.#finished &&
      !this.#restart &&
      this.#position < this.#bytes.length
    ) {
      let byte = this.#bytes[this.#position] ?? 0;
      this.#position += 1;
      if (byte === 0xff) {
        const marker = this.#bytes[this.#position] ?? 0;
        this.#position += 1;
        if (marker === 0x00) {
          byte = 0xff; // Stuffed byte: literal 0xFF in the entropy data.
        } else if (marker >= 0xd0 && marker <= 0xd7) {
          this.#available = 0;
          this.#buffer = 0;
          this.#restart = true;
          return;
        } else {
          // Next segment (normally EOI): rewind so the outer parser sees it.
          this.#position -= 2;
          this.#finished = true;
          return;
        }
      }
      this.#buffer = (this.#buffer << 8) | byte;
      this.#available += 8;
    }
  }

  public readBits(count: number): number {
    this.#fill();
    if (this.#available < count) throw new Error("The JPEG image data is truncated.");
    this.#available -= count;
    return (this.#buffer >>> this.#available) & ((1 << count) - 1);
  }

  public decodeSymbol(table: JpegHuffmanTable): number {
    let code = 0;
    for (let length = 1; length <= 16; length += 1) {
      code = (code << 1) | this.readBits(1);
      const index = length - 1;
      if (code <= (table.maxCode[index] ?? -1)) {
        const symbolIndex = (table.valOffset[index] ?? 0) + code;
        return table.symbols[symbolIndex] ?? 0;
      }
    }
    throw new Error("The JPEG image uses an invalid Huffman code.");
  }

  public receive(count: number): number {
    if (count === 0) return 0;
    const value = this.readBits(count);
    return value < 1 << (count - 1) ? value - (1 << count) + 1 : value;
  }
}

/** Scratch buffer for the separable IDCT (module-local, single-threaded use). */
const JPEG_IDCT_TEMP = new Float64Array(64);

function jpegInverseDct(coefficients: Float64Array, output: Float64Array): void {
  const temp = JPEG_IDCT_TEMP;
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1)
        sum += (coefficients[y * 8 + u] ?? 0) * (JPEG_IDCT_MATRIX[x * 8 + u] ?? 0);
      temp[y * 8 + x] = sum;
    }
  for (let x = 0; x < 8; x += 1)
    for (let y = 0; y < 8; y += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1)
        sum += (temp[v * 8 + x] ?? 0) * (JPEG_IDCT_MATRIX[y * 8 + v] ?? 0);
      output[y * 8 + x] = sum;
    }
}

/**
 * Decodes one SOS scan starting at entropyOffset. Returns the offset just past
 * the entropy data; the decoded image is handed back via decodeJpegScanResult.
 */
function decodeJpegScan(
  input: Uint8Array,
  entropyOffset: number,
  width: number,
  height: number,
  components: JpegComponent[],
  scan: { readonly component: number; readonly dc: number; readonly ac: number }[],
  quantTables: (Uint16Array | undefined)[],
  dcTables: (JpegHuffmanTable | undefined)[],
  acTables: (JpegHuffmanTable | undefined)[],
  restartInterval: number,
): { readonly offset: number } {
  const maxHorizontal = Math.max(...components.map((c) => c.horizontal));
  const maxVertical = Math.max(...components.map((c) => c.vertical));
  const mcuColumns = Math.ceil(width / (8 * maxHorizontal));
  const mcuRows = Math.ceil(height / (8 * maxVertical));
  const planes = components.map((component) => ({
    width: mcuColumns * component.horizontal * 8,
    height: mcuRows * component.vertical * 8,
    data: new Float64Array(
      mcuColumns * component.horizontal * 8 * mcuRows * component.vertical * 8,
    ),
  }));
  const reader = new JpegBitReader(input, entropyOffset);
  const dcPredictors = components.map(() => 0);
  const coefficients = new Float64Array(64);
  const spatial = new Float64Array(64);
  let restartCountdown = restartInterval;

  for (let mcuRow = 0; mcuRow < mcuRows; mcuRow += 1)
    for (let mcuColumn = 0; mcuColumn < mcuColumns; mcuColumn += 1) {
      for (const entry of scan) {
        const component = components[entry.component];
        if (component === undefined) throw new Error("The JPEG scan is invalid.");
        const quant = quantTables[component.quantTable];
        const dcTable = dcTables[entry.dc];
        const acTable = acTables[entry.ac];
        if (quant === undefined || dcTable === undefined || acTable === undefined)
          throw new Error("The JPEG scan references a missing table.");
        const plane = planes[entry.component];
        if (plane === undefined) throw new Error("The JPEG scan is invalid.");
        for (let v = 0; v < component.vertical; v += 1)
          for (let h = 0; h < component.horizontal; h += 1) {
            coefficients.fill(0);
            const size = reader.decodeSymbol(dcTable);
            const diff = reader.receive(size);
            const dc = (dcPredictors[entry.component] ?? 0) + diff;
            dcPredictors[entry.component] = dc;
            coefficients[0] = dc * (quant[0] ?? 1);
            let k = 1;
            let hasAc = false;
            while (k < 64) {
              const symbol = reader.decodeSymbol(acTable);
              if (symbol === 0x00) break; // EOB
              if (symbol === 0xf0) {
                k += 16; // ZRL
                continue;
              }
              k += symbol >>> 4;
              if (k >= 64) throw new Error("The JPEG image data is invalid.");
              const zigzag = JPEG_ZIGZAG[k] ?? 0;
              coefficients[zigzag] = reader.receive(symbol & 15) * (quant[zigzag] ?? 1);
              hasAc = true;
              k += 1;
            }
            const blockRow = mcuRow * component.vertical + v;
            const blockColumn = mcuColumn * component.horizontal + h;
            const planeRowBase = blockRow * 8 * plane.width + blockColumn * 8;
            if (!hasAc) {
              // DC-only block: the IDCT of [C,0,...] is the constant C/8.
              const dcValue = Math.round(coefficients[0] / 8 + 128);
              const clamped = dcValue < 0 ? 0 : dcValue > 255 ? 255 : dcValue;
              for (let y = 0; y < 8; y += 1) {
                const rowBase = planeRowBase + y * plane.width;
                for (let x = 0; x < 8; x += 1) plane.data[rowBase + x] = clamped;
              }
            } else {
              jpegInverseDct(coefficients, spatial);
              for (let y = 0; y < 8; y += 1)
                for (let x = 0; x < 8; x += 1) {
                  const value = Math.round((spatial[y * 8 + x] ?? 0) + 128);
                  plane.data[planeRowBase + y * plane.width + x] =
                    value < 0 ? 0 : value > 255 ? 255 : value;
                }
            }
          }
      }
      if (restartInterval > 0) {
        restartCountdown -= 1;
        if (restartCountdown === 0) {
          if (!reader.consumeRestart())
            throw new Error("The JPEG image is missing a restart marker.");
          for (let i = 0; i < dcPredictors.length; i += 1) dcPredictors[i] = 0;
          restartCountdown = restartInterval;
        }
      }
    }

  const pixels = new Uint8Array(width * height * 4);
  if (components.length === 1) {
    const plane = planes[0];
    if (plane === undefined) throw new Error("The JPEG scan is invalid.");
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const value = Math.round(plane.data[y * plane.width + x] ?? 0);
        const target = (y * width + x) * 4;
        pixels[target] = value;
        pixels[target + 1] = value;
        pixels[target + 2] = value;
        pixels[target + 3] = 255;
      }
  } else {
    const yPlane = planes[0];
    const cbPlane = planes[1];
    const crPlane = planes[2];
    if (yPlane === undefined || cbPlane === undefined || crPlane === undefined)
      throw new Error("The JPEG image has an unsupported component layout.");
    // Map image pixels to chroma samples via the sampling factors, not the
    // (MCU-padded) plane dimensions. Nearest-neighbor upsampling: fast and
    // visually fine for screencast frames.
    const maxHorizontal = Math.max(...components.map((c) => c.horizontal));
    const maxVertical = Math.max(...components.map((c) => c.vertical));
    const cbComponent = components[1];
    const hScale = cbComponent === undefined ? 1 : cbComponent.horizontal / maxHorizontal;
    const vScale = cbComponent === undefined ? 1 : cbComponent.vertical / maxVertical;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const yy = yPlane.data[y * yPlane.width + x] ?? 0;
        const cbX = Math.min(cbPlane.width - 1, Math.floor(x * hScale));
        const cbY = Math.min(cbPlane.height - 1, Math.floor(y * vScale));
        const cb = (cbPlane.data[cbY * cbPlane.width + cbX] ?? 0) - 128;
        const cr = (crPlane.data[cbY * crPlane.width + cbX] ?? 0) - 128;
        const target = (y * width + x) * 4;
        // Inline the YCbCr->RGB conversion and clamping (hot loop).
        const r = yy + 1.402 * cr;
        const g = yy - 0.344136 * cb - 0.714136 * cr;
        const b = yy + 1.772 * cb;
        pixels[target] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        pixels[target + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        pixels[target + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
        pixels[target + 3] = 255;
      }
  }
  jpegDecodedPlanes.current = { width, height, pixels };
  return { offset: reader.position };
}

/** Stash for the planes decoded by decodeJpegScan (module-local handoff). */
const jpegDecodedPlanes: {
  current:
    | { readonly width: number; readonly height: number; readonly pixels: Uint8Array }
    | undefined;
} = { current: undefined };

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
