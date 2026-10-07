/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Host-side archive service (Node.js): list, extract and create archives.
 * Supported formats: `.zip` (stored + deflate), `.tar`, `.tar.gz` / `.tgz`.
 * Extraction runs entirely in-process — `node:zlib` for DEFLATE/gzip plus
 * the pure-TS container parsers in this package — so no shell-out to
 * external tools is needed (and none is used).
 *
 * Safety: every entry name is validated against zip-slip (absolute paths
 * and `..` segments are rejected) and every extraction target is verified
 * to stay inside the destination directory. Tar symlinks/hardlinks are
 * skipped, never materialized. All paths are confined under `rootDirectory`
 * (defaults to the process working directory).
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";
import { dirname, join, resolve, sep } from "node:path";
import { crc32 } from "./crc32.js";
import { parseGzipHeader } from "./gzip.js";
import { parseTarArchive } from "./tar.js";
import { parseZipArchive, readZipEntryData } from "./zip.js";

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

export interface ArchiveEntryInfo {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly compressedSize?: number | undefined;
  readonly modified?: number | undefined;
}

export interface ArchiveProgress {
  readonly archivePath: string;
  readonly entriesDone: number;
  readonly entriesTotal: number;
  readonly currentEntry: string;
}

export type ArchiveProgressListener = (progress: ArchiveProgress) => void;

export interface ArchiveExtractResult {
  readonly entriesExtracted: number;
  readonly bytesWritten: number;
  readonly skipped: readonly string[];
}

/**
 * Service contract consumed by the File Manager UI. The app imports this
 * type only; the host injects a `FileArchiveService` (or another
 * implementation) bound to the app's storage root.
 */
export interface SevynArchiveService {
  listEntries(archivePath: string): Promise<readonly ArchiveEntryInfo[]>;
  extract(
    archivePath: string,
    destinationDir: string,
    onProgress?: ArchiveProgressListener,
  ): Promise<ArchiveExtractResult>;
}

export interface FileArchiveServiceOptions {
  /** All archive/destination paths are confined under this directory. */
  readonly rootDirectory?: string | undefined;
}

export function detectArchiveFormat(fileName: string): ArchiveFormat | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return undefined;
}

/** Reject zip-slip payloads: absolute paths and `..` segments. */
export function isSafeArchiveEntryName(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.startsWith("\\")) return false;
  // Directory entries conventionally end with "/".
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (trimmed === "") return false;
  const segments = trimmed.split("/");
  return !segments.includes("..") && !segments.some((segment) => segment === "");
}

export class FileArchiveService implements SevynArchiveService {
  readonly #root: string;

  public constructor(options?: FileArchiveServiceOptions) {
    this.#root = resolve(options?.rootDirectory ?? process.cwd());
  }

  #resolve(confinedPath: string): string {
    const target = resolve(this.#root, confinedPath);
    if (target !== this.#root && !target.startsWith(this.#root + sep)) {
      throw new Error(`Path escapes the archive root: ${confinedPath}`);
    }
    return target;
  }

  #resolveDestination(destinationDir: string, entryName: string): string {
    const base = this.#resolve(destinationDir);
    const target = resolve(base, entryName);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Archive entry escapes the destination: ${entryName}`);
    }
    return target;
  }

  public async listEntries(archivePath: string): Promise<readonly ArchiveEntryInfo[]> {
    const format = detectArchiveFormat(archivePath);
    if (format === undefined) {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }
    const bytes = await readFile(this.#resolve(archivePath));
    if (format === "zip") {
      return parseZipArchive(bytes).entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory ? "directory" : "file",
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        modified: entry.lastModified,
      }));
    }
    if (format === "tar.gz") parseGzipHeader(bytes); // validate framing first
    const tarBytes = format === "tar.gz" ? gunzipSync(bytes) : bytes;
    return parseTarArchive(tarBytes)
      .filter((entry) => entry.kind === "file" || entry.kind === "directory")
      .map((entry) => ({
        name: entry.name,
        kind: entry.kind === "directory" ? "directory" : "file",
        size: entry.size,
        modified: entry.mtime,
      }));
  }

  public async extract(
    archivePath: string,
    destinationDir: string,
    onProgress?: ArchiveProgressListener,
  ): Promise<ArchiveExtractResult> {
    const format = detectArchiveFormat(archivePath);
    if (format === undefined) {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }
    const bytes = await readFile(this.#resolve(archivePath));
    const destination = this.#resolve(destinationDir);
    await mkdir(destination, { recursive: true });

    const skipped: string[] = [];
    let entriesExtracted = 0;
    let bytesWritten = 0;

    const report = (entriesTotal: number, index: number, currentEntry: string): void => {
      onProgress?.({
        archivePath,
        entriesDone: index,
        entriesTotal,
        currentEntry,
      });
    };

    const writeEntry = async (
      name: string,
      isDirectory: boolean,
      payload: () => Promise<Uint8Array> | Uint8Array,
    ): Promise<void> => {
      if (!isSafeArchiveEntryName(name)) {
        throw new Error(`Unsafe archive entry name: ${name}`);
      }
      const target = this.#resolveDestination(destinationDir, name);
      if (isDirectory || name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        return;
      }
      const data = await payload();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      entriesExtracted += 1;
      bytesWritten += data.length;
    };

    if (format === "zip") {
      const archive = parseZipArchive(bytes);
      const inflate = (data: Uint8Array): Uint8Array => inflateRawSync(data);
      let index = 0;
      for (const entry of archive.entries) {
        index += 1;
        report(archive.entries.length, index, entry.name);
        if (entry.isDirectory) {
          await writeEntry(entry.name, true, () => new Uint8Array());
          continue;
        }
        await writeEntry(entry.name, false, () =>
          readZipEntryData(bytes, entry, inflate),
        );
      }
    } else {
      if (format === "tar.gz") parseGzipHeader(bytes);
      const tarBytes = format === "tar.gz" ? gunzipSync(bytes) : bytes;
      const entries = parseTarArchive(tarBytes);
      let index = 0;
      for (const entry of entries) {
        index += 1;
        report(entries.length, index, entry.name);
        if (entry.kind === "directory") {
          await writeEntry(entry.name, true, () => new Uint8Array());
          continue;
        }
        if (entry.kind !== "file") {
          skipped.push(`${entry.name} (${entry.kind} not extracted)`);
          continue;
        }
        const payload = tarBytes.subarray(
          entry.dataOffset,
          entry.dataOffset + entry.size,
        );
        await writeEntry(entry.name, false, () => payload);
      }
    }

    report(0, 0, "");
    return { entriesExtracted, bytesWritten, skipped };
  }

  /**
   * Create a `.zip` archive of `sourceDir` (relative to the root) at
   * `outPath` (relative to the root). Directory structure is preserved;
   * entries are written with UTF-8 names and DEFLATE compression.
   */
  public async createZip(
    sourceDir: string,
    outPath: string,
    onProgress?: ArchiveProgressListener,
  ): Promise<void> {
    const source = this.#resolve(sourceDir);
    const out = this.#resolve(outPath);
    const files: { relative: string; absolute: string; directory: boolean }[] = [];
    const walk = async (dir: string, relativeBase: string): Promise<void> => {
      const dirents = await readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of dirents) {
        const absolute = join(dir, dirent.name);
        const relative = relativeBase ? `${relativeBase}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          files.push({ relative: `${relative}/`, absolute, directory: true });
          await walk(absolute, relative);
        } else if (dirent.isFile()) {
          files.push({ relative, absolute, directory: false });
        }
        // Symlinks and special files are skipped: archives must not
        // smuggle links out of (or into) user storage.
      }
    };
    await walk(source, "");

    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const encoder = new TextEncoder();
    const push = (part: Uint8Array): void => {
      chunks.push(part);
      offset += part.length;
    };

    const dosTime = (mtimeMs: number): { time: number; date: number } => {
      const d = new Date(mtimeMs);
      return {
        time:
          (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        date:
          ((d.getUTCFullYear() - 1980) << 9) |
          ((d.getUTCMonth() + 1) << 5) |
          d.getUTCDate(),
      };
    };

    let index = 0;
    for (const file of files) {
      index += 1;
      onProgress?.({
        archivePath: outPath,
        entriesDone: index,
        entriesTotal: files.length,
        currentEntry: file.relative,
      });
      const nameBytes = encoder.encode(file.relative);
      const content = file.directory ? new Uint8Array() : await readFile(file.absolute);
      const compressed = file.directory ? content : deflateRawSync(content);
      const { time, date } = dosTime((await stat(file.absolute)).mtimeMs);
      const headerOffset = offset;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x800, true); // UTF-8 names
      local.setUint16(8, file.directory ? 0 : 8, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc32(content), true);
      local.setUint32(18, compressed.length, true);
      local.setUint32(22, content.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      push(new Uint8Array(local.buffer));
      push(nameBytes);
      push(compressed);

      const centralHeader = new DataView(new ArrayBuffer(46));
      centralHeader.setUint32(0, 0x02014b50, true);
      centralHeader.setUint16(4, 20, true);
      centralHeader.setUint16(6, 20, true);
      centralHeader.setUint16(8, 0x800, true);
      centralHeader.setUint16(10, file.directory ? 0 : 8, true);
      centralHeader.setUint16(12, time, true);
      centralHeader.setUint16(14, date, true);
      centralHeader.setUint32(16, crc32(content), true);
      centralHeader.setUint32(20, compressed.length, true);
      centralHeader.setUint32(24, content.length, true);
      centralHeader.setUint16(28, nameBytes.length, true);
      centralHeader.setUint32(42, headerOffset, true);
      central.push(new Uint8Array(centralHeader.buffer));
      central.push(nameBytes);
    }

    const centralStart = offset;
    for (const part of central) push(part);
    const centralSize = offset - centralStart;

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, centralStart, true);
    push(new Uint8Array(eocd.buffer));

    const total = offset;
    const archive = new Uint8Array(total);
    let at = 0;
    for (const part of chunks) {
      archive.set(part, at);
      at += part.length;
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, archive);
    onProgress?.({
      archivePath: outPath,
      entriesDone: 0,
      entriesTotal: 0,
      currentEntry: "",
    });
  }
}
