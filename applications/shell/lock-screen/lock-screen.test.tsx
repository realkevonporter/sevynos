/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint-disable no-restricted-imports */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDroppedPropWarnings,
  SevynApplicationRuntime,
} from "@sevynos/react-native/internal";
import {
  DesktopLockScreen,
  type DesktopLockScreenProps,
  type UnlockAttemptResult,
} from "./desktop.js";

const BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };

type LockScreenTestProps = Partial<
  Pick<
    DesktopLockScreenProps,
    | "locked"
    | "timeText"
    | "dateText"
    | "username"
    | "onUnlock"
    | "loginMode"
    | "accounts"
    | "onLogin"
    | "allowGuest"
    | "onGuestLogin"
  >
>;

function mountLockScreen(props: LockScreenTestProps = {}) {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  const runtime = new SevynApplicationRuntime({
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
  });
  runtime.mount(
    createElement(DesktopLockScreen, {
      displayBounds: BOUNDS,
      locked: true,
      order: 100,
      timeText: "09:41",
      dateText: "Wednesday, October 7",
      username: "Kevon",
      ...props,
    }),
  );
  return { runtime, warnSpy };
}

function textContent(runtime: SevynApplicationRuntime): string {
  return runtime.snapshot.commands
    .filter((cmd) => cmd.kind === "text")
    .map((cmd) => ("text" in cmd && typeof cmd.text === "string" ? cmd.text : ""))
    .join("\n");
}

function findControl(
  runtime: SevynApplicationRuntime,
  label: string,
): { x: number; y: number } {
  const controls = runtime.snapshot.commands.filter(
    (cmd): cmd is Extract<typeof cmd, { kind: "control" }> => cmd.kind === "control",
  );
  const match = controls.find((cmd) => cmd.label === label);
  if (match === undefined) {
    throw new Error(
      `Control "${label}" not found. Available: ${controls.map((cmd) => cmd.label).join(", ")}`,
    );
  }
  const bounds = match.bounds as { x: number; y: number; width: number; height: number };
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function pressControl(runtime: SevynApplicationRuntime, label: string): void {
  const { x, y } = findControl(runtime, label);
  runtime.dispatchPointer("down", { x, y, pointerId: 1, button: 0 });
  runtime.dispatchPointer("up", { x, y, pointerId: 1, button: 0 });
}

async function waitForText(
  runtime: SevynApplicationRuntime,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = textContent(runtime);
  while (!text.includes(needle) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    text = textContent(runtime);
  }
  return text;
}

describe("DesktopLockScreen", () => {
  const originalEnv = process.env["NODE_ENV"];

  beforeEach(() => {
    resetDroppedPropWarnings();
    process.env["NODE_ENV"] = "development";
  });

  afterEach(() => {
    process.env["NODE_ENV"] = originalEnv;
    vi.restoreAllMocks();
  });

  it("renders nothing when not locked", () => {
    const { runtime, warnSpy } = mountLockScreen({ locked: false });
    expect(runtime.snapshot.commands).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("renders the unlock card with username and password field", () => {
    const { runtime, warnSpy } = mountLockScreen();
    const text = textContent(runtime);
    expect(text).toContain("Kevon");
    expect(text).toContain("Unlock");
    expect(text).toContain("09:41");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("shows an error when verification fails and none when it succeeds", async () => {
    let attempt = 0;
    const onUnlock = (password: string): Promise<UnlockAttemptResult> => {
      attempt += 1;
      expect(password).toBe("");
      return Promise.resolve(attempt === 1 ? { ok: false } : { ok: true });
    };
    const { runtime } = mountLockScreen({ onUnlock });

    pressControl(runtime, "Unlock");
    const failed = await waitForText(runtime, "Incorrect password");
    expect(failed).toContain("Incorrect password. Try again.");

    pressControl(runtime, "Unlock");
    const deadline = Date.now() + 5000;
    let text = textContent(runtime);
    while (text.includes("Incorrect password") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      text = textContent(runtime);
    }
    expect(text).not.toContain("Incorrect password");
    expect(attempt).toBe(2);
  });

  it("surfaces backend lockouts with a retry message", async () => {
    const onUnlock = (): Promise<UnlockAttemptResult> =>
      Promise.resolve({
        ok: false,
        reason: "locked-out",
        retryAfterMs: 59000,
      });
    const { runtime } = mountLockScreen({ onUnlock });

    pressControl(runtime, "Unlock");
    const text = await waitForText(runtime, "Too many attempts");
    expect(text).toContain("Too many attempts. Try again in 59s.");
    // The button shows the locked state while the lockout is active.
    expect(textContent(runtime)).toContain("Locked");
  });

  it("renders the login mode account picker and guest entry", () => {
    const { runtime, warnSpy } = mountLockScreen({
      loginMode: true,
      accounts: [
        { username: "kevon", fullName: "Kevon" },
        { username: "ada", fullName: "" },
      ],
      allowGuest: true,
      onGuestLogin: () => undefined,
      onLogin: () => Promise.resolve({ ok: true }),
    });
    const text = textContent(runtime);
    expect(text).toContain("Kevon");
    expect(text).toContain("ada");
    expect(text).toContain("Log in");
    expect(text).toContain("Log in as guest");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("invokes onGuestLogin when the guest entry is pressed", async () => {
    const onGuestLogin = vi.fn();
    const { runtime } = mountLockScreen({
      loginMode: true,
      accounts: [{ username: "kevon", fullName: "Kevon" }],
      allowGuest: true,
      onGuestLogin,
      onLogin: () => Promise.resolve({ ok: true }),
    });

    pressControl(runtime, "Log in as guest");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onGuestLogin).toHaveBeenCalledTimes(1);
  });

  it("passes the selected account and password to onLogin", async () => {
    const seen: { username: string; password: string }[] = [];
    const onLogin = (
      username: string,
      password: string,
    ): Promise<UnlockAttemptResult> => {
      seen.push({ username, password });
      return Promise.resolve({ ok: true });
    };
    const { runtime } = mountLockScreen({
      loginMode: true,
      accounts: [
        { username: "kevon", fullName: "Kevon" },
        { username: "ada", fullName: "Ada" },
      ],
      onLogin,
    });

    // Select the second account, then submit (allow a beat for the selection
    // state to apply before submitting).
    pressControl(runtime, "Log in as Ada");
    await new Promise((resolve) => setTimeout(resolve, 100));
    pressControl(runtime, "Log in");
    const deadline = Date.now() + 5000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ username: "ada" });
  });
});
