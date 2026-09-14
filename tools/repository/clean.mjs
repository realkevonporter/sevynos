import { lstat, readdir, readFile, rm, unlink } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);

if (manifest.name !== "sevynos") {
  throw new Error("Cleanup refused: the repository root could not be verified.");
}

const generatedDirectories = [
  ".cache",
  ".expo",
  ".next",
  ".parcel-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "DerivedData",
  "dist",
  "generated",
  "node_modules",
  "out",
  "Pods",
  "release",
  "target",
];

const protectedDirectories = new Set([".git", "third_party"]);
const generatedFile =
  /(?:^\.DS_Store$|\.(?:AppImage|blockmap|dmg|iso|log|out|temp|tmp|tsbuildinfo)$)/;
let removed = 0;

await cleanDirectory(repositoryRoot);
console.log(`Removed ${String(removed)} generated path${removed === 1 ? "" : "s"}.`);

async function cleanDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assertInsideRepository(path);

    if (protectedDirectories.has(entry.name)) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (generatedDirectories.includes(entry.name)) {
        await removePath(path);
      } else {
        await cleanDirectory(path);
      }
      continue;
    }

    if (entry.isFile() && generatedFile.test(entry.name)) {
      await unlink(path);
      removed += 1;
    }
  }
}

async function removePath(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Cleanup refused to traverse symbolic link: ${path}`);
  }
  await rm(path, { recursive: true });
  removed += 1;
}

function assertInsideRepository(path) {
  if (path === repositoryRoot || !path.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error(`Cleanup refused path outside the repository: ${path}`);
  }
  if (basename(repositoryRoot) !== "SevynOS") {
    throw new Error("Cleanup refused an unexpected repository directory.");
  }
}
