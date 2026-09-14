import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LinuxStudioBuildService } from "./linux-studio-service.js";

describe("LinuxStudioBuildService", () => {
  it("passes a build request to the host builder and validates its result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sevyn-studio-service-test-"));
    const command = join(directory, "builder.sh");
    await writeFile(
      command,
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\' \'{"bundle":"bundle","bytecodeBase64":"aGJj","packageJson":"{}","diagnostics":["ok"]}\'\n',
      "utf8",
    );
    await chmod(command, 0o755);
    try {
      const result = await new LinuxStudioBuildService({ command }).build({
        applicationId: "org.sevynos.user.test",
        applicationName: "Test",
        source: "export default function App() { return null; }",
      });
      expect(result.bundle).toBe("bundle");
      expect(result.bytecodeBase64).toBe("aGJj");
      expect(result.diagnostics).toEqual(["ok"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a builder failure instead of reporting a false success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sevyn-studio-service-test-"));
    const command = join(directory, "builder.sh");
    await writeFile(command, "#!/bin/sh\necho compile-error >&2\nexit 1\n", "utf8");
    await chmod(command, 0o755);
    try {
      await expect(
        new LinuxStudioBuildService({ command }).build({
          applicationId: "org.sevynos.user.test",
          applicationName: "Test",
          source: "export default function App() { return null; }",
        }),
      ).rejects.toThrow("compile-error");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
