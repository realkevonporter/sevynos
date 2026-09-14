import { describe, expect, it, vi } from "vitest";
import {
  codegenNativeCommands,
  codegenNativeComponent,
  NativeComponentRegistry,
} from "./fabric.js";

describe("Fabric compatibility", () => {
  it("creates registered native host components", () => {
    NativeComponentRegistry.register("SevynTestView", "view");
    const Component = codegenNativeComponent("SevynTestView");
    const element = Component({ id: "fabric-view" });
    expect(element.type).toBe("view");
    expect(Component.displayName).toBe("SevynTestView");
  });

  it("dispatches generated native commands through a host ref", () => {
    const dispatchCommand = vi.fn();
    const commands = codegenNativeCommands({ focus: "focus" });
    commands.focus({ current: { dispatchCommand } }, 1);
    expect(dispatchCommand).toHaveBeenCalledWith("focus", [1]);
  });
});
