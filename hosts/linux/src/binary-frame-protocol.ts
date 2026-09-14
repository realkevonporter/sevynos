const MAGIC = Buffer.from("SEVYNFRM", "ascii");
const VERSION = 1;
const HEADER_BYTES = 64;
const DAMAGE_REGION_BYTES = 16;
const FORMAT_RGBA8888 = 1;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 128;
const MAX_DAMAGE_REGIONS = 64;

export interface BinaryDamageRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BinaryFramePacket {
  readonly frameId: number;
  readonly displayId: string;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly format: "rgba8888";
  readonly pixels: Uint8Array;
  readonly damage: readonly BinaryDamageRegion[];
  readonly traceId?: string;
}

export interface EncodedBinaryFrame {
  readonly metadata: Buffer;
  readonly pixels: Buffer;
  readonly byteLength: number;
}

export function encodeBinaryFrame(frame: BinaryFramePacket): EncodedBinaryFrame {
  validateFrame(frame);
  const display = Buffer.from(frame.displayId, "utf8");
  const trace = Buffer.from(frame.traceId ?? "", "utf8");
  const metadata = Buffer.allocUnsafe(
    HEADER_BYTES +
      frame.damage.length * DAMAGE_REGION_BYTES +
      display.length +
      trace.length,
  );
  MAGIC.copy(metadata, 0);
  metadata.writeUInt32LE(VERSION, 8);
  metadata.writeUInt32LE(HEADER_BYTES, 12);
  metadata.writeBigUInt64LE(BigInt(frame.frameId), 16);
  metadata.writeUInt32LE(frame.width, 24);
  metadata.writeUInt32LE(frame.height, 28);
  metadata.writeUInt32LE(frame.stride, 32);
  metadata.writeUInt32LE(FORMAT_RGBA8888, 36);
  metadata.writeUInt32LE(display.length, 40);
  metadata.writeUInt32LE(trace.length, 44);
  metadata.writeUInt32LE(frame.pixels.byteLength, 48);
  metadata.writeUInt32LE(frame.damage.length, 52);
  metadata.writeBigUInt64LE(0n, 56);
  let offset = HEADER_BYTES;
  for (const region of frame.damage) {
    metadata.writeInt32LE(region.x, offset);
    metadata.writeInt32LE(region.y, offset + 4);
    metadata.writeInt32LE(region.width, offset + 8);
    metadata.writeInt32LE(region.height, offset + 12);
    offset += DAMAGE_REGION_BYTES;
  }
  display.copy(metadata, offset);
  offset += display.length;
  trace.copy(metadata, offset);
  const pixels = Buffer.from(
    frame.pixels.buffer,
    frame.pixels.byteOffset,
    frame.pixels.byteLength,
  );
  return Object.freeze({
    metadata,
    pixels,
    byteLength: metadata.byteLength + pixels.byteLength,
  });
}

function validateFrame(frame: BinaryFramePacket): void {
  if (!Number.isSafeInteger(frame.frameId) || frame.frameId <= 0)
    throw new Error("Binary frame ID must be a positive safe integer.");
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    !Number.isSafeInteger(frame.stride) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    frame.width > 8192 ||
    frame.height > 8192 ||
    frame.stride !== frame.width * 4
  )
    throw new Error("Binary frame dimensions or stride are invalid.");
  const expectedBytes = frame.stride * frame.height;
  if (
    frame.pixels.byteLength !== expectedBytes ||
    frame.pixels.byteLength > MAX_FRAME_BYTES
  )
    throw new Error("Binary frame pixel length is invalid.");
  if (
    Buffer.byteLength(frame.displayId, "utf8") === 0 ||
    Buffer.byteLength(frame.displayId, "utf8") > MAX_TEXT_BYTES ||
    Buffer.byteLength(frame.traceId ?? "", "utf8") > MAX_TEXT_BYTES
  )
    throw new Error("Binary frame display or trace ID is invalid.");
  if (frame.damage.length === 0 || frame.damage.length > MAX_DAMAGE_REGIONS)
    throw new Error("Binary frame damage metadata is invalid.");
  for (const region of frame.damage)
    if (
      !Number.isSafeInteger(region.x) ||
      !Number.isSafeInteger(region.y) ||
      !Number.isSafeInteger(region.width) ||
      !Number.isSafeInteger(region.height) ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.width > frame.width ||
      region.y + region.height > frame.height
    )
      throw new Error("Binary frame damage region is invalid.");
}
