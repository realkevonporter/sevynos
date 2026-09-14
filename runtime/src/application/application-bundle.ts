import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { ApplicationManifest } from "./application-manifest.js";
import { validateApplicationManifest } from "./application-manifest-validator.js";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

export function computeCrc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ExtractedSevynBundle {
  readonly manifest: ApplicationManifest;
  readonly bytecode: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly assets: ReadonlyMap<string, Uint8Array>;
}

export interface SevynBundleInput {
  readonly manifest: ApplicationManifest;
  readonly bytecode: Uint8Array | string;
  readonly assets?: Readonly<Record<string, Uint8Array | string>> | undefined;
  readonly extraFiles?: Readonly<Record<string, Uint8Array | string>> | undefined;
}

interface ZipEntry {
  readonly filename: string;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly compressed: Uint8Array;
  readonly isDeflated: boolean;
}

function toBuffer(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return data;
}

/**
 * Creates a standard .sevyn ZIP archive buffer from bundle input.
 */
export function createSevynBundle(input: SevynBundleInput): Uint8Array {
  const validatedManifest = validateApplicationManifest(input.manifest);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(validatedManifest, null, 2),
  );
  const bytecodeBytes = toBuffer(input.bytecode);

  const entries: ZipEntry[] = [];

  const addEntry = (filename: string, content: Uint8Array): void => {
    const crc = computeCrc32(content);
    let compressed: Uint8Array;
    let isDeflated = true;

    try {
      const deflated = deflateRawSync(content);
      if (deflated.length < content.length) {
        compressed = deflated;
      } else {
        compressed = content;
        isDeflated = false;
      }
    } catch {
      compressed = content;
      isDeflated = false;
    }

    entries.push({
      filename,
      data: content,
      crc,
      compressed,
      isDeflated,
    });
  };

  addEntry("manifest.json", manifestBytes);
  addEntry("app.hbc", bytecodeBytes);

  if (input.assets) {
    for (const [key, val] of Object.entries(input.assets)) {
      const cleanPath = key.startsWith("assets/") ? key : `assets/${key}`;
      addEntry(cleanPath, toBuffer(val));
    }
  }

  if (input.extraFiles) {
    for (const [key, val] of Object.entries(input.extraFiles)) {
      if (key !== "manifest.json" && key !== "app.hbc") {
        addEntry(key, toBuffer(val));
      }
    }
  }

  // Calculate size and build zip file buffer
  const localHeaderOffsets: number[] = [];
  const parts: Uint8Array[] = [];

  let currentOffset = 0;

  for (const entry of entries) {
    localHeaderOffsets.push(currentOffset);
    const nameBytes = new TextEncoder().encode(entry.filename);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

    view.setUint32(0, 0x04034b50, true); // Local header signature
    view.setUint16(4, 20, true); // Version needed to extract (2.0)
    view.setUint16(6, 0, true); // General purpose bit flag
    view.setUint16(8, entry.isDeflated ? 8 : 0, true); // Compression method
    view.setUint16(10, 0, true); // Mod time
    view.setUint16(12, 0, true); // Mod date
    view.setUint32(14, entry.crc, true); // CRC-32
    view.setUint32(18, entry.compressed.length, true); // Compressed size
    view.setUint32(22, entry.data.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // File name length
    view.setUint16(28, 0, true); // Extra field length
    header.set(nameBytes, 30);

    parts.push(header);
    parts.push(entry.compressed);
    currentOffset += header.length + entry.compressed.length;
  }

  const centralDirStartOffset = currentOffset;
  let centralDirSize = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const offset = localHeaderOffsets[i] ?? 0;
    if (!entry) {
      continue;
    }
    const nameBytes = new TextEncoder().encode(entry.filename);
    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(cdHeader.buffer, cdHeader.byteOffset, cdHeader.byteLength);

    view.setUint32(0, 0x02014b50, true); // Central directory signature
    view.setUint16(4, 20, true); // Version made by
    view.setUint16(6, 20, true); // Version needed to extract
    view.setUint16(8, 0, true); // General purpose bit flag
    view.setUint16(10, entry.isDeflated ? 8 : 0, true); // Compression method
    view.setUint16(12, 0, true); // Mod time
    view.setUint16(14, 0, true); // Mod date
    view.setUint32(16, entry.crc, true); // CRC-32
    view.setUint32(20, entry.compressed.length, true); // Compressed size
    view.setUint32(24, entry.data.length, true); // Uncompressed size
    view.setUint16(28, nameBytes.length, true); // File name length
    view.setUint16(30, 0, true); // Extra field length
    view.setUint16(32, 0, true); // Comment length
    view.setUint16(34, 0, true); // Disk number start
    view.setUint16(36, 0, true); // Internal attributes
    view.setUint32(38, 0, true); // External attributes
    view.setUint32(42, offset, true); // Local header offset
    cdHeader.set(nameBytes, 46);

    parts.push(cdHeader);
    currentOffset += cdHeader.length;
    centralDirSize += cdHeader.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true); // Disk number
  eocdView.setUint16(6, 0, true); // Disk with central directory
  eocdView.setUint16(8, entries.length, true); // Entries on this disk
  eocdView.setUint16(10, entries.length, true); // Total entries
  eocdView.setUint32(12, centralDirSize, true); // Size of central dir
  eocdView.setUint32(16, centralDirStartOffset, true); // Offset of central dir
  eocdView.setUint16(20, 0, true); // Comment length
  parts.push(eocd);

  // Combine parts into single Uint8Array
  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const bundleBytes = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of parts) {
    bundleBytes.set(part, pos);
    pos += part.length;
  }

  return bundleBytes;
}

/**
 * Extracts a standard .sevyn ZIP archive buffer into manifest, bytecode, and assets.
 */
export function extractSevynBundle(buffer: Uint8Array): ExtractedSevynBundle {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Find End of Central Directory Record (PK\x05\x06) by scanning backwards from end
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error(
      "Invalid .sevyn bundle: missing ZIP End of Central Directory record.",
    );
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const files = new Map<string, Uint8Array>();
  const assets = new Map<string, Uint8Array>();

  let cdPos = centralDirOffset;
  for (let entryIdx = 0; entryIdx < totalEntries; entryIdx++) {
    if (cdPos + 46 > buffer.length || view.getUint32(cdPos, true) !== 0x02014b50) {
      break;
    }

    const compressionMethod = view.getUint16(cdPos + 10, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const nameLength = view.getUint16(cdPos + 28, true);
    const extraLength = view.getUint16(cdPos + 30, true);
    const commentLength = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);

    const nameBytes = buffer.subarray(cdPos + 46, cdPos + 46 + nameLength);
    const filename = new TextDecoder().decode(nameBytes);

    cdPos += 46 + nameLength + extraLength + commentLength;

    // Read file data from local header
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid local header for file ${filename} in .sevyn bundle.`);
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let decompressed: Uint8Array;
    if (compressionMethod === 0) {
      decompressed = new Uint8Array(compressedData);
    } else if (compressionMethod === 8) {
      const raw = inflateRawSync(compressedData);
      decompressed = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else {
      throw new Error(
        `Unsupported compression method (${String(compressionMethod)}) for file ${filename}.`,
      );
    }

    if (uncompressedSize > 0 && decompressed.length !== uncompressedSize) {
      throw new Error(
        `Decompressed size mismatch for ${filename}: expected ${String(uncompressedSize)}, got ${String(decompressed.length)}.`,
      );
    }

    files.set(filename, decompressed);
    if (filename.startsWith("assets/")) {
      const assetKey = filename.slice("assets/".length);
      assets.set(assetKey, decompressed);
    }
  }

  const manifestData = files.get("manifest.json");
  if (!manifestData) {
    throw new Error("Invalid .sevyn bundle: manifest.json is missing.");
  }

  const bytecodeData = files.get("app.hbc");
  if (!bytecodeData) {
    throw new Error("Invalid .sevyn bundle: app.hbc is missing.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(manifestData));
  } catch (error) {
    throw new Error(
      `Invalid .sevyn bundle manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const manifest = validateApplicationManifest(parsedJson);

  return Object.freeze({
    manifest,
    bytecode: bytecodeData,
    files: Object.freeze(files),
    assets: Object.freeze(assets),
  });
}
