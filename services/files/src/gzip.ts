/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pure-TypeScript gzip header parser (no Node APIs). Validates the magic,
 * method and header flags, and extracts the embedded name/mtime. Payload
 * inflation is left to the host (`node:zlib` verifies each member's
 * CRC-32/ISIZE trailer during decompression).
 */

export interface GzipHeader {
  /** Length of the header in bytes (start of the DEFLATE stream). */
  readonly headerLength: number;
  readonly name: string | undefined;
  /** Epoch milliseconds, when MTIME is set. */
  readonly mtime: number | undefined;
}

const MAGIC_0 = 0x1f;
const MAGIC_1 = 0x8b;
const METHOD_DEFLATE = 8;

const FLAG_FHCRC = 0x02;
const FLAG_FEXTRA = 0x04;
const FLAG_FNAME = 0x08;
const FLAG_FCOMMENT = 0x10;

function readCString(bytes: Uint8Array, offset: number): { text: string; next: number } {
  const end = bytes.indexOf(0, offset);
  const stop = end === -1 ? bytes.length : end;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(offset, stop),
  );
  return { text, next: stop + 1 };
}

/** Parse (and validate) the gzip header at `offset`. */
export function parseGzipHeader(bytes: Uint8Array, offset = 0): GzipHeader {
  if (offset + 10 > bytes.length) {
    throw new Error("Corrupt gzip stream: truncated header.");
  }
  if (bytes[offset] !== MAGIC_0 || bytes[offset + 1] !== MAGIC_1) {
    throw new Error("Not a gzip stream: bad magic bytes.");
  }
  if (bytes[offset + 2] !== METHOD_DEFLATE) {
    throw new Error("Unsupported gzip compression method.");
  }
  const flags = bytes[offset + 3] ?? 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const mtime = view.getUint32(offset + 4, true);
  let at = offset + 10;

  if ((flags & FLAG_FEXTRA) !== 0) {
    if (at + 2 > bytes.length) throw new Error("Corrupt gzip stream.");
    at += 2 + view.getUint16(at, true);
  }
  let name: string | undefined;
  if ((flags & FLAG_FNAME) !== 0) {
    const parsed = readCString(bytes, at);
    name = parsed.text;
    at = parsed.next;
  }
  if ((flags & FLAG_FCOMMENT) !== 0) {
    at = readCString(bytes, at).next;
  }
  if ((flags & FLAG_FHCRC) !== 0) at += 2;
  if (at > bytes.length) throw new Error("Corrupt gzip stream: truncated header.");

  return {
    headerLength: at - offset,
    name,
    mtime: mtime > 0 ? mtime * 1000 : undefined,
  };
}

/** True when `bytes` starts with a gzip header. */
export function isGzipStream(bytes: Uint8Array): boolean {
  try {
    parseGzipHeader(bytes);
    return true;
  } catch {
    return false;
  }
}
