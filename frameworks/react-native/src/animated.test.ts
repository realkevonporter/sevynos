import { describe, expect, it } from "vitest";
import {
  Animated,
  AppState,
  BackHandler,
  Clipboard,
  Keyboard,
  Linking,
} from "./public.js";

describe("Animated API", () => {
  it("initializes and updates AnimatedValue", () => {
    const val = new Animated.Value(0);
    expect(val.getValue()).toBe(0);
    val.setValue(10);
    expect(val.getValue()).toBe(10);
  });

  it("adds and triggers listeners", () => {
    const val = new Animated.Value(5);
    let captured = 0;
    const id = val.addListener(({ value }) => {
      captured = value;
    });
    val.setValue(42);
    expect(captured).toBe(42);
    val.removeListener(id);
    val.setValue(100);
    expect(captured).toBe(42);
  });

  it("interpolates values correctly with clamping", () => {
    const val = new Animated.Value(0);
    const interp = val.interpolate({
      inputRange: [0, 1],
      outputRange: [100, 200],
      extrapolate: "clamp",
    });

    expect(interp.getValue()).toBe(100);
    val.setValue(0.5);
    expect(interp.getValue()).toBe(150);
    val.setValue(2);
    expect(interp.getValue()).toBe(200);
    val.setValue(-1);
    expect(interp.getValue()).toBe(100);
  });

  it("runs timing animation", async () => {
    const val = new Animated.Value(0);
    const anim = Animated.timing(val, { toValue: 1, duration: 10 });
    await new Promise<void>((resolve) => {
      anim.start((res) => {
        expect(res.finished).toBe(true);
        expect(val.getValue()).toBe(1);
        resolve();
      });
    });
  });

  it("runs spring animation", async () => {
    const val = new Animated.Value(0);
    const anim = Animated.spring(val, { toValue: 1, tension: 200, friction: 20 });
    await new Promise<void>((resolve) => {
      anim.start((res) => {
        expect(res.finished).toBe(true);
        expect(val.getValue()).toBe(1);
        resolve();
      });
    });
  });

  it("runs sequence and parallel animations", async () => {
    const v1 = new Animated.Value(0);
    const v2 = new Animated.Value(0);
    const seq = Animated.sequence([
      Animated.timing(v1, { toValue: 1, duration: 5 }),
      Animated.timing(v2, { toValue: 2, duration: 5 }),
    ]);
    await new Promise<void>((resolve) => {
      seq.start((res) => {
        expect(res.finished).toBe(true);
        expect(v1.getValue()).toBe(1);
        expect(v2.getValue()).toBe(2);
        resolve();
      });
    });
  });
});

describe("Platform Utilities", () => {
  it("manages AppState", () => {
    expect(AppState.currentState).toBe("active");
    let state = "";
    const sub = AppState.addEventListener("change", (s) => {
      state = s;
    });
    AppState.currentState = "background";
    expect(state).toBe("background");
    sub.remove();
  });

  it("manages Clipboard", async () => {
    Clipboard.setString("SevynOS 2026");
    const text = await Clipboard.getString();
    expect(text).toBe("SevynOS 2026");
  });

  it("manages Linking", async () => {
    expect(await Linking.canOpenURL("https://sevynos.org")).toBe(true);
    expect(await Linking.canOpenURL("sevyn://app")).toBe(true);
    expect(await Linking.openURL("https://sevynos.org")).toBe(true);
  });

  it("manages BackHandler and Keyboard", () => {
    const handler = () => true;
    const sub = BackHandler.addEventListener("hardwareBackPress", handler);
    sub.remove();

    let hidden = false;
    const kSub = Keyboard.addListener("keyboardDidHide", () => {
      hidden = true;
    });
    Keyboard.dismiss();
    expect(hidden).toBe(true);
    kSub.remove();
  });
});
