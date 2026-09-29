import { createElement, useEffect, useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  NativeOverlay,
  NativeImage,
  NativeScrollView,
  NativeText,
  NativeTextInput,
  NativeToggle,
  NativeSlider,
  Pressable,
  SevynApplicationRuntime,
  View,
} from "./internal.js";
import { installNativeAdapters } from "./native-adapter-contracts.js";

const bounds = Object.freeze({ x: 0, y: 0, width: 640, height: 480 });
const keyboard = (key: string, shift = false, control = false, meta = false) => ({
  key,
  code: key,
  shift,
  alt: false,
  control,
  meta,
});
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 50);
  });

describe("Sevyn React application runtime", () => {
  it("mounts, updates state, runs effects, and cleans up on unmount", async () => {
    const lifecycle: string[] = [];
    function Application() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        lifecycle.push("mounted");
        return () => {
          lifecycle.push("cleaned");
        };
      }, []);
      return View({
        id: "root",
        style: { padding: 12 },
        children: [
          NativeText({ key: "count", id: "count", text: String(count), role: "heading" }),
          Pressable({
            key: "increment",
            id: "increment",
            role: "button",
            label: "Increment",
            style: { height: 44 },
            onPress: () => {
              setCount((value) => value + 1);
            },
          }),
        ],
      });
    }
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(createElement(Application));
    await settle();
    expect(
      runtime.snapshot.commands.some(
        (command) => command.kind === "text" && command.text === "0",
      ),
    ).toBe(true);
    runtime.dispatchPointer("down", { x: 20, y: 54, pointerId: 1, button: 0 });
    runtime.dispatchPointer("up", { x: 20, y: 54, pointerId: 1, button: 0 });
    await settle();
    expect(
      runtime.snapshot.commands.some(
        (command) => command.kind === "text" && command.text === "1",
      ),
    ).toBe(true);
    runtime.unmount();
    await settle();
    expect(lifecycle).toEqual(["mounted", "cleaned"]);
  });

  it("preserves keyed children and reuses commands outside changed subtrees", async () => {
    const runtime = new SevynApplicationRuntime({ bounds });
    const tree = (items: readonly { readonly id: string; readonly text: string }[]) =>
      View({
        id: "list",
        children: items.map((item) =>
          NativeText({ key: item.id, id: item.id, text: item.text }),
        ),
      });
    runtime.mount(
      tree([
        { id: "alpha", text: "Alpha" },
        { id: "beta", text: "Beta" },
      ]),
    );
    await settle();
    const alpha = runtime.snapshot.commands.find(
      (command) => command.id === "alpha.text",
    );
    runtime.update(
      tree([
        { id: "alpha", text: "Alpha" },
        { id: "beta", text: "Beta updated" },
      ]),
    );
    await settle();
    expect(runtime.snapshot.commands.find((command) => command.id === "alpha.text")).toBe(
      alpha,
    );
    expect(
      runtime.snapshot.commands.some(
        (command) => command.kind === "text" && command.text === "Beta updated",
      ),
    ).toBe(true);
    runtime.update(
      tree([
        { id: "beta", text: "Beta updated" },
        { id: "alpha", text: "Alpha" },
      ]),
    );
    await settle();
    expect(
      runtime.snapshot.commands
        .filter((command) => command.kind === "text")
        .map((command) => command.id),
    ).toEqual(["beta.text", "alpha.text"]);
  });

  it("lays out responsive flex content and nested clipping deterministically", async () => {
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "responsive",
        style: { direction: "row", gap: 8 },
        breakpoint: { compact: 700, compactStyle: { direction: "column" } },
        children: [
          NativeScrollView({
            key: "outer",
            id: "outer",
            style: { overflow: "scroll", flexGrow: 1 },
            children: NativeScrollView({
              id: "inner",
              style: { overflow: "hidden", height: "50%" },
              children: NativeText({ id: "body", text: "Nested content" }),
            }),
          }),
          View({ key: "aside", id: "aside", style: { width: "25%" } }),
        ],
      }),
    );
    await settle();
    expect(
      runtime.snapshot.commands.filter((command) => command.kind === "clip-start"),
    ).toHaveLength(2);
    expect(
      runtime.snapshot.commands.filter((command) => command.kind === "clip-end"),
    ).toHaveLength(2);
  });

  it("supports focus traversal, uncontrolled text, overlays, and focus trapping", async () => {
    let dismissed = false;
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "root",
        children: [
          NativeTextInput({
            key: "field",
            id: "field",
            role: "textbox",
            label: "Name",
            defaultValue: "S",
          }),
          NativeOverlay({
            key: "dialog",
            id: "dialog",
            role: "dialog",
            label: "Confirm",
            focusTrap: true,
            onDismiss: () => {
              dismissed = true;
            },
            children: Pressable({ id: "confirm", role: "button", label: "Confirm" }),
          }),
        ],
      }),
    );
    await settle();
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    expect(runtime.snapshot.focusId).toBe("confirm");
    runtime.dispatchKeyboard("down", keyboard("Escape"));
    expect(dismissed).toBe(true);
  });

  it("renders input values and accepts newlines in multiline text fields", async () => {
    function Editor() {
      const [value, setValue] = useState("First line");
      return NativeTextInput({
        id: "editor",
        role: "textbox",
        label: "Editor",
        multiline: true,
        value,
        onTextInput: setValue,
      });
    }
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(createElement(Editor));
    await settle();
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    runtime.dispatchKeyboard("down", keyboard("Enter"));
    runtime.dispatchKeyboard("down", keyboard("S"));
    await settle();
    expect(runtime.snapshot.commands).toContainEqual(
      expect.objectContaining({ kind: "text", text: "First line\nS" }),
    );
  });

  it("supports select all and clipboard copy, cut, and paste shortcuts", async () => {
    const copied: string[] = [];
    installNativeAdapters({
      clipboard: {
        readText: () => Promise.resolve("pasted"),
        writeText: (value) => {
          copied.push(value);
          return Promise.resolve();
        },
      },
    });
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      NativeTextInput({ id: "field", role: "textbox", defaultValue: "hello" }),
    );
    await settle();
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    runtime.dispatchKeyboard("down", keyboard("a", false, true));
    runtime.dispatchKeyboard("down", keyboard("c", false, true));
    expect(copied).toEqual(["hello"]);
    runtime.dispatchKeyboard("down", keyboard("x", false, true));
    await settle();
    expect(
      runtime.snapshot.commands.find((command) => command.id === "field.background"),
    ).toBeDefined();
    runtime.dispatchKeyboard("down", keyboard("v", false, true));
    await settle();
    expect(runtime.snapshot.commands).toContainEqual(
      expect.objectContaining({ text: "pasted" }),
    );
  });

  it("generates a separate accessibility tree", async () => {
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "root",
        role: "application",
        label: "Example",
        children: Pressable({
          id: "save",
          role: "button",
          label: "Save",
          description: "Save this document",
          disabled: true,
        }),
      }),
    );
    await settle();
    expect(runtime.snapshot.accessibility[0]).toMatchObject({
      role: "application",
      label: "Example",
      children: [{ role: "button", label: "Save", disabled: true }],
    });
  });

  it("supports controlled and uncontrolled value components", async () => {
    const controlledChanges: boolean[] = [];
    const sliderChanges: number[] = [];
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "values",
        children: [
          NativeToggle({
            key: "controlled",
            id: "controlled",
            role: "checkbox",
            label: "Controlled",
            checked: false,
            onValueChange: (value) => {
              if (typeof value === "boolean") controlledChanges.push(value);
            },
          }),
          NativeToggle({
            key: "uncontrolled",
            id: "uncontrolled",
            role: "checkbox",
            label: "Uncontrolled",
            defaultChecked: false,
          }),
          NativeSlider({
            key: "slider",
            id: "slider",
            role: "slider",
            label: "Volume",
            defaultValue: 5,
            minimumValue: 0,
            maximumValue: 10,
            step: 2,
            onValueChange: (value) => {
              if (typeof value === "number") sliderChanges.push(value);
            },
          }),
        ],
      }),
    );
    await settle();
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    runtime.dispatchKeyboard("down", keyboard(" "));
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    runtime.dispatchKeyboard("down", keyboard(" "));
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    runtime.dispatchKeyboard("down", keyboard("ArrowRight"));
    expect(controlledChanges).toEqual([true]);
    expect(
      runtime.snapshot.accessibility.find((node) => node.label === "Uncontrolled")
        ?.checked,
    ).toBe(true);
    expect(sliderChanges).toEqual([7]);
  });

  it("isolates application crashes and exposes sanitized recovery actions", async () => {
    const actions: string[] = [];
    function CrashedApplication(): ReactElement {
      throw new Error("private note contents");
    }
    const runtime = new SevynApplicationRuntime({
      bounds,
      onRestart: () => {
        actions.push("restart");
      },
      onClose: () => {
        actions.push("close");
      },
      onViewDiagnostics: () => {
        actions.push("diagnostics");
      },
    });
    runtime.mount(createElement(CrashedApplication));
    await settle();
    expect(runtime.snapshot.accessibility[0]?.description).not.toContain("private");
    expect(
      runtime.snapshot.commands.filter((command) => command.kind === "control"),
    ).toHaveLength(3);
    runtime.recover("restart");
    runtime.recover("diagnostics");
    runtime.recover("close");
    expect(actions).toEqual(["restart", "diagnostics", "close"]);
  });

  it("renders a native scroll indicator thumb when scrollable container content overflows", async () => {
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      NativeScrollView({
        id: "scroll-view",
        style: { height: 100, overflow: "scroll" },
        children: Array.from({ length: 10 }, (_, index) =>
          NativeText({
            key: `item-${String(index)}`,
            id: `item-${String(index)}`,
            text: `Item ${String(index)}`,
            style: { height: 30 },
          }),
        ),
      }),
    );
    await settle();

    const scrollbarThumb = runtime.snapshot.commands.find(
      (cmd) => cmd.id === "scroll-view.scrollbar-thumb",
    );
    expect(scrollbarThumb).toBeDefined();
    expect(scrollbarThumb?.kind).toBe("material");
    expect((scrollbarThumb as { radius: number }).radius).toBe(2);
    expect((scrollbarThumb as { bounds: { width: number } }).bounds.width).toBe(4);
  });

  it("delivers wheel input to interactive native content before container scrolling", async () => {
    const deltas: number[] = [];
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "root",
        children: NativeImage({
          id: "web-content",
          source: { width: 2, height: 2, pixels: new Uint8Array(16) },
          onWheel: (event) => deltas.push(event.deltaY),
          style: { width: 320, height: 240 },
        }),
      }),
    );
    await settle();
    runtime.dispatchWheel({ x: 20, y: 20, deltaX: 0, deltaY: 120 });
    expect(deltas).toEqual([120]);
  });

  it("delivers pointer coordinates relative to the interactive native element", async () => {
    const points: { x: number; y: number }[] = [];
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "root",
        style: { padding: 40 },
        children: Pressable({
          id: "target",
          role: "button",
          style: { width: 100, height: 80 },
          onPointerDown: ({ x, y }) => points.push({ x, y }),
        }),
      }),
    );
    await settle();
    runtime.dispatchPointer("down", { x: 55, y: 62, pointerId: 1, button: 0 });
    expect(points).toEqual([{ x: 15, y: 22 }]);
  });

  it("dispatches touch gestures into press activation and cancellation", async () => {
    let presses = 0;
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "root",
        children: Pressable({
          id: "touch-target",
          role: "button",
          style: { width: 100, height: 80 },
          onPress: () => presses++,
        }),
      }),
    );
    await settle();
    const point = { touchId: 1, x: 20, y: 20 };
    runtime.dispatchTouch("start", { touches: [point], changedTouches: [point] });
    runtime.dispatchTouch("end", { touches: [], changedTouches: [point] });
    expect(presses).toBe(1);
    runtime.dispatchTouch("start", { touches: [point], changedTouches: [point] });
    runtime.dispatchTouch("cancel", { touches: [], changedTouches: [point] });
    runtime.dispatchTouch("end", { touches: [], changedTouches: [point] });
    expect(presses).toBe(1);
  });

  it("negotiates and retains a responder across pointer movement", async () => {
    const events: string[] = [];
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "responder",
        style: { width: 120, height: 80 },
        onStartShouldSetResponder: () => true,
        onResponderGrant: () => events.push("grant"),
        onResponderMove: () => events.push("move"),
        onResponderRelease: () => events.push("release"),
      }),
    );
    await settle();
    runtime.dispatchPointer("down", { x: 10, y: 10, pointerId: 1, button: 0 });
    runtime.dispatchPointer("move", { x: 300, y: 300, pointerId: 1, button: 0 });
    runtime.dispatchPointer("up", { x: 300, y: 300, pointerId: 1, button: 0 });
    expect(events).toEqual(["grant", "move", "release"]);
  });

  it("dispatches onTextInput, onChangeText, and onValueChange when typing in text input", async () => {
    const textInputEvents: string[] = [];
    const changeTextEvents: string[] = [];
    const valueChangeEvents: string[] = [];

    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "root",
        children: [
          NativeTextInput({
            key: "input",
            id: "my-input",
            label: "Test Input",
            defaultValue: "",
            onTextInput: (text) => textInputEvents.push(text),
            onChangeText: (text) => changeTextEvents.push(text),
            onValueChange: (text) => valueChangeEvents.push(String(text)),
          }),
        ],
      }),
    );
    await settle();

    // Focus input
    runtime.dispatchKeyboard("down", keyboard("Tab"));
    // Type 'A'
    runtime.dispatchKeyboard("down", keyboard("A"));
    // Type 'B'
    runtime.dispatchKeyboard("down", keyboard("B"));

    expect(textInputEvents).toEqual(["A", "AB"]);
    expect(changeTextEvents).toEqual(["A", "AB"]);
    expect(valueChangeEvents).toEqual(["A", "AB"]);
    expect(runtime.snapshot.focusId).toBe("my-input");
  });

  it("focuses an ordinary React Native TextInput without an accessibility role", async () => {
    const values: string[] = [];
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      NativeTextInput({
        id: "plain-input",
        defaultValue: "",
        style: { width: 240, height: 40 },
        onChangeText: (value) => values.push(value),
      }),
    );
    await settle();

    runtime.dispatchPointer("down", { x: 12, y: 12, pointerId: 1, button: 0 });
    runtime.dispatchPointer("up", { x: 12, y: 12, pointerId: 1, button: 0 });
    runtime.dispatchKeyboard("down", keyboard("S"));

    expect(runtime.snapshot.focusId).toBe("plain-input");
    expect(values).toEqual(["S"]);
  });

  it("shows a caret and edits at the pointer-selected text position", async () => {
    const values: string[] = [];
    const selections: { start: number; end: number }[] = [];
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      NativeTextInput({
        id: "positioned-input",
        role: "textbox",
        defaultValue: "abcd",
        style: { width: 240, height: 40, fontSize: 15 },
        onChangeText: (value) => values.push(value),
        onSelectionChange: (selection) => selections.push(selection),
      }),
    );
    await settle();

    runtime.dispatchPointer("down", { x: 29, y: 20, pointerId: 1, button: 0 });
    expect(
      runtime.snapshot.commands.some(
        (command) => command.id === "positioned-input.caret",
      ),
    ).toBe(true);
    runtime.dispatchKeyboard("down", keyboard("X"));

    expect(values).toEqual(["abXcd"]);
    expect(selections.at(-1)).toEqual({ start: 2, end: 2 });
    expect(
      runtime.snapshot.commands.find(
        (command) => command.id === "positioned-input.value",
      ),
    ).toMatchObject({ text: "abXcd" });
  });

  it("marks the focused input caret as a blinking command", async () => {
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      NativeTextInput({
        id: "blink-input",
        role: "textbox",
        defaultValue: "abc",
        style: { width: 240, height: 40, fontSize: 15 },
      }),
    );
    await settle();

    runtime.dispatchPointer("down", { x: 29, y: 20, pointerId: 1, button: 0 });
    const caret = runtime.snapshot.commands.find(
      (command) => command.id === "blink-input.caret",
    );
    expect(caret).toMatchObject({ kind: "material", blink: true });
  });

  it("bubbles pointer clicks on child text nodes up to the enclosing Pressable", async () => {
    let pressed = false;
    const runtime = new SevynApplicationRuntime({ bounds });
    runtime.mount(
      View({
        id: "container",
        children: [
          Pressable({
            key: "button-with-child",
            id: "button-with-child",
            role: "tab",
            style: { width: 100, height: 44 },
            onPress: () => {
              pressed = true;
            },
            children: NativeText({
              id: "button-label",
              text: "Click Me",
            }),
          }),
        ],
      }),
    );
    await settle();

    // Click right on the button/text node
    runtime.dispatchPointer("down", { x: 20, y: 20, pointerId: 1, button: 0 });
    runtime.dispatchPointer("up", { x: 20, y: 20, pointerId: 1, button: 0 });
    await settle();

    expect(pressed).toBe(true);
  });
});
