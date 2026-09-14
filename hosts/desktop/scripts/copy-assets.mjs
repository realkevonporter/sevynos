import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

const packageDirectory = resolve(currentDirectory, "..");

const outputDirectory = resolve(packageDirectory, "dist");

await mkdir(outputDirectory, {
  recursive: true,
});

await copyFile(
  resolve(packageDirectory, "src", "index.html"),
  resolve(outputDirectory, "index.html"),
);

const buildResources = resolve(packageDirectory, "build-resources");
await mkdir(buildResources, { recursive: true });
await copyFile(
  resolve(
    packageDirectory,
    "..",
    "..",
    "shell",
    "mobile",
    "ios",
    "SevynOS",
    "Images.xcassets",
    "AppIcon.appiconset",
    "App-Icon-1024x1024@1x.png",
  ),
  resolve(buildResources, "icon.png"),
);
