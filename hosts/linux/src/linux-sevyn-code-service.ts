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
import { existsSync, appendFileSync } from "node:fs";
import { ChromiumBrowserEngine } from "./chromium-browser-engine.js";

/**
 * Emit a marker to stdout and mirror to the serial console (if present),
 * matching the Genesis marker behavior in wayland.ts. Direct console.log
 * alone is not visible on the QEMU serial console.
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
   * On failure, any partially-started resources are cleaned up.
   */
  public async start(): Promise<void> {
    if (this.#started) return;

    try {
      // 1. Launch code-server bound to localhost only
      emitServiceMarker("SEVYN_CODE_SERVICE_STARTING_CODE_SERVER");
      await this.#startCodeServer();
      emitServiceMarker("SEVYN_CODE_SERVICE_CODE_SERVER_READY");

      // 2. Launch Chromium pointing at code-server with screencast enabled
      const url = `http://127.0.0.1:${String(this.#port)}/`;
      emitServiceMarker("SEVYN_CODE_SERVICE_STARTING_CHROMIUM");
      this.#engine = new ChromiumBrowserEngine({
        ...(this.#options.chromiumExecutable
          ? { executable: this.#options.chromiumExecutable }
          : {}),
        screencast: true,
        // JPEG quality for the workbench stream. 90 keeps text sharp;
        // lower values show visible compression smearing on glyph edges.
        // Bandwidth is irrelevant (loopback only); the cost is slightly
        // larger frames over the CDP pipe and a bit more decode CPU.
        screencastQuality: 90,
      });
      await this.#engine.navigate(url);
      emitServiceMarker("SEVYN_CODE_SERVICE_CHROMIUM_NAVIGATED");
      await this.#engine.startScreencast();
      emitServiceMarker("SEVYN_CODE_SERVICE_SCREENCAST_STARTED");

      this.#started = true;
      emitServiceMarker("SEVYN_CODE_SERVICE_READY");
    } catch (error) {
      // Clean up partial startup so nothing leaks
      await this.#cleanup();
      throw error;
    }
  }

  /** Stop code-server and Chromium, releasing all resources. */
  public async stop(): Promise<void> {
    if (!this.#started && !this.#engine && !this.#codeServer) return;
    await this.#cleanup();
    this.#started = false;
  }

  async #cleanup(): Promise<void> {
    if (this.#engine) {
      await this.#engine.stopScreencast().catch(() => undefined);
      await this.#engine.close().catch(() => undefined);
      this.#engine = undefined;
    }

    if (this.#codeServer) {
      this.#codeServer.kill("SIGTERM");
      this.#codeServer = undefined;
    }
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
    // Use the real path, not the /usr/local/bin symlink — the code-server
    // wrapper script resolves its bundled node binary relative to $0, and
    // the symlink makes it look in /usr/local/lib instead of /opt/code-server/lib.
    const binary =
      this.#options.codeServerBinary ??
      process.env["SEVYN_CODE_SERVER_BIN"] ??
      "/opt/code-server/bin/code-server";

    // Pre-flight check: verify the binary exists and is executable
    try {
      const { existsSync, accessSync, constants } = await import("node:fs");
      if (!existsSync(binary)) {
        throw new Error(`code-server binary not found at ${binary}`);
      }
      accessSync(binary, constants.X_OK);
    } catch (error) {
      throw new Error(
        `code-server binary check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Wait for 127.0.0.1 to become available — the loopback interface may not
    // be configured yet when Genesis starts services during early boot.
    // Try binding a test socket; EADDRNOTAVAIL means loopback isn't ready.
    await this.#waitForLoopback(15000);

    const dataDir =
      this.#options.codeServerDataDir ??
      process.env["SEVYN_CODE_SERVER_DATA"] ??
      "/var/lib/sevyn/code-server";

    const workspaceDir =
      this.#options.workspaceDir ??
      process.env["SEVYN_CODE_WORKSPACE"] ??
      "/home/user/Projects";

    // First-run setup: install default settings, create the workspace,
    // and seed a welcome README so the IDE never opens on an empty void.
    await this.#firstRunSetup(dataDir, workspaceDir);

    const args = [
      "--bind-addr",
      `127.0.0.1:${String(this.#port)}`,
      "--auth",
      "none",
      "--disable-telemetry",
      "--disable-update-check",
    ];

    args.push("--user-data-dir", dataDir);
    args.push(workspaceDir);

    this.#codeServer = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // code-server picks up VS Code settings from the user data dir
      },
    });

    // Attach error/exit handlers immediately — spawn failures (ENOENT)
    // surface as async 'error' events, not synchronous throws.
    await new Promise<void>((resolve, reject) => {
      const child = this.#codeServer;
      if (!child) {
        reject(new Error("code-server failed to spawn"));
        return;
      }
      const onError = (error: Error): void => {
        this.#codeServer = undefined;
        reject(error);
      };
      // Capture stderr for diagnostics if code-server fails to start
      let stderrOutput = "";
      child.stderr?.on("data", (data: Buffer) => {
        stderrOutput += data.toString();
        // Keep only the last 2KB to avoid memory bloat
        if (stderrOutput.length > 2048) {
          stderrOutput = stderrOutput.slice(-2048);
        }
      });
      const onExit = (code: number | null): void => {
        this.#codeServer = undefined;
        if (code !== 0 && code !== null) {
          const details = stderrOutput.trim()
            ? ` stderr: ${stderrOutput.trim().slice(0, 500)}`
            : "";
          reject(new Error(`code-server exited with code ${String(code)}.${details}`));
        }
      };
      child.once("error", onError);
      child.once("exit", onExit);
      // Wait for code-server to be ready (poll the root path; with
      // --auth none there is no /login page)
      this.#waitForPort(this.#port, 30000).then(
        () => {
          child.off("error", onError);
          child.off("exit", onExit);
          // From here on, unexpected exits just clear the handle;
          // the service owner should call stop() and inspect status()
          child.on("error", () => {
            this.#codeServer = undefined;
          });
          child.on("exit", () => {
            this.#codeServer = undefined;
          });
          resolve();
        },
        (error: unknown) => {
          child.off("error", onError);
          child.off("exit", onExit);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async #waitForPort(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/`);
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

  async #waitForLoopback(timeoutMs: number): Promise<void> {
    const { createServer } = await import("node:net");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Try to bring up loopback explicitly — the minimal init may not do it.
    // This is idempotent: safe to run even if lo is already up.
    try {
      await execFileAsync("ip", ["link", "set", "lo", "up"]);
      await execFileAsync("ip", ["addr", "add", "127.0.0.1/8", "dev", "lo"]);
    } catch {
      // Best effort — the interface may already be configured, or `ip`
      // may not be available. Fall through to the bind test below.
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            resolve();
          });
        });
        server.close();
        return; // 127.0.0.1 is available
      } catch (error) {
        // EADDRNOTAVAIL means loopback isn't configured yet — retry
        if (error instanceof Error && "code" in error && error.code !== "EADDRNOTAVAIL") {
          throw error;
        }
      } finally {
        server.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`127.0.0.1 was not available within ${String(timeoutMs)}ms`);
  }

  /**
   * First-run setup: install the default VS Code settings (terminal profile,
   * Open VSX, theme) from /etc/sevyn, create the workspace directory, and
   * seed a welcome README so the IDE never opens on an empty void.
   *
   * Existing user settings are never overwritten — this only seeds defaults
   * that are missing.
   */
  async #firstRunSetup(dataDir: string, workspaceDir: string): Promise<void> {
    const fs = await import("node:fs");
    const path = await import("node:path");

    // 1. Install default settings if the user hasn't customized them yet.
    try {
      const userDir = path.join(dataDir, "User");
      fs.mkdirSync(userDir, { recursive: true });
      const dest = path.join(userDir, "settings.json");
      if (!fs.existsSync(dest)) {
        const src = "/etc/sevyn/code-server-settings.json";
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }
    } catch {
      // Best effort — code-server runs fine with stock settings.
    }

    // 2. Create the workspace directory.
    try {
      fs.mkdirSync(workspaceDir, { recursive: true });
    } catch {
      // If we can't create it, code-server will report the error.
      return;
    }

    // 3. Seed a welcome README in an empty workspace.
    try {
      const entries = fs.readdirSync(workspaceDir);
      if (entries.length > 0) return;

      const readme = `# Welcome to Sevyn Code

Sevyn Code is the SevynOS integrated development environment — a full
code editor running right on your device.

## Things to try

- **Open a terminal** (Ctrl+\` or via the Terminal menu) and run \`sevyn\`.
  The terminal runs the Sevyn CLI — there is no Linux shell here, everything
  goes through SevynOS. Try \`sevyn system info\` or \`sevyn apps info\`.
- **Install extensions** from the Extensions view. Extensions come from
  [Open VSX](https://open-vsx.org), the open extension registry.
- **Start a project** — create a folder in this workspace for your code.

## Building SevynOS apps

SevynOS apps are written in React Native and TypeScript, then bundled into
\`.sevyn\` packages (a manifest, compiled Hermes bytecode, and assets).
Install them with \`sevyn apps install <bundle>\`.

Happy building.
`;
      fs.writeFileSync(path.join(workspaceDir, "README.md"), readme);
    } catch {
      // Best effort — an empty workspace still works.
    }

    // 4. Hand ownership to the user account when possible.
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("chown", ["-R", "user:user", dataDir, workspaceDir]);
    } catch {
      // Best effort — may already be owned correctly or chown unavailable.
    }
  }
}
