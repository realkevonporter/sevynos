import { describe, expect, it, vi } from "vitest";
import React, { createElement, type FC } from "react";
import { SevynErrorBoundary } from "./error-boundary.js";
import { Text, View } from "./primitives.js";

const ProblemChild: FC<{ shouldThrow?: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) {
    throw new Error("Deliberate test render crash");
  }
  return createElement(View, null, createElement(Text, null, "Normal child"));
};

describe("SevynErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    const element = createElement(
      SevynErrorBoundary,
      null,
      createElement(ProblemChild, { shouldThrow: false }),
    );
    expect(element).toBeDefined();
    const boundary = new SevynErrorBoundary({
      children: createElement(Text, null, "OK"),
    });
    expect(boundary.render()).toBeDefined();
  });

  it("catches errors and renders fallback card", () => {
    const onError = vi.fn();
    const boundary = new SevynErrorBoundary({
      title: "Settings",
      onError,
    });
    boundary.state = {
      hasError: true,
      error: new Error("No supported audio output"),
    };

    const rendered = boundary.render() as React.ReactElement<{ style?: unknown }>;
    expect(rendered).toBeDefined();
    expect(rendered.props.style).toBeDefined();
  });

  it("allows custom fallback renderer and reset action", () => {
    let resetCalled = false;
    const boundary = new SevynErrorBoundary({
      fallback: (error, reset) => {
        return createElement(
          Text,
          {
            onPress: () => {
              resetCalled = true;
              reset();
            },
          },
          `Caught: ${error.message}`,
        );
      },
    });
    boundary.state = {
      hasError: true,
      error: new Error("Critical crash"),
    };

    const fallbackEl = boundary.render() as React.ReactElement<{
      onPress: () => void;
      children: string;
    }>;
    expect(fallbackEl.props.children).toBe("Caught: Critical crash");
    fallbackEl.props.onPress();
    expect(resetCalled).toBe(true);
    expect(boundary.state.hasError).toBe(false);
  });
});
