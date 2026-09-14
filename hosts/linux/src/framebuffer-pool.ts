export type FramebufferState = "rendering" | "submitted";

export interface PooledFramebuffer {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface MutableFramebuffer extends PooledFramebuffer {
  state: FramebufferState | "available";
}

export class FramebufferPool {
  readonly #buffers: MutableFramebuffer[] = [];
  readonly #maximumBuffers: number;
  #nextId = 0;
  #width = 0;
  #height = 0;
  #allocationCount = 0;

  public constructor(maximumBuffers = 3) {
    if (!Number.isSafeInteger(maximumBuffers) || maximumBuffers < 2)
      throw new Error("A framebuffer pool requires at least two buffers.");
    this.#maximumBuffers = maximumBuffers;
  }

  public acquire(width: number, height: number): PooledFramebuffer {
    this.#configure(width, height);
    let buffer = this.#buffers.find(
      (candidate) =>
        candidate.state === "available" &&
        candidate.width === width &&
        candidate.height === height,
    );
    if (buffer === undefined) {
      const activeAtCurrentSize = this.#buffers.filter(
        (candidate) => candidate.width === width && candidate.height === height,
      ).length;
      if (activeAtCurrentSize >= this.#maximumBuffers)
        throw new Error("No reusable framebuffer is available.");
      this.#nextId += 1;
      this.#allocationCount += 1;
      buffer = {
        id: this.#nextId,
        width,
        height,
        pixels: new Uint8Array(width * height * 4),
        state: "available",
      };
      this.#buffers.push(buffer);
    }
    buffer.state = "rendering";
    return buffer;
  }

  public submit(buffer: PooledFramebuffer): void {
    const current = this.#require(buffer);
    if (current.state !== "rendering")
      throw new Error("Only a rendering framebuffer can be submitted.");
    current.state = "submitted";
  }

  public release(buffer: PooledFramebuffer): void {
    const current = this.#require(buffer);
    if (current.state === "available")
      throw new Error("An available framebuffer cannot be released twice.");
    current.state = "available";
    this.#discardOldAvailableBuffers();
  }

  public get allocationCount(): number {
    return this.#allocationCount;
  }

  public get busyCount(): number {
    return this.#buffers.filter((buffer) => buffer.state !== "available").length;
  }

  #configure(width: number, height: number): void {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    )
      throw new Error("Framebuffer dimensions are invalid.");
    this.#width = width;
    this.#height = height;
    this.#discardOldAvailableBuffers();
  }

  #discardOldAvailableBuffers(): void {
    for (let index = this.#buffers.length - 1; index >= 0; index -= 1) {
      const buffer = this.#buffers[index];
      if (
        buffer?.state === "available" &&
        (buffer.width !== this.#width || buffer.height !== this.#height)
      )
        this.#buffers.splice(index, 1);
    }
  }

  #require(buffer: PooledFramebuffer): MutableFramebuffer {
    const current = this.#buffers.find((candidate) => candidate === buffer);
    if (current === undefined)
      throw new Error("Framebuffer does not belong to this pool.");
    return current;
  }
}
