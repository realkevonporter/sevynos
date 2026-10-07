/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pure-TypeScript zip container parser (no Node APIs — safe to run in any
 * JS runtime). Supports stored (method 0) and deflate (method 8) entries;
 * the raw DEFLATE inflater is injected by the caller so the host can use
 * `node:zlib` while the parser itself stays portable.
 *
 * Explicitly rejected with clear errors: encrypted entries, zip64, and
 * multi-disk archives.
 */

import { crc32 } from "./crc32.js";

export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Epoch milliseconds, when the DOS timestamp is valid. */
  readonly lastModified: number | undefined;
  /** Offset of the entry's raw (compressed) data inside the archive. */
  readonly dataOffset: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
}

/** Inflate a raw DEFLATE stream (no zlib header/adler32). */
export type DeflateInflater = (data: Uint8Array) => Uint8Array;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;

const FLAG_ENCRYPTED = 0x1;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function dosDateTimeToEpoch(date: number, time: number): number | undefined {
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  const second = (time & 0x1f) * 2;
  const minute = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return undefined;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function decodeName(bytes: Uint8Array): string {
  // Zip names are UTF-8 or legacy CP437; decode leniently as UTF-8 so a
  // single bad byte cannot break the whole listing.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Locate the end-of-central-directory record by scanning backwards from the
 * end of the archive (the record may be followed by a variable-length
 * comment, up to 64 KiB).
 */
function findEocd(data: DataView, length: number): number {
  const scanStart = Math.max(0, length - 22 - 65535);
  for (let offset = length - 22; offset >= scanStart; offset -= 1) {
    if (data.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    if (offset + 4 <= length && data.getUint32(offset, true) === ZIP64_EOCD_LOCATOR) {
      throw new Error("zip64 archives are not supported.");
    }
    return offset;
  }
  throw new Error("Not a zip archive: end-of-central-directory not found.");
}

export function parseZipArchive(bytes: Uint8Array): ZipArchive {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const eocd = findEocd(data, bytes.length);
  const diskNumber = data.getUint16(eocd + 4, true);
  const centralDisk = data.getUint16(eocd + 6, true);
  const centralCount = data.getUint16(eocd + 8, true);
  const centralSize = data.getUint32(eocd + 12, true);
  const centralOffset = data.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error("Multi-disk zip archives are not supported.");
  }
  if (
    centralCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("zip64 archives are not supported.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < centralCount; i += 1) {
    if (data.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt zip archive: bad central directory entry ${String(i)}.`);
    }
    const flags = data.getUint16(offset + 8, true);
    const method = data.getUint16(offset + 10, true);
    const time = data.getUint16(offset + 12, true);
    const date = data.getUint16(offset + 14, true);
    const entryCrc = data.getUint32(offset + 16, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const uncompressedSize = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localHeaderOffset = data.getUint32(offset + 42, true);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error("zip64 archives are not supported.");
    }
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error("Encrypted zip entries are not supported.");
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new Error(`Unsupported zip compression method ${String(method)}.`);
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeName(nameBytes);

    const dataOffset = resolveDataOffset(data, bytes.length, localHeaderOffset);
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
      lastModified: dosDateTimeToEpoch(date, time),
      dataOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries };
}

/** Read the local file header to find where an entry's data starts. */
function resolveDataOffset(
  data: DataView,
  length: number,
  localHeaderOffset: number,
): number {
  if (data.getUint32(localHeaderOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error("Corrupt zip archive: bad local file header.");
  }
  const nameLength = data.getUint16(localHeaderOffset + 26, true);
  const extraLength = data.getUint16(localHeaderOffset + 28, true);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset > length) {
    throw new Error("Corrupt zip archive: entry data outside the archive.");
  }
  return dataOffset;
}

/**
 * Extract one entry's bytes, verifying the CRC-32. Entries written with a
 * data descriptor (flag bit 3) still carry real sizes in the central
 * directory, which is what this parser reads.
 */
export function readZipEntryData(
  bytes: Uint8Array,
  entry: ZipEntry,
  inflateRaw: DeflateInflater,
): Uint8Array {
  let raw: Uint8Array;
  if (entry.method === METHOD_STORED) {
    raw = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  } else {
    const compressed = bytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    );
    raw = inflateRaw(compressed);
  }
  if (raw.length !== entry.uncompressedSize) {
    throw new Error(`Corrupt zip entry "${entry.name}": size mismatch after extraction.`);
  }
  if (crc32(raw) !== entry.crc32) {
    throw new Error(
      `Corrupt zip entry "${entry.name}": checksum mismatch after extraction.`,
    );
  }
  return raw.slice();
}
