import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { AppRegistry, Text } from "@sevynos/react-native";
import { AppRegistryReactNativeComponentRegistry } from "./app-registry-component-registry.js";

describe("AppRegistry host adapter", () => {
  it("resolves a standard registered application for a runtime session", () => {
    AppRegistry.clear();
    const Application = (props: Record<string, unknown>) =>
      Text({ children: String(props["applicationId"]) });
    AppRegistry.registerComponent("main", () => Application);

    const component = new AppRegistryReactNativeComponentRegistry().get("main");
    expect(component).toBeDefined();
    const element = component
      ? createElement(component, {
          applicationId: "org.example.application",
          sessionId: "session-1",
        })
      : undefined;
    expect(element?.type).toBe(Application);
    expect(element?.props).toMatchObject({
      applicationId: "org.example.application",
      sessionId: "session-1",
    });
  });
});
