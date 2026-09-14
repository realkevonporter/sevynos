import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProject,
  createApplication,
  createCliInstaller,
  installApp,
  listApps,
  packageProject,
  packSevynBundle,
  runDoctor,
  uninstallApp,
  validateProject,
} from "./index.js";

describe("sevyn developer CLI", () => {
  it("creates, validates, builds, and packages a public-API starter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sevyn-cli-"));
    await createApplication(directory, "org.sevynos.sample", "Sample Application");
    await expect(validateProject(directory)).resolves.toBeUndefined();

    const source = await readFile(join(directory, "src/index.ts"), "utf8");
    expect(source).toContain('from "react-native"');
    expect(source).toContain("AppRegistry.registerComponent");
    expect(source).not.toMatch(/internal|electron|node:/i);

    await buildProject(directory);
    const bundle = await readFile(join(directory, "dist/index.js"), "utf8");
    const bytecode = await readFile(join(directory, "dist/index.hbc"));
    expect(bundle).not.toContain("export const Application = () =>");
    expect(bundle).toContain("__SEVYN_MODULES__");
    expect(bundle).toContain("registerComponent");
    expect(bytecode.byteLength).toBeGreaterThan(100);

    const applicationPackage = await packageProject(directory);
    expect(applicationPackage.manifest.id).toBe("org.sevynos.sample");
    expect(applicationPackage.integrity.packageHash).toHaveLength(64);
    expect(applicationPackage.files["dist/index.js.hbc"]).toBeDefined();
  }, 20_000);

  it("runs doctor diagnostics and reports environment health", async () => {
    const report = await runDoctor();
    expect(report.sevynVersion).toBe("0.1.0");
    expect(report.platform).toBe(process.platform);
    expect(report.status).toMatch(/healthy|warning/);
    expect(report.checks.length).toBeGreaterThanOrEqual(3);
  });

  it("builds a .sevyn bundle, installs it, lists it, and uninstalls it", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "sevyn-cli-pack-"));
    const appsDir = await mkdtemp(join(tmpdir(), "sevyn-cli-apps-"));
    const pristineDir = await mkdtemp(join(tmpdir(), "sevyn-cli-pristine-"));

    await createApplication(projectDir, "org.sevynos.calculator", "Calculator App");
    await buildProject(projectDir);

    const bundlePath = await packSevynBundle(projectDir);
    expect(bundlePath).toContain(".sevyn");
    const bundleBytes = await readFile(bundlePath);
    expect(bundleBytes.length).toBeGreaterThan(100);

    // Install bundle
    const installed = await installApp(bundlePath, { appsDir, pristineDir });
    expect(installed.id).toBe("org.sevynos.calculator");
    expect(installed.name).toBe("Calculator App");

    // List apps
    let list = await listApps({ appsDir, pristineDir });
    expect(list.some((a) => a.id === "org.sevynos.calculator")).toBe(true);

    // Uninstall
    await uninstallApp("org.sevynos.calculator", { appsDir, pristineDir });
    list = await listApps({ appsDir, pristineDir });
    expect(list.some((a) => a.id === "org.sevynos.calculator")).toBe(false);
  }, 25_000);

  it("handles stock app uninstall and reinstall from pristine", async () => {
    const appsDir = await mkdtemp(join(tmpdir(), "sevyn-cli-apps-pristine-"));
    const pristineDir = await mkdtemp(join(tmpdir(), "sevyn-cli-pristine-dir-"));

    // Install notes from pristine
    const installed = await installApp("notes", { appsDir, pristineDir });
    expect(installed.id).toBe("org.sevynos.notes");
    expect(installed.system).toBe(false);

    // Uninstall notes
    await uninstallApp("org.sevynos.notes", { appsDir, pristineDir });
    const list = await listApps({ appsDir, pristineDir });
    expect(list.some((a) => a.id === "org.sevynos.notes")).toBe(false);

    // Reinstall notes from pristine
    const reinstalled = await installApp("notes", { appsDir, pristineDir });
    expect(reinstalled.id).toBe("org.sevynos.notes");
  });

  it("refuses to uninstall protected system apps (shell, terminal) with a clear error", async () => {
    const appsDir = await mkdtemp(join(tmpdir(), "sevyn-cli-apps-prot-"));
    const pristineDir = await mkdtemp(join(tmpdir(), "sevyn-cli-pristine-prot-"));

    // Install terminal and shell
    await installApp("terminal", { appsDir, pristineDir });
    await installApp("shell", { appsDir, pristineDir });

    await expect(
      uninstallApp("org.sevynos.terminal", { appsDir, pristineDir }),
    ).rejects.toThrow(/Cannot uninstall protected system application/);

    await expect(
      uninstallApp("org.sevynos.shell", { appsDir, pristineDir }),
    ).rejects.toThrow(/Cannot uninstall protected system application/);
  });

  it("defaults to safe user directory on macOS or non-root environments", async () => {
    const installer = createCliInstaller();
    await installer.init();
    expect(installer.appsDirectory).toBeDefined();
    expect(installer.pristineDirectory).toBeDefined();
    const list = await installer.listInstalled();
    expect(Array.isArray(list)).toBe(true);
  });
});
