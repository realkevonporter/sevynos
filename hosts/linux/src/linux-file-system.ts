import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  rm,
  writeFile,
  rename,
  cp,
  lstat,
  realpath,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { FileSystemEntry, SevynFileSystem } from "@sevynos/react-native/internal";

export interface LinuxFileSystemOptions {
  readonly rootDirectory?: string;
  readonly defaultFiles?: boolean;
  readonly volumeService?: { isVolumePath(path: string): boolean } | undefined;
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".js": "text/javascript",
  ".jsx": "text/jsx",
  ".html": "text/html",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
});

export function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export class LinuxFileSystem implements SevynFileSystem {
  #root: string;
  #trashDir: string;
  #trashFilesDir: string;
  #trashInfoDir: string;
  #initialized = false;
  readonly #defaultFiles: boolean;
  readonly #volumeService: { isVolumePath(path: string): boolean } | undefined;

  public constructor(options: LinuxFileSystemOptions = {}) {
    this.#root = resolve(
      options.rootDirectory ??
        process.env["SEVYN_USER_DIRECTORY"] ??
        "/var/lib/sevynos/user",
    );
    this.#trashDir = join(this.#root, ".Trash");
    this.#trashFilesDir = join(this.#trashDir, "files");
    this.#trashInfoDir = join(this.#trashDir, "info");
    this.#defaultFiles = options.defaultFiles ?? true;
    this.#volumeService = options.volumeService;
  }

  public get rootDirectory(): string {
    return this.#root;
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      await this.#assertSafePath(this.#root);
      await mkdir(this.#root, { recursive: true });
      // Resolve symlinks in the root path so that realpath checks on child
      // paths match.  This handles platforms where the temp directory is a
      // symlink (e.g. macOS /tmp → /private/tmp).
      const resolvedRoot = await realpath(this.#root);
      if (resolvedRoot !== this.#root) {
        this.#root = resolvedRoot;
        this.#trashDir = join(this.#root, ".Trash");
        this.#trashFilesDir = join(this.#trashDir, "files");
        this.#trashInfoDir = join(this.#trashDir, "info");
      }
      for (const path of [
        "Desktop",
        "Documents",
        "Downloads",
        "Pictures",
        "Music",
        "Videos",
        ".Trash/files",
        ".Trash/info",
      ])
        await this.#assertSafePath(join(this.#root, path));
      await mkdir(join(this.#root, "Desktop"), { recursive: true });
      await mkdir(join(this.#root, "Documents"), { recursive: true });
      await mkdir(join(this.#root, "Downloads"), { recursive: true });
      await mkdir(join(this.#root, "Pictures"), { recursive: true });
      await mkdir(join(this.#root, "Music"), { recursive: true });
      await mkdir(join(this.#root, "Videos"), { recursive: true });
      await mkdir(this.#trashFilesDir, { recursive: true });
      await mkdir(this.#trashInfoDir, { recursive: true });

      const desktopFiles = await readdir(join(this.#root, "Desktop")).catch(
        (error: unknown) => {
          if (isCode(error, "ENOENT")) return [];
          throw error;
        },
      );
      if (this.#defaultFiles && desktopFiles.length === 0) {
        await writeFile(
          join(this.#root, "Desktop", "Welcome to SevynOS.txt"),
          "Welcome to SevynOS Genesis!\n\n" +
            "A sovereign personal computing operating system built with bare-metal Linux and React Native.\n\n" +
            "• Press Super / Sevyn Key or click ◇ on the dock to open Applications.\n" +
            "• Use Files to manage your local storage, documents, and pictures.\n" +
            "• Use Browser to navigate the web with full HTML/JS/CSS rendering.\n" +
            "• Connect to your Wi-Fi network in Settings or the top status bar.\n\n" +
            "Enjoy your sovereign desktop experience.",
          "utf8",
        );
        await writeFile(
          join(this.#root, "Desktop", "Notes.txt"),
          "My Notes\n========\n\n1. Customize desktop wallpaper in Settings.\n2. Pin favorite applications to the dock.\n3. Explore the file system in Files.\n",
          "utf8",
        );
      }

      const docFiles = await readdir(join(this.#root, "Documents")).catch(
        (error: unknown) => {
          if (isCode(error, "ENOENT")) return [];
          throw error;
        },
      );
      if (this.#defaultFiles && docFiles.length === 0) {
        await writeFile(
          join(this.#root, "Documents", "Getting Started.txt"),
          "SevynOS Getting Started Guide\n" +
            "=============================\n\n" +
            "SevynOS delivers a calm, high-performance desktop experience.\n" +
            "Hardware cursor planes and GPU DRM acceleration provide fluid 60+ FPS responsiveness.\n",
          "utf8",
        );
      }
    } catch (error) {
      throw new Error("Failed to initialize user storage: " + String(error));
    }
    this.#initialized = true;
  }

  public async list(path: string): Promise<readonly FileSystemEntry[]> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    try {
      const names = await readdir(resolved);
      const entries: FileSystemEntry[] = [];
      for (const name of names) {
        if (name.startsWith(".") && name !== ".Trash") continue;
        const entryPath = join(resolved, name);
        try {
          await this.#assertSafePath(entryPath);
          const s = await stat(entryPath);
          const isDir = s.isDirectory();
          const virtualPath = this.#toVirtualPath(entryPath);
          entries.push(
            Object.freeze({
              name,
              path: virtualPath,
              kind: isDir ? "directory" : "file",
              size: isDir ? 0 : s.size,
              modified: s.mtimeMs,
              mimeType: isDir ? undefined : detectMimeType(name),
            }),
          );
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw error;
        }
      }
      return Object.freeze(
        entries.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      );
    } catch (error) {
      throw new Error("Failed to list directory " + path + ": " + String(error));
    }
  }

  public async read(path: string): Promise<string> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    try {
      return await readFile(resolved, "utf8");
    } catch (error) {
      throw new Error("Failed to read file " + path + ": " + String(error));
    }
  }

  public async write(path: string, content: string): Promise<void> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");
    } catch (error) {
      throw new Error("Failed to write file " + path + ": " + String(error));
    }
  }

  public async createDirectory(path: string): Promise<void> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    try {
      await mkdir(resolved, { recursive: true });
    } catch (error) {
      throw new Error("Failed to create directory " + path + ": " + String(error));
    }
  }

  public async delete(path: string): Promise<void> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    if (resolved === this.#root) throw new Error("Cannot delete the root directory.");
    try {
      const s = await stat(resolved);
      if (s.isDirectory()) {
        await rm(resolved, { recursive: true, force: true });
      } else {
        await unlink(resolved);
      }
    } catch (error) {
      throw new Error("Failed to delete " + path + ": " + String(error));
    }
  }

  public async rename(fromPath: string, toPath: string): Promise<void> {
    await this.initialize();
    const resolvedFrom = await this.#resolvePath(fromPath);
    const resolvedTo = await this.#resolvePath(toPath);
    try {
      this.#assertMutablePath(resolvedFrom);
      this.#assertMutablePath(resolvedTo);
      await this.#assertSafePath(resolvedFrom);
      await this.#assertSafePath(resolvedTo);
      await this.#assertAbsent(resolvedTo);
      await mkdir(dirname(resolvedTo), { recursive: true });
      await rename(resolvedFrom, resolvedTo);
    } catch (error) {
      throw new Error(
        "Failed to rename " + fromPath + " to " + toPath + ": " + String(error),
      );
    }
  }

  public async copy(fromPath: string, toPath: string): Promise<void> {
    await this.initialize();
    const resolvedFrom = await this.#resolvePath(fromPath);
    const resolvedTo = await this.#resolvePath(toPath);
    try {
      this.#assertMutablePath(resolvedTo);
      await this.#assertSafeTree(resolvedFrom);
      await this.#assertSafePath(resolvedTo);
      await this.#assertAbsent(resolvedTo);
      await mkdir(dirname(resolvedTo), { recursive: true });
      await cp(resolvedFrom, resolvedTo, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } catch (error) {
      throw new Error(
        "Failed to copy " + fromPath + " to " + toPath + ": " + String(error),
      );
    }
  }

  public async stat(path: string): Promise<FileSystemEntry | undefined> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    try {
      const s = await stat(resolved);
      const isDir = s.isDirectory();
      return Object.freeze({
        name: basename(resolved),
        path: this.#toVirtualPath(resolved),
        kind: isDir ? "directory" : "file",
        size: isDir ? 0 : s.size,
        modified: s.mtimeMs,
        mimeType: isDir ? undefined : detectMimeType(resolved),
      });
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  public async moveToTrash(path: string): Promise<void> {
    await this.initialize();
    const resolved = await this.#resolvePath(path);
    this.#assertMutablePath(resolved);
    if (resolved === this.#trashDir || resolved.startsWith(this.#trashDir + sep))
      throw new Error("Cannot move Trash into itself.");
    await this.#assertSafePath(this.#trashFilesDir);
    await this.#assertSafePath(this.#trashInfoDir);
    // Reserve metadata exclusively before moving data. Duplicate basenames must
    // never replace an earlier deleted file, including concurrent requests.
    const originalName = basename(resolved);
    const ext = extname(originalName);
    const base = basename(originalName, ext);
    let name = originalName;
    for (let index = 0; ; index += 1) {
      name = index === 0 ? originalName : `${base}.${String(index)}${ext}`;
      const targetFile = join(this.#trashFilesDir, name);
      const targetInfo = join(this.#trashInfoDir, name + ".trashinfo");
      try {
        await this.#assertAbsent(targetFile);
        await writeFile(
          targetInfo,
          "[Trash Info]\nPath=" +
            encodeURIComponent(resolved) +
            "\nPathEncoding=percent\nDeletionDate=" +
            new Date().toISOString() +
            "\n",
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (isCode(error, "EEXIST")) continue;
        throw error;
      }
      try {
        await rename(resolved, targetFile);
      } catch (error) {
        await unlink(targetInfo);
        throw error;
      }
      return;
    }
  }

  public async listTrash(): Promise<readonly FileSystemEntry[]> {
    await this.initialize();
    await this.#assertSafePath(this.#trashFilesDir);
    const names = await readdir(this.#trashFilesDir);
    const entries: FileSystemEntry[] = [];
    for (const name of names) {
      const filePath = join(this.#trashFilesDir, name);
      await this.#assertSafePath(filePath);
      const s = await stat(filePath);
      entries.push(
        Object.freeze({
          name,
          path: "trash://" + name,
          kind: s.isDirectory() ? "directory" : "file",
          size: s.size,
          modified: s.mtimeMs,
          mimeType: detectMimeType(name),
        }),
      );
    }
    return Object.freeze(entries);
  }

  public async restoreFromTrash(name: string): Promise<void> {
    await this.initialize();
    if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
      throw new Error("Invalid Trash item name.");
    const targetFile = join(this.#trashFilesDir, name);
    const targetInfo = join(this.#trashInfoDir, name + ".trashinfo");
    await this.#assertSafePath(targetFile);
    await this.#assertSafePath(targetInfo);
    const info = await readFile(targetInfo, "utf8");
    const recordedPath = /^Path=(.+)$/m.exec(info)?.[1];
    if (!recordedPath) throw new Error("Trash metadata has no original path.");
    // Older records contain literal absolute paths. Do not silently reinterpret
    // their percent characters, or guess a destination for corrupt metadata.
    const originalPath = /^PathEncoding=percent$/m.test(info)
      ? decodeURIComponent(recordedPath)
      : recordedPath;
    this.#assertContained(originalPath);
    this.#assertMutablePath(originalPath);
    if (originalPath === this.#trashDir || originalPath.startsWith(this.#trashDir + sep))
      throw new Error("Cannot restore an item into Trash.");
    await this.#assertSafePath(originalPath);
    try {
      const real = await realpath(originalPath);
      this.#assertContained(real);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    await this.#assertAbsent(originalPath);
    await mkdir(dirname(originalPath), { recursive: true });
    await rename(targetFile, originalPath);
    await unlink(targetInfo);
  }

  public async emptyTrash(): Promise<void> {
    await this.initialize();
    await this.#assertSafePath(this.#trashFilesDir);
    await this.#assertSafePath(this.#trashInfoDir);
    // Delete each payload before its metadata. A failed deletion remains
    // recoverable and the caller receives the actual error.
    for (const name of await readdir(this.#trashFilesDir)) {
      await rm(join(this.#trashFilesDir, name), { recursive: true });
      await unlink(join(this.#trashInfoDir, name + ".trashinfo")).catch(
        (error: unknown) => {
          if (!isCode(error, "ENOENT")) throw error;
        },
      );
    }
  }

  async #resolvePath(virtualPath: string): Promise<string> {
    if (
      virtualPath.includes("\0") ||
      virtualPath.split(/[\\/]/).includes("..") ||
      /^[a-zA-Z]+:/.test(virtualPath)
    )
      throw new Error("Invalid filesystem path.");
    const candidate = resolve(this.#root, virtualPath.replace(/^\/+/, ""));
    this.#assertContained(candidate);
    await this.#assertSafePath(candidate);
    try {
      const real = await realpath(candidate);
      this.#assertContained(real);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    return candidate;
  }

  #assertContained(path: string): void {
    const candidate = resolve(path);
    if (candidate !== this.#root && !candidate.startsWith(this.#root + sep)) {
      // Allow removable volumes (USB drives) mounted under /media.
      if (this.#volumeService?.isVolumePath(candidate) === true) return;
      throw new Error("Path is outside user storage.");
    }
  }

  #assertMutablePath(path: string): void {
    if (path === this.#root) throw new Error("Cannot replace or remove user storage.");
  }

  async #assertSafePath(path: string): Promise<void> {
    this.#assertContained(path);
    // Reject symbolic links even when the final target currently lies inside
    // the root; do not follow a dangling link while creating a new file.
    let current = this.#root;
    const parts = relative(this.#root, path).split(sep).filter(Boolean);
    for (const part of ["", ...parts]) {
      if (part) current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symbolic links are not supported in user storage operations.");
      } catch (error) {
        if (isCode(error, "ENOENT")) return;
        throw error;
      }
    }
  }

  async #assertSafeTree(path: string): Promise<void> {
    await this.#assertSafePath(path);
    if ((await lstat(path)).isDirectory()) {
      for (const name of await readdir(path))
        await this.#assertSafeTree(join(path, name));
    }
  }

  async #assertAbsent(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    throw Object.assign(
      new Error("Destination already exists: " + this.#toVirtualPath(path)),
      { code: "EEXIST" },
    );
  }

  #toVirtualPath(systemPath: string): string {
    const relativePath = relative(this.#root, systemPath);
    return relativePath ? "/" + relativePath : "/";
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === code
  );
}
