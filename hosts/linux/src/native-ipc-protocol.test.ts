import { describe, expect, it } from "vitest";
import {
  validateLinuxHostMessage,
  validateNativeBridgeMessage,
} from "./native-ipc-protocol.js";

describe("Linux native IPC protocol", () => {
  it("validates display, traced input, and presentation receipts", () => {
    expect(
      validateNativeBridgeMessage({
        protocolVersion: 1,
        sequence: 1,
        type: "pointer",
        event: "move",
        pointerId: 1,
        x: 20,
        y: 30,
        button: 0,
        buttons: 0,
        timestamp: 10,
        traceId: "focus-1",
      }),
    ).toMatchObject({ type: "pointer", x: 20, traceId: "focus-1" });
    expect(
      validateNativeBridgeMessage({
        protocolVersion: 1,
        sequence: 2,
        type: "frame-presented",
        frameId: 1,
        displayId: "display-1",
        traceId: "focus-1",
      }),
    ).toMatchObject({ type: "frame-presented", frameId: 1, traceId: "focus-1" });
  });
  it("rejects malformed, oversized, and unsupported messages", () => {
    expect(() => validateNativeBridgeMessage({ protocolVersion: 2 })).toThrow();
    expect(() =>
      validateNativeBridgeMessage({
        protocolVersion: 1,
        sequence: 1,
        type: "native-handle",
        handle: 4,
      }),
    ).toThrow(/unsupported/);
    expect(() =>
      validateLinuxHostMessage({
        protocolVersion: 1,
        sequence: 1,
        type: "clipboard-write",
        requestId: "x",
        text: "x".repeat(1_048_577),
      }),
    ).toThrow();
  });

  it("rejects zero display dimensions and binary frames on the control channel", () => {
    expect(() =>
      validateNativeBridgeMessage({
        protocolVersion: 1,
        sequence: 1,
        type: "ready",
        displays: [
          {
            id: "display-1",
            x: 0,
            y: 0,
            width: 0,
            height: 600,
            pixelWidth: 0,
            pixelHeight: 600,
            scaleFactor: 1,
            refreshRate: 60,
            primary: true,
          },
        ],
      }),
    ).toThrow(/positive/);

    expect(() =>
      validateLinuxHostMessage({
        protocolVersion: 1,
        sequence: 2,
        type: "present",
        pixelsBase64: "AAAA",
      }),
    ).toThrow(/unsupported/);
  });
});
