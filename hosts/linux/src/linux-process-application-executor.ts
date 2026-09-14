import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ApplicationWorkerDescriptor,
  ApplicationWorkerExecutor,
  ApplicationWorkerTransport,
  HostWorkerMessage,
} from "@sevynos/react-native/internal";

export interface LinuxApplicationProcess {
  readonly stdin: { write(value: string): boolean; end(): void };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type LinuxApplicationProcessFactory = (
  executable: string,
  argumentsValue: readonly string[],
  environment: Readonly<Record<string, string>>,
) => LinuxApplicationProcess;

class ProcessWorkerTransport implements ApplicationWorkerTransport {
  readonly #messages = new Set<(message: unknown) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #lines;
  #terminated = false;
  public constructor(
    readonly process: LinuxApplicationProcess,
    readonly maximumMessageBytes: number,
    readonly cleanup: () => Promise<void> = () => Promise.resolve(),
  ) {
    this.#lines = createInterface({ input: process.stdout });
    this.#lines.on("line", (line) => {
      if (Buffer.byteLength(line, "utf8") > maximumMessageBytes) {
        this.emitError(new Error("Application process message exceeds the size limit."));
        return;
      }
      try {
        const message: unknown = JSON.parse(line);
        for (const listener of this.#messages) listener(message);
      } catch {
        this.emitError(new Error("Application process emitted malformed JSON."));
      }
    });
    process.once("error", (error) => {
      this.emitError(error);
    });
    process.once("exit", (code, signal) => {
      void this.cleanup();
      if (!this.#terminated)
        this.emitError(
          new Error(
            `Application process exited (${String(code ?? signal ?? "unknown")}).`,
          ),
        );
    });
  }
  public post(message: HostWorkerMessage): void {
    if (this.#terminated) throw new Error("Application process is terminated.");
    const processMessage =
      message.type === "initialize" ? { ...message, bundleSource: "" } : message;
    const encoded = `${JSON.stringify(processMessage)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maximumMessageBytes)
      throw new Error("Host message exceeds the process IPC size limit.");
    this.process.stdin.write(encoded);
  }
  public subscribe(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener);
    return () => {
      this.#messages.delete(listener);
    };
  }
  public subscribeError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => {
      this.#errors.delete(listener);
    };
  }
  public async terminate(reason: string): Promise<void> {
    void reason;
    if (this.#terminated) return;
    this.#terminated = true;
    this.#lines.close();
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.#messages.clear();
    this.#errors.clear();
    await this.cleanup();
  }
  private emitError(error: Error): void {
    for (const listener of this.#errors) listener(error);
  }
}

export class NativeLinuxProcessApplicationExecutor implements ApplicationWorkerExecutor {
  public readonly isolation = "process" as const;
  readonly #factory: LinuxApplicationProcessFactory;
  public constructor(
    readonly runner = fileURLToPath(
      new URL("./third-party-application-process.js", import.meta.url),
    ),
    factory: LinuxApplicationProcessFactory = (executable, argumentsValue, environment) =>
      spawn(executable, argumentsValue, {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    readonly maximumMessageBytes = 256 * 1024,
  ) {
    this.#factory = factory;
  }
  public async create(
    descriptor: ApplicationWorkerDescriptor,
  ): Promise<ApplicationWorkerTransport> {
    const bundle =
      descriptor.applicationPackage.files[
        descriptor.applicationPackage.manifest.entrypoint
      ];
    if (bundle === undefined)
      throw new Error("Application package entrypoint is missing.");
    const directory = await mkdtemp(join(tmpdir(), "sevyn-application-"));
    const bundlePath = join(directory, "index.bundle.js");
    await writeFile(bundlePath, bundle, { encoding: "utf8", mode: 0o600 });
    const environment: Readonly<Record<string, string>> = Object.freeze({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      NODE_ENV: "production",
      SEVYN_APPLICATION_ID: descriptor.applicationId,
      SEVYN_SESSION_ID: descriptor.sessionId,
      SEVYN_APPLICATION_KEY: descriptor.applicationPackage.manifest.applicationKey,
      SEVYN_APPLICATION_BUNDLE: bundlePath,
    });
    try {
      const child = this.#factory(process.execPath, [this.runner], environment);
      return new ProcessWorkerTransport(child, this.maximumMessageBytes, () =>
        rm(directory, { recursive: true, force: true }),
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

export class HermesLinuxProcessApplicationExecutor implements ApplicationWorkerExecutor {
  public readonly isolation = "process" as const;
  readonly #factory: LinuxApplicationProcessFactory;
  public constructor(
    readonly executable = "/usr/local/bin/sevyn-hermes-host",
    readonly runtimeBytecode = "/opt/sevynos/hermes-application-runtime.hbc",
    factory: LinuxApplicationProcessFactory = (command, argumentsValue, environment) =>
      spawn(command, argumentsValue, {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    readonly maximumMessageBytes = 256 * 1024,
  ) {
    this.#factory = factory;
  }
  public async create(
    descriptor: ApplicationWorkerDescriptor,
  ): Promise<ApplicationWorkerTransport> {
    const entrypoint = descriptor.applicationPackage.manifest.entrypoint;
    const bytecode = descriptor.applicationPackage.files[`${entrypoint}.hbc`];
    const source = descriptor.applicationPackage.files[entrypoint];
    if (bytecode === undefined && source === undefined)
      throw new Error("Application package executable is missing.");
    const directory = await mkdtemp(join(tmpdir(), "sevyn-hermes-application-"));
    const bytecodePath = join(
      directory,
      bytecode === undefined ? "application.js" : "application.hbc",
    );
    await writeFile(
      bytecodePath,
      bytecode === undefined ? (source ?? "") : Buffer.from(bytecode, "base64"),
      { mode: 0o600 },
    );
    const environment = Object.freeze({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      SEVYN_APPLICATION_ID: descriptor.applicationId,
      SEVYN_SESSION_ID: descriptor.sessionId,
    });
    try {
      const child = this.#factory(
        this.executable,
        [this.runtimeBytecode, bytecodePath],
        environment,
      );
      return new ProcessWorkerTransport(child, this.maximumMessageBytes, () =>
        rm(directory, { recursive: true, force: true }),
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
