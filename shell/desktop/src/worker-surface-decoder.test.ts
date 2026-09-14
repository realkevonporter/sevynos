import { describe, expect, it } from "vitest";
import { decodeWorkerSurface } from "./worker-surface-decoder.js";

describe("worker surface decoder", () => {
  it("accepts structured render data and produces an immutable snapshot", () => {
    const snapshot = decodeWorkerSurface({
      revision: 3,
      commands: [
        {
          id: "title",
          kind: "text",
          bounds: { x: 0, y: 0, width: 100, height: 24 },
          text: "Notes",
          color: "#fff",
          size: 18,
          weight: 600,
        },
      ],
      accessibility: [
        {
          id: "app",
          role: "application",
          label: "Notes",
          disabled: false,
          selected: false,
          focusOrder: 0,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          children: [],
        },
      ],
    });
    expect(snapshot.revision).toBe(3);
    expect(snapshot.commands[0]).toMatchObject({ kind: "text", text: "Notes" });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects executable or unknown surface commands", () => {
    expect(() =>
      decodeWorkerSurface({
        revision: 1,
        commands: [
          { id: "bad", kind: "script", bounds: { x: 0, y: 0, width: 1, height: 1 } },
        ],
        accessibility: [],
      }),
    ).toThrow(/unsupported/);
  });

  it("decodes control commands with custom and arbitrary actions", () => {
    const snapshot = decodeWorkerSurface({
      revision: 4,
      commands: [
        {
          id: "custom-button",
          kind: "control",
          bounds: { x: 10, y: 10, width: 120, height: 36 },
          action: "custom",
          label: "Save",
          value: "Save",
          state: "idle",
          accent: "#D7AC57",
          foreground: "#FFFFFF",
          background: "#1E293B",
          radius: 8,
          borderWidth: 1,
          borderColor: "#38BDF8",
        },
        {
          id: "ext-button",
          kind: "control",
          bounds: { x: 10, y: 50, width: 120, height: 36 },
          action: "app.custom.action",
          label: "Export",
          value: "",
          state: "pressed",
          accent: "#D7AC57",
          foreground: "#19140A",
          background: "#D7AC57",
          radius: 8,
        },
      ],
      accessibility: [],
    });

    expect(snapshot.commands).toHaveLength(2);
    expect(snapshot.commands[0]).toMatchObject({
      kind: "control",
      action: "custom",
      label: "Save",
      state: "idle",
      borderWidth: 1,
      borderColor: "#38BDF8",
    });
    expect(snapshot.commands[1]).toMatchObject({
      kind: "control",
      action: "app.custom.action",
      label: "Export",
      state: "pressed",
    });
  });
});
