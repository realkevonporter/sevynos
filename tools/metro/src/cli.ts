#!/usr/bin/env node
import { resolve } from "node:path";
import { getSevynMetroConfig, bundleWithMetro } from "./index.js";

const [command = "start", ...args] = process.argv.slice(2);

switch (command) {
  case "start": {
    const Metro = (await import("metro")).default;
    const projectRoot = process.cwd();
    const config = await getSevynMetroConfig(projectRoot);
    console.log("⚡ Starting SevynOS Metro Bundler on port 8081...");
    await Metro.runServer(config as any, {
      waitForBundler: true,
    });
    console.log("✓ Metro Bundler ready at http://localhost:8081");
    break;
  }
  case "bundle": {
    const entryIndex = args.indexOf("--entry-file");
    const outIndex = args.indexOf("--bundle-output");
    const projectIndex = args.indexOf("--project-root");
    const entry = entryIndex !== -1 ? args[entryIndex + 1]! : "src/index.ts";
    const out = outIndex !== -1 ? args[outIndex + 1]! : "dist/index.bundle.js";
    const projectRoot =
      projectIndex !== -1
        ? resolve(process.cwd(), args[projectIndex + 1]!)
        : process.cwd();
    console.log(`⚡ Bundling ${entry} with Metro -> ${out}...`);
    await bundleWithMetro({ projectRoot, entryFile: entry, out });
    console.log(`✓ Successfully generated Metro bundle at ${out}`);
    break;
  }
  default:
    console.log("Usage: sevyn-metro [start|bundle]");
    process.exit(1);
}
