/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Re-roots a SevynFileSystem at a per-user subdirectory so every application
 * sees the current user's home as its filesystem root:
 *
 *   inner.list("/Documents")  ->  scoped.list("/Documents")
 *                                  (reads <root>/users/<name>/Documents)
 *
 * Returned entry paths are translated back to home-relative virtual paths,
 * so applications keep working with the paths they already use. When the
 * scope is undefined the decorator is a transparent passthrough (the legacy
 * single-user live session behaves exactly as today).
 */

import type { FileSystemEntry, SevynFileSystem } from "@sevynos/react-native/internal";

function normalizeVirtualPath(path: string): string {
  const stripped = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped === "" ? "/" : `/${stripped}`;
}

export class UserScopedFileSystem implements SevynFileSystem {
  readonly #inner: SevynFileSystem;
  readonly #scopeDir: string;

  /**
   * @param inner the host filesystem (rooted at the shared user-data dir).
   * @param scopeDir the home subdirectory relative to the inner root,
   *   e.g. "users/kevon". Leading/trailing slashes are tolerated.
   */
  public constructor(inner: SevynFileSystem, scopeDir: string) {
    this.#inner = inner;
    this.#scopeDir = scopeDir.replace(/^\/+/, "").replace(/\/+$/, "");
    if (this.#scopeDir === "" || this.#scopeDir.split("/").includes("..")) {
      throw new Error(`Invalid user filesystem scope: "${scopeDir}".`);
    }
  }

  public get scopeDir(): string {
    return this.#scopeDir;
  }

  #scoped(path: string): string {
    const normalized = normalizeVirtualPath(path);
    if (normalized === "/") return `/${this.#scopeDir}`;
    return `/${this.#scopeDir}${normalized}`;
  }

  #unscoped(path: string): string {
    const prefix = `/${this.#scopeDir}`;
    if (path === prefix) return "/";
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
    return path;
  }

  #unscopedEntry(entry: FileSystemEntry): FileSystemEntry {
    const unscopedPath = this.#unscoped(entry.path);
    if (unscopedPath === entry.path) return entry;
    return Object.freeze({ ...entry, path: unscopedPath });
  }

  public async list(path: string): Promise<readonly FileSystemEntry[]> {
    const entries = await this.#inner.list(this.#scoped(path));
    return Object.freeze(entries.map((entry) => this.#unscopedEntry(entry)));
  }

  public read(path: string): Promise<string> {
    return this.#inner.read(this.#scoped(path));
  }

  public write(path: string, content: string): Promise<void> {
    return this.#inner.write(this.#scoped(path), content);
  }

  public createDirectory(path: string): Promise<void> {
    return this.#inner.createDirectory(this.#scoped(path));
  }

  public async delete(path: string): Promise<void> {
    if (this.#inner.delete === undefined) {
      throw new Error("The underlying filesystem does not support delete.");
    }
    await this.#inner.delete(this.#scoped(path));
  }

  public async rename(fromPath: string, toPath: string): Promise<void> {
    if (this.#inner.rename === undefined) {
      throw new Error("The underlying filesystem does not support rename.");
    }
    await this.#inner.rename(this.#scoped(fromPath), this.#scoped(toPath));
  }

  public async copy(fromPath: string, toPath: string): Promise<void> {
    if (this.#inner.copy === undefined) {
      throw new Error("The underlying filesystem does not support copy.");
    }
    await this.#inner.copy(this.#scoped(fromPath), this.#scoped(toPath));
  }

  public async stat(path: string): Promise<FileSystemEntry | undefined> {
    if (this.#inner.stat === undefined) return undefined;
    const entry = await this.#inner.stat(this.#scoped(path));
    return entry === undefined ? undefined : this.#unscopedEntry(entry);
  }

  public async moveToTrash(path: string): Promise<void> {
    if (this.#inner.moveToTrash === undefined) {
      throw new Error("The underlying filesystem does not support trash.");
    }
    await this.#inner.moveToTrash(this.#scoped(path));
  }

  public async listTrash(): Promise<readonly FileSystemEntry[]> {
    if (this.#inner.listTrash === undefined) return Object.freeze([]);
    const entries = await this.#inner.listTrash();
    return Object.freeze(entries.map((entry) => this.#unscopedEntry(entry)));
  }

  public restoreFromTrash(name: string): Promise<void> {
    if (this.#inner.restoreFromTrash === undefined) {
      throw new Error("The underlying filesystem does not support trash.");
    }
    // Restore targets are recorded by the underlying filesystem with the
    // scoped path, so no translation is needed here.
    return this.#inner.restoreFromTrash(name);
  }

  public emptyTrash(): Promise<void> {
    if (this.#inner.emptyTrash === undefined) {
      throw new Error("The underlying filesystem does not support trash.");
    }
    return this.#inner.emptyTrash();
  }
}
