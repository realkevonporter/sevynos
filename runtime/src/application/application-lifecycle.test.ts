import { describe, expect, it, vi } from "vitest";

import { ApplicationLifecycle } from "./application-lifecycle";
import { ApplicationState } from "./application-state";

describe("ApplicationLifecycle", () => {
  it("starts in the launching state by default", () => {
    const lifecycle = new ApplicationLifecycle();

    expect(lifecycle.getState()).toBe(ApplicationState.Launching);

    expect(lifecycle.getSnapshot()).toEqual({
      state: ApplicationState.Launching,
      previousState: null,
      version: 0,
    });
  });

  it("transitions from launching to foreground", () => {
    const lifecycle = new ApplicationLifecycle();

    const snapshot = lifecycle.transitionTo(ApplicationState.Foreground);

    expect(snapshot).toEqual({
      state: ApplicationState.Foreground,
      previousState: ApplicationState.Launching,
      version: 1,
    });
  });

  it("supports foreground and background transitions", () => {
    const lifecycle = new ApplicationLifecycle();

    lifecycle.transitionTo(ApplicationState.Foreground);

    lifecycle.transitionTo(ApplicationState.Background);

    expect(lifecycle.isBackground()).toBe(true);

    lifecycle.transitionTo(ApplicationState.Foreground);

    expect(lifecycle.isForeground()).toBe(true);
  });

  it("supports suspending a background application", () => {
    const lifecycle = new ApplicationLifecycle();

    lifecycle.transitionTo(ApplicationState.Foreground);

    lifecycle.transitionTo(ApplicationState.Background);

    lifecycle.transitionTo(ApplicationState.Suspended);

    expect(lifecycle.isSuspended()).toBe(true);
  });

  it("rejects an invalid transition", () => {
    const lifecycle = new ApplicationLifecycle();

    expect(() => {
      lifecycle.transitionTo(ApplicationState.Suspended);
    }).toThrow('Invalid application lifecycle transition: "launching" → "suspended".');
  });

  it("does not increment the version for the current state", () => {
    const lifecycle = new ApplicationLifecycle(ApplicationState.Foreground);

    const snapshot = lifecycle.transitionTo(ApplicationState.Foreground);

    expect(snapshot.version).toBe(0);
    expect(snapshot.previousState).toBeNull();
  });

  it("notifies subscribers after a transition", () => {
    const lifecycle = new ApplicationLifecycle();

    const listener = vi.fn();

    lifecycle.subscribe(listener);

    lifecycle.transitionTo(ApplicationState.Foreground);

    expect(listener).toHaveBeenCalledTimes(1);

    expect(listener).toHaveBeenCalledWith({
      state: ApplicationState.Foreground,
      previousState: ApplicationState.Launching,
      version: 1,
    });
  });

  it("allows subscribers to unsubscribe", () => {
    const lifecycle = new ApplicationLifecycle();

    const listener = vi.fn();

    const unsubscribe = lifecycle.subscribe(listener);

    unsubscribe();

    lifecycle.transitionTo(ApplicationState.Foreground);

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports normal application termination", () => {
    const lifecycle = new ApplicationLifecycle();

    lifecycle.transitionTo(ApplicationState.Foreground);

    lifecycle.transitionTo(ApplicationState.Terminating);

    lifecycle.transitionTo(ApplicationState.Stopped);

    expect(lifecycle.isStopped()).toBe(true);
    expect(lifecycle.isTerminal()).toBe(true);
  });
});
