import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SevynApplicationRuntime } from "./application-runtime.js";
import { installNativeAdapters } from "./native-adapter-contracts.js";
import { FlatList, Image, NativeText } from "./primitives.js";

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("virtualized lists", () => {
  it("mounts a bounded row window and moves it with native scrolling", async () => {
    const data = Array.from({ length: 1_000 }, (_, index) => ({
      id: `row-${String(index)}`,
    }));
    const onEndReached = vi.fn();
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 320, height: 100 },
    });

    runtime.mount(
      createElement(FlatList<(typeof data)[number]>, {
        data,
        style: { height: 100 },
        estimatedItemSize: 25,
        initialNumToRender: 4,
        maxToRenderPerBatch: 4,
        windowSize: 1,
        keyExtractor: (item) => item.id,
        onEndReached,
        onEndReachedThreshold: 0.5,
        renderItem: ({ item }) =>
          NativeText({ id: item.id, text: item.id, style: { height: 25 } }),
      }),
    );
    await settle();

    expect(runtime.snapshot.commands.some((command) => command.id === "row-0.text")).toBe(
      true,
    );
    expect(
      runtime.snapshot.commands.some((command) => command.id === "row-50.text"),
    ).toBe(false);
    expect(
      runtime.snapshot.commands.filter((command) => /^row-\d+\.text$/.test(command.id)),
    ).toHaveLength(5);

    runtime.dispatchWheel({ x: 10, y: 10, deltaX: 0, deltaY: 1_250 });
    await settle();

    expect(
      runtime.snapshot.commands.some((command) => command.id === "row-50.text"),
    ).toBe(true);
    expect(runtime.snapshot.commands.some((command) => command.id === "row-0.text")).toBe(
      false,
    );
    expect(onEndReached).not.toHaveBeenCalled();

    runtime.dispatchWheel({ x: 10, y: 10, deltaX: 0, deltaY: 30_000 });
    await settle();
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });
});

describe("Image", () => {
  it("loads a URI through the active native image adapter", async () => {
    installNativeAdapters({
      image: {
        load: async () =>
          await Promise.resolve({
            width: 1,
            height: 1,
            pixels: new Uint8Array([1, 2, 3, 255]),
          }),
      },
    });
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 40, height: 40 },
    });
    runtime.mount(
      createElement(Image, {
        id: "remote-image",
        source: { uri: "https://example.test/a.png" },
      }),
    );
    await settle();
    expect(
      runtime.snapshot.commands.find((command) => command.id === "remote-image.bitmap"),
    ).toMatchObject({ kind: "bitmap", width: 1, height: 1 });
  });
});
