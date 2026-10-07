import { describe, expect, it } from "vitest";
import {
  DIVIDE_BY_ZERO_MESSAGE,
  MAX_ENTRY_DIGITS,
  calculatorReducer,
  createCalculatorState,
  formatNumber,
  type CalculatorAction,
  type CalculatorState,
} from "./calculator-model.js";

function run(actions: readonly CalculatorAction[]): CalculatorState {
  return actions.reduce(calculatorReducer, createCalculatorState());
}

const digit = (digit: string): CalculatorAction => ({ type: "digit", digit });
const typeNumber = (value: string): CalculatorAction[] =>
  Array.from(value, (character) =>
    character === "." ? { type: "decimal" } : digit(character),
  );

describe("calculator model", () => {
  it("enters digits and a single decimal point", () => {
    const state = run([...typeNumber("12"), { type: "decimal" }, digit("5")]);
    expect(state.display).toBe("12.5");
    const doubled = run([
      ...typeNumber("3"),
      { type: "decimal" },
      { type: "decimal" },
      digit("1"),
    ]);
    expect(doubled.display).toBe("3.1");
  });

  it("starts a fresh entry after an operator", () => {
    const state = run([
      ...typeNumber("9"),
      { type: "operator", operator: "+" },
      digit("1"),
    ]);
    expect(state.display).toBe("1");
    expect(state.expression).toBe("9 +");
  });

  it("adds, subtracts, multiplies and divides", () => {
    expect(
      run([
        ...typeNumber("2"),
        { type: "operator", operator: "+" },
        ...typeNumber("3"),
        { type: "equals" },
      ]).display,
    ).toBe("5");
    expect(
      run([
        ...typeNumber("9"),
        { type: "operator", operator: "−" },
        ...typeNumber("4"),
        { type: "equals" },
      ]).display,
    ).toBe("5");
    expect(
      run([
        ...typeNumber("6"),
        { type: "operator", operator: "×" },
        ...typeNumber("7"),
        { type: "equals" },
      ]).display,
    ).toBe("42");
    expect(
      run([
        ...typeNumber("8"),
        { type: "operator", operator: "÷" },
        ...typeNumber("2"),
        { type: "equals" },
      ]).display,
    ).toBe("4");
  });

  it("chains operations left to right", () => {
    const state = run([
      ...typeNumber("2"),
      { type: "operator", operator: "+" },
      ...typeNumber("3"),
      { type: "operator", operator: "×" },
      ...typeNumber("4"),
      { type: "equals" },
    ]);
    expect(state.display).toBe("20");
  });

  it("replaces the pending operator when pressed twice", () => {
    const state = run([
      ...typeNumber("5"),
      { type: "operator", operator: "+" },
      { type: "operator", operator: "×" },
      ...typeNumber("2"),
      { type: "equals" },
    ]);
    expect(state.display).toBe("10");
    expect(state.expression).toBe("");
  });

  it("repeats the last operation on repeated equals", () => {
    const state = run([
      ...typeNumber("5"),
      { type: "operator", operator: "+" },
      ...typeNumber("2"),
      { type: "equals" },
      { type: "equals" },
    ]);
    expect(state.display).toBe("9");
  });

  it("reports divide by zero as an error and recovers on next input", () => {
    const errored = run([
      ...typeNumber("1"),
      { type: "operator", operator: "÷" },
      ...typeNumber("0"),
      { type: "equals" },
    ]);
    expect(errored.error).toBe(DIVIDE_BY_ZERO_MESSAGE);
    expect(errored.display).toBe("Error");
    const recovered = calculatorReducer(errored, digit("7"));
    expect(recovered.error).toBeNull();
    expect(recovered.display).toBe("7");
  });

  it("clears the entry and pending operation", () => {
    const state = run([
      ...typeNumber("5"),
      { type: "operator", operator: "+" },
      { type: "clear" },
    ]);
    expect(state.display).toBe("0");
    expect(state.pendingOperator).toBeNull();
    expect(state.expression).toBe("");
  });

  it("deletes digits with backspace", () => {
    expect(run([...typeNumber("123"), { type: "backspace" }]).display).toBe("12");
    expect(run([...typeNumber("5"), { type: "backspace" }]).display).toBe("0");
    expect(
      run([...typeNumber("5"), { type: "negate" }, { type: "backspace" }]).display,
    ).toBe("0");
  });

  it("negates the current entry and converts percent", () => {
    expect(run([...typeNumber("5"), { type: "negate" }]).display).toBe("-5");
    expect(
      run([...typeNumber("5"), { type: "negate" }, { type: "negate" }]).display,
    ).toBe("5");
    expect(run([...typeNumber("50"), { type: "percent" }]).display).toBe("0.5");
  });

  it("records history entries on equals", () => {
    const state = run([
      ...typeNumber("2"),
      { type: "operator", operator: "+" },
      ...typeNumber("2"),
      { type: "equals" },
    ]);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toEqual({ expression: "2 + 2", result: "4" });
    const recalled = calculatorReducer(state, {
      type: "recall",
      value: state.history[0]?.result ?? "",
    });
    expect(recalled.display).toBe("4");
    expect(recalled.freshEntry).toBe(true);
  });

  it("limits entry length", () => {
    const state = run(Array.from({ length: 30 }, () => digit("9")));
    expect(state.display.replace(/[-.]/g, "").length).toBeLessThanOrEqual(
      MAX_ENTRY_DIGITS,
    );
  });

  it("formats numbers without floating-point artifacts", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1 / 3)).toBe("0.333333333333");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(1e16)).toContain("e");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("Error");
  });
});
