/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Independent fixture builders for the archive tests. These construct zip
 * and tar archives by hand (headers written field-by-field) so the parser
 * tests do not depend on the service under test.
 */

import { deflateRawSync } from "node:zlib";
import { crc32 } from "./crc32.js";

const textEncoder = new TextEncoder();

export interface TestZipEntryInput {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method?: 0 | 8;
  readonly encrypted?: boolean;
}

/** Build a minimal zip (local headers + central directory + EOCD). */
export function buildTestZip(entries: readonly TestZipEntryInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (part: Uint8Array): void => {
    chunks.push(part);
    offset += part.length;
  };

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const headerOffset = offset;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, (entry.encrypted ? 0x1 : 0) | 0x800, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc32(entry.data), true);
    local.setUint32(18, compressed.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    push(new Uint8Array(local.buffer));
    push(nameBytes);
    push(compressed);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, (entry.encrypted ? 0x1 : 0) | 0x800, true);
    record.setUint16(10, method, true);
    record.setUint32(16, crc32(entry.data), true);
    record.setUint32(20, compressed.length, true);
    record.setUint32(24, entry.data.length, true);
    record.setUint16(28, nameBytes.length, true);
    record.setUint32(42, headerOffset, true);
    central.push(new Uint8Array(record.buffer));
    central.push(nameBytes);
  }

  const centralStart = offset;
  for (const part of central) push(part);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, offset - centralStart, true);
  eocd.setUint32(16, centralStart, true);
  push(new Uint8Array(eocd.buffer));

  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface TestTarEntryInput {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly directory?: boolean;
  readonly symlink?: string;
}

function writeOctal(
  block: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < text.length; i += 1) {
    block[offset + i] = text.charCodeAt(i);
  }
}

/** Build a tar archive; names over 100 chars use GNU longname records. */
export function buildTestTar(entries: readonly TestTarEntryInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];

  const pushHeader = (
    name: string,
    size: number,
    typeflag: string,
    linkname = "",
  ): void => {
    const block = new Uint8Array(512);
    const nameBytes = textEncoder.encode(name);
    block.set(nameBytes.subarray(0, 100), 0);
    writeOctal(block, 100, 8, typeflag === "5" ? 0o755 : 0o644);
    writeOctal(block, 124, 12, size);
    writeOctal(block, 136, 12, 1_700_000_000);
    block[156] = typeflag.charCodeAt(0);
    const linkBytes = textEncoder.encode(linkname);
    block.set(linkBytes.subarray(0, 100), 157);
    const magic = textEncoder.encode("ustar ");
    block.set(magic, 257);
    // Checksum with the checksum field treated as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
    const sumText = sum.toString(8).padStart(6, "0");
    for (let i = 0; i < 6; i += 1) block[148 + i] = sumText.charCodeAt(i);
    block[154] = 0;
    block[155] = 32;
    chunks.push(block);
  };

  const pushData = (data: Uint8Array): void => {
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  };

  for (const entry of entries) {
    if (entry.name.length > 100) {
      const longName = textEncoder.encode(entry.name);
      pushHeader("././@LongLink", longName.length, "L");
      pushData(longName);
    }
    if (entry.symlink !== undefined) {
      pushHeader(entry.name, 0, "2", entry.symlink);
    } else if (entry.directory) {
      pushHeader(entry.name.endsWith("/") ? entry.name : `${entry.name}/`, 0, "5");
    } else {
      const data = entry.data ?? new Uint8Array();
      pushHeader(entry.name, data.length, "0");
      pushData(data);
    }
  }
  chunks.push(new Uint8Array(512));
  chunks.push(new Uint8Array(512));

  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
