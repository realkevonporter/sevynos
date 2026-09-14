const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export function resolveQemuDisplayConfiguration(environment = process.env) {
  const width = parseDimension(
    "SEVYN_QEMU_WIDTH",
    environment.SEVYN_QEMU_WIDTH,
    DEFAULT_WIDTH,
    320,
  );
  const height = parseDimension(
    "SEVYN_QEMU_HEIGHT",
    environment.SEVYN_QEMU_HEIGHT,
    DEFAULT_HEIGHT,
    240,
  );
  return Object.freeze({
    width,
    height,
    device: `virtio-vga,xres=${String(width)},yres=${String(height)}`,
    kernelVideo: `video=Virtual-1:${String(width)}x${String(height)}@60`,
  });
}

function parseDimension(name, value, fallback, minimum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 8192)
    throw new Error(
      `${name} must be an integer between ${String(minimum)} and 8192; received ${JSON.stringify(value)}.`,
    );
  return parsed;
}
