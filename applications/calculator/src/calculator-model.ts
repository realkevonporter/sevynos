export type CalculatorOperator = "+" | "−" | "×" | "÷";

export interface CalculatorHistoryEntry {
  readonly expression: string;
  readonly result: string;
}

export interface CalculatorState {
  readonly display: string;
  readonly expression: string;
  readonly accumulator: number | null;
  readonly pendingOperator: CalculatorOperator | null;
  readonly lastOperator: CalculatorOperator | null;
  readonly lastOperand: number | null;
  readonly freshEntry: boolean;
  readonly error: string | null;
  readonly history: readonly CalculatorHistoryEntry[];
}

export type CalculatorAction =
  | { readonly type: "digit"; readonly digit: string }
  | { readonly type: "decimal" }
  | { readonly type: "operator"; readonly operator: CalculatorOperator }
  | { readonly type: "equals" }
  | { readonly type: "clear" }
  | { readonly type: "backspace" }
  | { readonly type: "negate" }
  | { readonly type: "percent" }
  | { readonly type: "recall"; readonly value: string };

export const MAX_ENTRY_DIGITS = 15;
export const MAX_HISTORY_ENTRIES = 8;
export const DIVIDE_BY_ZERO_MESSAGE = "Cannot divide by zero";

export function createCalculatorState(): CalculatorState {
  return {
    display: "0",
    expression: "",
    accumulator: null,
    pendingOperator: null,
    lastOperator: null,
    lastOperand: null,
    freshEntry: true,
    error: null,
    history: [],
  };
}

/**
 * Formats a computed value for the display. Rounds away binary floating-point
 * artifacts (0.1 + 0.2 renders as 0.3, not 0.30000000000000004) and falls back
 * to exponential notation when the value cannot fit the display.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "Error";
  const rounded = Number(value.toPrecision(12));
  if (rounded === 0) return "0";
  const plain = String(rounded);
  // Count significant digits only: strip the sign, the decimal point, and
  // leading zeros (e.g. "0.333333333333" carries 12 significant digits, not 13).
  const significantDigits = plain.replace(/[-.]/g, "").replace(/^0+/, "");
  if (significantDigits.length <= 12) return plain;
  return rounded.toExponential(5);
}

type Computation =
  | { readonly ok: true; readonly value: number; readonly text: string }
  | { readonly ok: false; readonly error: string };

function compute(left: number, operator: CalculatorOperator, right: number): Computation {
  switch (operator) {
    case "+":
      return { ok: true, value: left + right, text: formatNumber(left + right) };
    case "−":
      return { ok: true, value: left - right, text: formatNumber(left - right) };
    case "×":
      return { ok: true, value: left * right, text: formatNumber(left * right) };
    case "÷":
      if (right === 0) return { ok: false, error: DIVIDE_BY_ZERO_MESSAGE };
      return { ok: true, value: left / right, text: formatNumber(left / right) };
  }
}

function withError(state: CalculatorState, error: string): CalculatorState {
  return {
    ...state,
    display: "Error",
    expression: "",
    accumulator: null,
    pendingOperator: null,
    freshEntry: true,
    error,
  };
}

function appendHistory(
  state: CalculatorState,
  expression: string,
  result: string,
): readonly CalculatorHistoryEntry[] {
  return [...state.history, { expression, result }].slice(-MAX_HISTORY_ENTRIES);
}

export function calculatorReducer(
  state: CalculatorState,
  action: CalculatorAction,
): CalculatorState {
  const settled = state.error === null ? state : createCalculatorState();
  switch (action.type) {
    case "digit": {
      if (settled.freshEntry)
        return { ...settled, display: action.digit, freshEntry: false };
      if (settled.display.replace(/[-.]/g, "").length >= MAX_ENTRY_DIGITS) return settled;
      if (settled.display === "0") return { ...settled, display: action.digit };
      if (settled.display === "-0") return { ...settled, display: `-${action.digit}` };
      return { ...settled, display: `${settled.display}${action.digit}` };
    }
    case "decimal": {
      if (settled.freshEntry) return { ...settled, display: "0.", freshEntry: false };
      if (settled.display.includes(".")) return settled;
      return { ...settled, display: `${settled.display}.` };
    }
    case "operator": {
      const value = Number(settled.display);
      if (settled.pendingOperator !== null && settled.accumulator !== null) {
        if (!settled.freshEntry) {
          const result = compute(settled.accumulator, settled.pendingOperator, value);
          if (!result.ok) return withError(settled, result.error);
          return {
            ...settled,
            display: result.text,
            expression: `${result.text} ${action.operator}`,
            accumulator: result.value,
            pendingOperator: action.operator,
            freshEntry: true,
          };
        }
        return {
          ...settled,
          expression: `${formatNumber(settled.accumulator)} ${action.operator}`,
          pendingOperator: action.operator,
        };
      }
      return {
        ...settled,
        expression: `${settled.display} ${action.operator}`,
        accumulator: value,
        pendingOperator: action.operator,
        freshEntry: true,
      };
    }
    case "equals": {
      const value = Number(settled.display);
      if (settled.pendingOperator !== null && settled.accumulator !== null) {
        const result = compute(settled.accumulator, settled.pendingOperator, value);
        if (!result.ok) return withError(settled, result.error);
        const expression = `${formatNumber(settled.accumulator)} ${settled.pendingOperator} ${settled.display}`;
        return {
          ...settled,
          display: result.text,
          expression: "",
          accumulator: null,
          pendingOperator: null,
          lastOperator: settled.pendingOperator,
          lastOperand: value,
          freshEntry: true,
          history: appendHistory(settled, expression, result.text),
        };
      }
      if (settled.lastOperator !== null && settled.lastOperand !== null) {
        const result = compute(value, settled.lastOperator, settled.lastOperand);
        if (!result.ok) return withError(settled, result.error);
        const expression = `${settled.display} ${settled.lastOperator} ${formatNumber(settled.lastOperand)}`;
        return {
          ...settled,
          display: result.text,
          freshEntry: true,
          history: appendHistory(settled, expression, result.text),
        };
      }
      return settled;
    }
    case "clear":
      return { ...createCalculatorState(), history: settled.history };
    case "backspace": {
      if (settled.freshEntry) return settled;
      const next = settled.display.slice(0, -1);
      if (next === "" || next === "-") return { ...settled, display: "0" };
      return { ...settled, display: next };
    }
    case "negate": {
      if (settled.display === "0") return settled;
      const display = settled.display.startsWith("-")
        ? settled.display.slice(1)
        : `-${settled.display}`;
      return { ...settled, display, freshEntry: false };
    }
    case "percent": {
      const text = formatNumber(Number(settled.display) / 100);
      return { ...settled, display: text, freshEntry: true };
    }
    case "recall":
      return { ...settled, display: action.value, freshEntry: true };
  }
}
