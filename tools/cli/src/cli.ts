#!/usr/bin/env node
import { resolve } from "node:path";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildProject,
  createApplication,
  runDoctor,
  validateProject,
  writePackage,
  packSevynBundle,
  installApp,
  uninstallApp,
  listApps,
} from "./index.js";

const CLI_VERSION = "0.1.0";

interface InstalledAppRecord {
  name: string;
  id: string;
  version: string;
  system: boolean;
  permissions: string[];
}

const installApplication = installApp as unknown as (
  bundleOrId: string,
) => Promise<InstalledAppRecord>;

const packApplication = packSevynBundle;

const uninstallApplication = uninstallApp;

const listApplications = listApps as unknown as () => Promise<InstalledAppRecord[]>;

function printHelp(): void {
  console.log(`
SevynOS Developer CLI (v${CLI_VERSION})
Usage: sevyn <command> [options] [arguments]

Commands:
  create <target> [id] [name]   Create a new SevynOS application starter
  dev, run-sevynos [project]    Run application in live development host with watch
  build [project]               Build and compile Hermes bytecode bundle
  validate [project]            Validate application manifest and structure
  pack, package [project]       Package application into a .sevyn bundle
  install <bundle-or-id>        Install application (.sevyn bundle or stock app ID)
  uninstall <app-id>            Uninstall an application (protected apps blocked)
  list, apps                    List all installed applications and permissions
  doctor                        Run environment health and diagnostics checks
  metro [bundle]                Start Metro bundler server or bundle entrypoint
  help, --help, -h              Show this help message
  version, --version, -v        Display SevynOS CLI version

Examples:
  sevyn create ./my-app org.example.myapp "My App"
  sevyn dev ./my-app
  sevyn build ./my-app
  sevyn pack ./my-app
  sevyn install ./dist/application.sevyn
  sevyn list
  sevyn doctor
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const target = args[1] ?? ".";
  const id = args[2] ?? "org.sevynos.starter";
  const nameParts = args.slice(3);
  const project = resolve(target);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`SevynOS CLI v${CLI_VERSION}`);
    return;
  }

  switch (command) {
    case "create": {
      const appName = nameParts.length > 0 ? nameParts.join(" ") : "Sevyn Application";
      await createApplication(project, id, appName);
      console.log(`✓ Created Sevyn application '${id}' at ${project}`);
      break;
    }

    case "dev":
    case "run-sevynos": {
      if (
        process.env["SEVYN_PRODUCTION"] === "1" ||
        process.env["NODE_ENV"] === "production"
      ) {
        console.error(
          "Developer host commands are disabled on production SevynOS images.",
        );
        process.exit(1);
      }
      await validateProject(project);
      await buildProject(project);
      const developmentPackage = await writePackage(project);
      console.log(`Watching ${project}; live package: ${developmentPackage}`);
      {
        let rebuilding = false;
        let queued = false;
        const rebuild = async (): Promise<void> => {
          if (rebuilding) {
            queued = true;
            return;
          }
          rebuilding = true;
          try {
            await buildProject(project);
            await writePackage(project, developmentPackage);
            console.log("Updated SevynOS development application.");
          } catch (error) {
            console.error(error instanceof Error ? error.message : "Build failed.");
          } finally {
            rebuilding = false;
            if (queued) {
              queued = false;
              void rebuild();
            }
          }
        };
        watch(resolve(project, "src"), { recursive: true }, () => {
          void rebuild();
        });
        const cliDir =
          typeof import.meta.dirname === "string"
            ? import.meta.dirname
            : fileURLToPath(new URL(".", import.meta.url));
        const workspaceRoot = resolve(cliDir, "../../..");
        const desktop = spawn("pnpm", ["--filter", "@sevynos/desktop-host", "dev"], {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            SEVYN_DEV_APPLICATION_PACKAGE: developmentPackage,
          },
          stdio: "inherit",
        });
        await new Promise<void>((resolveExit, rejectExit) => {
          desktop.once("error", rejectExit);
          desktop.once("exit", (code) => {
            if (code === 0 || code === null) resolveExit();
            else
              rejectExit(new Error(`SevynOS desktop exited with code ${String(code)}.`));
          });
        });
      }
      break;
    }

    case "build":
      await buildProject(project);
      console.log(`✓ Successfully built ${project}`);
      break;

    case "validate":
      await validateProject(project);
      console.log(`✓ Project manifest and structure in ${project} are valid.`);
      break;

    case "pack":
    case "package": {
      const bundlePath = await packApplication(project);
      console.log(`✓ Successfully packaged Sevyn bundle: ${bundlePath}`);
      break;
    }

    case "install": {
      const bundleOrId = target;
      if (!bundleOrId || bundleOrId === ".") {
        console.error("Usage: sevyn install <bundle-path-or-app-id>");
        process.exit(1);
      }
      const record = await installApplication(bundleOrId);
      console.log(
        `✓ Successfully installed ${record.name} (${record.id} v${record.version}) [protected: ${record.system ? "true" : "false"}]`,
      );
      break;
    }

    case "uninstall": {
      const appId = target;
      if (!appId || appId === ".") {
        console.error("Usage: sevyn uninstall <app-id>");
        process.exit(1);
      }
      await uninstallApplication(appId);
      console.log(`✓ Successfully uninstalled ${appId}`);
      break;
    }

    case "list":
    case "apps": {
      const apps = await listApplications();
      if (apps.length === 0) {
        console.log("No applications installed.");
      } else {
        console.log(`Installed Applications (${String(apps.length)}):`);
        for (const app of apps) {
          const protectedTag = app.system ? "[PROTECTED]" : "[deletable]";
          const permissionsTag =
            app.permissions.length > 0
              ? `(permissions: ${app.permissions.join(", ")})`
              : "(no permissions)";
          console.log(
            `  • ${app.name} (${app.id} v${app.version}) ${protectedTag} ${permissionsTag}`,
          );
        }
      }
      break;
    }

    case "doctor": {
      const report = await runDoctor();
      console.log(`SevynOS CLI Doctor — Status: ${report.status.toUpperCase()}`);
      for (const check of report.checks) {
        console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.message}`);
      }
      break;
    }

    case "metro": {
      const subCmd = target;
      if (subCmd === "bundle") {
        const { bundleWithMetro } = await import("@sevynos/metro");
        const entryIndex = args.indexOf("--entry-file");
        const outIndex = args.includes("--bundle-output")
          ? args.indexOf("--bundle-output")
          : args.indexOf("--out");
        const projectIndex = args.indexOf("--project-root");
        const entryFlag = entryIndex !== -1 ? args[entryIndex + 1] : undefined;
        const outFlag = outIndex !== -1 ? args[outIndex + 1] : undefined;
        const projectFlag = projectIndex !== -1 ? args[projectIndex + 1] : undefined;
        const entry = entryFlag ?? (id !== "org.sevynos.starter" ? id : "src/index.ts");
        const out = outFlag ?? nameParts[0] ?? "dist/index.bundle.js";
        const projectRoot = projectFlag ? resolve(process.cwd(), projectFlag) : undefined;
        console.log(`⚡ Bundling ${entry} with Metro -> ${out}...`);
        await bundleWithMetro({
          entryFile: entry,
          out,
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        });
        console.log(`✓ Successfully generated Metro bundle at ${out}`);
      } else {
        const { startMetroServer } = await import("@sevynos/metro");
        await startMetroServer();
      }
      break;
    }

    default:
      console.error(
        `Unknown command: '${command}'\nType 'sevyn help' for available commands.`,
      );
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
