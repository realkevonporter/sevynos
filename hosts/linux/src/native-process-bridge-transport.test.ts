import { describe, expect, it } from "vitest";
import { NativeProcessBridgeTransport } from "./native-process-bridge-transport.js";

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("native process bridge transport", () => {
  it("delivers messages emitted before the first subscriber attaches", async () => {
    const messages = [
      { protocolVersion: 1, sequence: 1, type: "diagnostic", event: "early" },
      { protocolVersion: 1, sequence: 2, type: "ready", displays: [] },
    ];
    const transport = new NativeProcessBridgeTransport(process.execPath, [
      "--input-type=module",
      "--eval",
      `for (const message of ${JSON.stringify(messages)}) console.log(JSON.stringify(message));`,
    ]);
    await pause(1_500);
    const received: unknown[] = [];

    transport.subscribe((message) => received.push(message));
    await waitFor(() => received.length === messages.length, 1_000);

    expect(received).toEqual(messages);
    await transport.close();
  });

  it("bounds binary backpressure and replaces only the stale pending frame", async () => {
    const transport = new NativeProcessBridgeTransport(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'import fs from "node:fs";',
        'import readline from "node:readline";',
        "let sequence = 0;",
        "const lines = readline.createInterface({ input: process.stdin });",
        'lines.on("line", () => console.log(JSON.stringify({ protocolVersion: 1, sequence: ++sequence, type: "diagnostic", severity: "info", event: "control-received", message: "Control remained live." })));',
        "setTimeout(() => fs.createReadStream(null, { fd: 3 }).resume(), 1000);",
      ].join(""),
    ]);
    const received: unknown[] = [];
    transport.subscribe((message) => received.push(message));
    transport.send({
      protocolVersion: 1,
      sequence: 1,
      type: "initialize",
      applicationName: "test",
    });
    const pixels = new Uint8Array(1280 * 720 * 4);
    const statuses: string[] = [];
    for (const frameId of [1, 2, 3])
      transport.sendFrame(
        {
          frameId,
          displayId: "display-1",
          width: 1280,
          height: 720,
          stride: 5120,
          format: "rgba8888",
          pixels,
          damage: [{ x: 0, y: 0, width: 1280, height: 720 }],
        },
        (_error, status) => statuses.push(`${String(frameId)}:${status}`),
      );

    expect(transport.frameQueueDepth).toBeLessThanOrEqual(2);
    await waitFor(() => received.length === 1, 800);
    expect(received).toHaveLength(1);
    expect(statuses).toContain("2:replaced");
    await waitFor(() => statuses.includes("3:sent"), 1_500);
    expect(statuses).toContain("1:sent");
    expect(statuses).toContain("3:sent");
    expect(transport.frameQueueDepth).toBe(0);
    await transport.close();
  });
});

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for transport state.");
    await pause(10);
  }
}
