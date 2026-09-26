import { spawn } from "node:child_process";
import type {
  SevynStudioBuildRequest,
  SevynStudioBuildResult,
  SevynStudioService,
} from "@sevynos/react-native/internal";

export interface LinuxStudioBuildServiceOptions {
  readonly command?: string;
}

export class LinuxStudioBuildService implements SevynStudioService {
  readonly #command: string;

  public constructor(options: LinuxStudioBuildServiceOptions = {}) {
    this.#command =
      options.command ??
      process.env["SEVYN_STUDIO_BUILDER"] ??
      "/usr/local/bin/sevyn-studio-build";
  }

  public build(request: SevynStudioBuildRequest): Promise<SevynStudioBuildResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SEVYN_STUDIO_BUILD: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        reject(new Error(`Sevyn Studio builder could not start: ${error.message}`));
      });
      child.once("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              stderr.trim() || `Sevyn Studio builder exited with code ${String(code)}.`,
            ),
          );
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout);
          if (!isBuildResult(result))
            throw new Error("Builder returned an invalid result.");
          resolve(result);
        } catch (error) {
          reject(
            new Error(`Sevyn Studio builder returned invalid output: ${String(error)}`),
          );
        }
      });
      // A builder that fails fast may exit before reading stdin; without
      // this listener the resulting EPIPE becomes an uncaught exception
      // instead of the close handler's rejection above.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE")
          console.error(`Sevyn Studio builder stdin failed: ${error.message}`);
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

function isBuildResult(value: unknown): value is SevynStudioBuildResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["bundle"] === "string" &&
    typeof record["bytecodeBase64"] === "string" &&
    typeof record["packageJson"] === "string" &&
    Array.isArray(record["diagnostics"]) &&
    record["diagnostics"].every((entry) => typeof entry === "string")
  );
}
