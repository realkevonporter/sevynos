/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pure-TypeScript tar container parser (no Node APIs). Handles v7, ustar
 * and POSIX archives, GNU longname (`L`) records, and pax extended headers
 * (`x` per-entry, `g` global). Header checksums are verified; a bad checksum
 * is a corrupt archive, not a guess.
 */

export interface TarEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  /** File payload size in bytes (0 for directories). */
  readonly size: number;
  readonly mode: number;
  /** Epoch milliseconds, when the header mtime is valid. */
  readonly mtime: number | undefined;
  /** Symlink/hardlink target. */
  readonly linkname: string;
  /** Offset of the entry's raw payload inside the archive. */
  readonly dataOffset: number;
}

const BLOCK = 512;

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  const bytes = end === -1 ? slice : slice.subarray(0, end);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Corrupt tar archive: invalid octal field.");
  }
  return value;
}

/**
 * Parse pax extended-header records. Each record is
 * `<decimal-length> <keyword>=<value>\n`.
 */
function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    const equals = line.indexOf("=", space + 1);
    if (space === -1 || equals === -1) continue;
    records.set(line.slice(space + 1, equals), line.slice(equals + 1));
  }
  return records;
}

function verifyChecksum(block: Uint8Array): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = block[i] ?? 0;
    // The checksum field itself counts as eight spaces.
    sum += i >= 148 && i < 156 ? 32 : byte;
  }
  if (sum !== readOctal(block, 148, 8)) {
    throw new Error("Corrupt tar archive: header checksum mismatch.");
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

export function parseTarArchive(bytes: Uint8Array): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let gnuLongName: string | undefined;
  let paxPath: string | undefined;
  let globalPaxPath: string | undefined;

  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) break; // end-of-archive marker
    verifyChecksum(block);

    const typeflag = String.fromCharCode(block[156] ?? 0);
    const size = readOctal(block, 124, 12);
    const dataOffset = offset + BLOCK;
    const dataEnd = dataOffset + size;
    if (dataEnd > bytes.length) {
      throw new Error("Corrupt tar archive: entry payload exceeds archive size.");
    }
    const payload = bytes.subarray(dataOffset, dataEnd);

    if (typeflag === "L") {
      // GNU longname: payload names the next entry.
      gnuLongName = readString(payload, 0, size);
    } else if (typeflag === "x" || typeflag === "g") {
      const path = parsePaxRecords(payload).get("path");
      if (typeflag === "g") {
        globalPaxPath = path ?? globalPaxPath;
      } else {
        paxPath = path;
      }
    } else {
      const rawName = readString(block, 0, 100);
      const prefix = readString(block, 345, 155);
      const headerName = prefix ? `${prefix}/${rawName}` : rawName;
      const kind =
        typeflag === "5"
          ? "directory"
          : typeflag === "2"
            ? "symlink"
            : typeflag === "0" || typeflag === "\0"
              ? "file"
              : "other";
      const mtimeSeconds = readOctal(block, 136, 12);
      entries.push({
        name: gnuLongName ?? paxPath ?? globalPaxPath ?? headerName,
        kind,
        size,
        mode: readOctal(block, 100, 8),
        mtime: mtimeSeconds > 0 ? mtimeSeconds * 1000 : undefined,
        linkname: readString(block, 157, 100),
        dataOffset,
      });
      // Per-entry overrides are consumed.
      gnuLongName = undefined;
      paxPath = undefined;
    }

    offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
