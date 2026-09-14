import { describe, expect, it } from "vitest";
import { installNativeAdapters } from "./native-adapter-contracts.js";
import { WebSocket } from "./websocket.js";

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("WebSocket", () => {
  it("opens, sends text and binary data, receives messages, and closes", async () => {
    const sent: { readonly text?: string; readonly base64?: string }[] = [];
    const queue: {
      readonly type: "message" | "timeout";
      readonly text?: string;
    }[] = [{ type: "message", text: "hello from the broker" }];
    let closed = false;
    installNativeAdapters({
      webSocket: {
        open: () => Promise.resolve({ id: "socket-1", protocol: "sevyn" }),
        send: (_id, data) => {
          sent.push(data);
          return Promise.resolve();
        },
        receive: () => Promise.resolve(queue.shift() ?? { type: "timeout" as const }),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      },
    });
    const events: string[] = [];
    const messages: string[] = [];
    const socket = new WebSocket("ws://example.test/socket", "sevyn");
    socket.onopen = () => events.push("open");
    socket.onmessage = (event) => messages.push(event.data as string);
    socket.onclose = () => events.push("close");
    await settle();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(socket.protocol).toBe("sevyn");
    expect(events).toEqual(["open"]);

    socket.send("ping");
    socket.send(new Uint8Array([1, 2, 3]));
    await settle();
    expect(sent[0]).toEqual({ text: "ping" });
    expect(sent[1]).toEqual({ base64: "AQID" });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(messages).toEqual(["hello from the broker"]);

    socket.close();
    await settle();
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(events).toEqual(["open", "close"]);
  });
});
