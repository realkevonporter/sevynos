/**
 * Sevyn Code host service — manages the code-server backend and its
 * Chromium screencast pipeline.
 *
 * Architecture:
 *   code-server (127.0.0.1:8080) → Chromium (headless, CDP screencast)
 *     → ChromiumBrowserEngine → Sevyn Code app (pixels + input)
 *
 * code-server is bound to localhost only and never exposed to the network.
 * The SevynOS host streams the workbench via CDP screencast; the app
 * displays pixels and forwards input events back through the engine.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ChromiumBrowserEngine } from "./chromium-browser-engine.js";

export interface SevynCodeServiceOptions {
  readonly codeServerBinary?: string;
  readonly codeServerPort?: number;
  readonly codeServerDataDir?: string;
  readonly chromiumExecutable?: string;
  readonly workspaceDir?: string;
}

export interface SevynCodeStatus {
  readonly running: boolean;
  readonly codeServerPort?: number | undefined;
  readonly url?: string | undefined;
}

/**
 * Manages the Sevyn Code backend: code-server + headless Chromium.
 * The ChromiumBrowserEngine is exposed so the Sevyn Code app can
 * subscribe to frames and forward input.
 */
export class LinuxSevynCodeService {
  readonly #options: SevynCodeServiceOptions;
  #codeServer: ChildProcess | undefined;
  #engine: ChromiumBrowserEngine | undefined;
  #port: number;
  #started = false;

  public constructor(options: SevynCodeServiceOptions = {}) {
    this.#options = options;
    this.#port = options.codeServerPort ?? 8080;
  }

  /**
   * Start code-server and the Chromium screencast pipeline.
   * Resolves when the workbench is streaming frames.
   */
  public async start(): Promise<void> {
    if (this.#started) return;

    // 1. Launch code-server bound to localhost only
    await this.#startCodeServer();

    // 2. Launch Chromium pointing at code-server with screencast enabled
    const url = `http://127.0.0.1:${String(this.#port)}/`;
    this.#engine = new ChromiumBrowserEngine({
      ...(this.#options.chromiumExecutable
        ? { executable: this.#options.chromiumExecutable }
        : {}),
      screencast: true,
      screencastQuality: 80,
    });
    await this.#engine.navigate(url);
    await this.#engine.startScreencast();

    this.#started = true;
  }

  /** Stop code-server and Chromium, releasing all resources. */
  public async stop(): Promise<void> {
    if (!this.#started) return;

    if (this.#engine) {
      await this.#engine.stopScreencast().catch(() => undefined);
      await this.#engine.close().catch(() => undefined);
      this.#engine = undefined;
    }

    if (this.#codeServer) {
      this.#codeServer.kill("SIGTERM");
      this.#codeServer = undefined;
    }

    this.#started = false;
  }

  /** The browser engine streaming the workbench. Undefined until start() resolves. */
  public get engine(): ChromiumBrowserEngine | undefined {
    return this.#engine;
  }

  public status(): SevynCodeStatus {
    if (!this.#started) return { running: false };
    return {
      running: true,
      codeServerPort: this.#port,
      url: `http://127.0.0.1:${String(this.#port)}/`,
    };
  }

  async #startCodeServer(): Promise<void> {
    const binary =
      this.#options.codeServerBinary ??
      process.env["SEVYN_CODE_SERVER_BIN"] ??
      "/usr/local/bin/code-server";

    const args = [
      "--bind-addr",
      `127.0.0.1:${String(this.#port)}`,
      "--auth",
      "none",
      "--disable-telemetry",
      "--disable-update-check",
    ];

    const dataDir =
      this.#options.codeServerDataDir ??
      process.env["SEVYN_CODE_SERVER_DATA"] ??
      "/var/lib/sevyn/code-server";
    args.push("--user-data-dir", dataDir);

    const workspaceDir =
      this.#options.workspaceDir ??
      process.env["SEVYN_CODE_WORKSPACE"] ??
      "/home/user/Projects";
    args.push(workspaceDir);

    this.#codeServer = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // code-server picks up VS Code settings from the user data dir
      },
    });

    // Wait for code-server to be ready (poll the port)
    await this.#waitForPort(this.#port, 30000);

    this.#codeServer.on("error", () => {
      // The service owner should call stop() and inspect status()
      this.#codeServer = undefined;
    });
    this.#codeServer.on("exit", () => {
      this.#codeServer = undefined;
    });
  }

  async #waitForPort(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/login`);
        // Any HTTP response (even a redirect) means the server is up
        if (response.status < 500) return;
      } catch {
        // Not ready yet — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `code-server did not become ready on port ${String(port)} within ${String(timeoutMs)}ms`,
    );
  }
}
