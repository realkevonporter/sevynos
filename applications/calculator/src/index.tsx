import { createElement, useMemo, useReducer, type ReactElement } from "react";
import {
  Pressable,
  SafeAreaView,
  SevynApplicationSdkProvider,
  StyleSheet,
  Text,
  View,
  resolveSevynColors,
  sevynTokens,
  useOptionalSevynApplicationSdk,
  type SevynAccent,
  type SevynAppearance,
  type SevynApplicationManifest,
  type SevynApplicationSdk,
  type SevynSemanticColors,
} from "@sevynos/react-native";
import {
  calculatorReducer,
  createCalculatorState,
  type CalculatorAction,
  type CalculatorOperator,
} from "./calculator-model.js";

export * from "./calculator-model.js";

export const calculatorManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.calculator",
  name: "Calculator",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Calculator",
  developer: "SevynOS",
  icon: "icons/calculator.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [],
  services: [],
  windowModes: ["standard", "utility"],
  instanceMode: "multiple",
};

export const calculatorApplicationBundle = `(() => {
  const { AppRegistry } = globalThis.__SEVYN_MODULES__["react-native"];
  const { CalculatorApplication } = globalThis.__SEVYN_MODULES__["@sevynos/app-calculator"];
  AppRegistry.registerComponent("Calculator", () => CalculatorApplication);
})();`;

type KeyKind = "digit" | "utility" | "operator" | "equals";

interface CalculatorKey {
  readonly label: string;
  readonly ariaLabel: string;
  readonly action: CalculatorAction;
  readonly kind: KeyKind;
}

const digitKey = (digit: string): CalculatorKey => ({
  label: digit,
  ariaLabel: digit,
  action: { type: "digit", digit },
  kind: "digit",
});

const KEY_ROWS: readonly (readonly CalculatorKey[])[] = [
  [
    { label: "C", ariaLabel: "Clear", action: { type: "clear" }, kind: "utility" },
    {
      label: "⌫",
      ariaLabel: "Backspace, delete last digit",
      action: { type: "backspace" },
      kind: "utility",
    },
    { label: "%", ariaLabel: "Percent", action: { type: "percent" }, kind: "utility" },
    {
      label: "÷",
      ariaLabel: "Divide",
      action: { type: "operator", operator: "÷" },
      kind: "operator",
    },
  ],
  [
    digitKey("7"),
    digitKey("8"),
    digitKey("9"),
    {
      label: "×",
      ariaLabel: "Multiply",
      action: { type: "operator", operator: "×" },
      kind: "operator",
    },
  ],
  [
    digitKey("4"),
    digitKey("5"),
    digitKey("6"),
    {
      label: "−",
      ariaLabel: "Subtract",
      action: { type: "operator", operator: "−" },
      kind: "operator",
    },
  ],
  [
    digitKey("1"),
    digitKey("2"),
    digitKey("3"),
    {
      label: "+",
      ariaLabel: "Add",
      action: { type: "operator", operator: "+" },
      kind: "operator",
    },
  ],
  [
    {
      label: "±",
      ariaLabel: "Negate, change sign",
      action: { type: "negate" },
      kind: "utility",
    },
    digitKey("0"),
    {
      label: ".",
      ariaLabel: "Decimal point",
      action: { type: "decimal" },
      kind: "digit",
    },
    { label: "=", ariaLabel: "Equals", action: { type: "equals" }, kind: "equals" },
  ],
];

/**
 * The keyboard fields the calculator reads. Declared structurally so the
 * application only depends on the public `@sevynos/react-native` API.
 */
interface CalculatorKeyboardEvent {
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

function keyActionForKeyboard(key: string): CalculatorAction | undefined {
  if (/^[0-9]$/.test(key)) return { type: "digit", digit: key };
  switch (key) {
    case ".":
    case ",":
      return { type: "decimal" };
    case "+":
      return { type: "operator", operator: "+" satisfies CalculatorOperator };
    case "-":
      return { type: "operator", operator: "−" satisfies CalculatorOperator };
    case "*":
    case "x":
    case "X":
      return { type: "operator", operator: "×" satisfies CalculatorOperator };
    case "/":
      return { type: "operator", operator: "÷" satisfies CalculatorOperator };
    case "Enter":
    case "=":
      return { type: "equals" };
    case "Backspace":
      return { type: "backspace" };
    case "Escape":
    case "Delete":
      return { type: "clear" };
    case "%":
      return { type: "percent" };
    default:
      return undefined;
  }
}

function displayFontSize(display: string): number {
  const length = display.length;
  if (length > 12) return 30;
  if (length > 9) return 38;
  if (length > 6) return 48;
  return 60;
}

function keyColors(
  kind: KeyKind,
  colors: SevynSemanticColors,
): { readonly background: string; readonly foreground: string } {
  switch (kind) {
    case "operator":
    case "equals":
      return { background: colors.accent, foreground: colors.accentText };
    case "utility":
      return { background: colors.materialStrong, foreground: colors.text };
    case "digit":
      return { background: colors.material, foreground: colors.text };
  }
}

export interface CalculatorApplicationProps {
  readonly appearance?: SevynAppearance | undefined;
  readonly accent?: SevynAccent | undefined;
}

export function CalculatorApplication(props: CalculatorApplicationProps): ReactElement {
  const sdk = useOptionalSevynApplicationSdk();
  const colors = useMemo(
    () =>
      resolveSevynColors(
        props.appearance ?? sdk?.theme.appearance ?? "dark",
        props.accent ?? sdk?.theme.accent ?? "gold",
      ),
    [props.accent, props.appearance, sdk?.theme.accent, sdk?.theme.appearance],
  );
  const [state, dispatch] = useReducer(
    calculatorReducer,
    undefined,
    createCalculatorState,
  );

  const handleKeyDown = (event: CalculatorKeyboardEvent): void => {
    if (event.control || event.meta || event.alt) return;
    const action = keyActionForKeyboard(event.key);
    if (action !== undefined) dispatch(action);
  };

  const recentHistory = state.history.slice(-4).reverse();
  const isError = state.error !== null;

  return (
    <SafeAreaView
      id="calculator.app"
      label="Calculator"
      role="application"
      style={{ backgroundColor: colors.canvas, flexGrow: 1 }}
    >
      <View
        id="calculator.display"
        style={{
          align: "end",
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          gap: 4,
          justify: "end",
          margin: sevynTokens.spacing.md,
          marginBottom: sevynTokens.spacing.sm,
          minHeight: 148,
          padding: sevynTokens.spacing.lg,
          radius: sevynTokens.radius.lg,
        }}
      >
        <Text
          id="calculator.expression"
          label={state.expression === "" ? "No pending operation" : state.expression}
          style={{
            color: colors.textMuted,
            fontSize: 15,
            fontWeight: 600,
            textAlign: "right",
          }}
          text={state.expression === "" ? " " : state.expression}
        />
        <Text
          id="calculator.value"
          label={state.error ?? `Result: ${state.display}`}
          role="status"
          style={{
            color: isError ? colors.danger : colors.text,
            fontSize: displayFontSize(state.display),
            fontWeight: 700,
            textAlign: "right",
          }}
          text={state.error ?? state.display}
        />
      </View>

      {recentHistory.length === 0 ? null : (
        <View
          id="calculator.history"
          style={{
            gap: 4,
            marginHorizontal: sevynTokens.spacing.md,
            marginBottom: sevynTokens.spacing.sm,
          }}
        >
          <Text
            id="calculator.history.label"
            style={{
              color: colors.textMuted,
              fontSize: 10,
              fontWeight: 700,
            }}
            text="HISTORY — TAP TO REUSE"
          />
          {recentHistory.map((entry, index) => (
            <Pressable
              id={`calculator.history.${String(index)}`}
              key={`${entry.expression}=${entry.result}`}
              label={`Reuse result ${entry.result} from ${entry.expression}`}
              onPress={(): void => {
                dispatch({ type: "recall", value: entry.result });
              }}
              role="button"
              style={{
                align: "center",
                backgroundColor: colors.material,
                borderColor: colors.separator,
                borderWidth: 1,
                direction: "row",
                justify: "space-between",
                paddingHorizontal: 12,
                paddingVertical: 7,
                radius: sevynTokens.radius.sm,
              }}
            >
              <Text
                id={`calculator.history.${String(index)}.expression`}
                style={{ color: colors.textMuted, fontSize: 11 }}
                text={entry.expression}
              />
              <Text
                id={`calculator.history.${String(index)}.result`}
                style={{ color: colors.text, fontSize: 13, fontWeight: 700 }}
                text={`= ${entry.result}`}
              />
            </Pressable>
          ))}
        </View>
      )}

      <View
        id="calculator.keys"
        style={{
          flexGrow: 1,
          gap: 8,
          padding: sevynTokens.spacing.md,
          paddingTop: 0,
        }}
      >
        {KEY_ROWS.map((row, rowIndex) => (
          <View
            id={`calculator.row-${String(rowIndex + 1)}`}
            key={`row-${String(rowIndex + 1)}`}
            style={{ direction: "row", flexGrow: 1, gap: 8 }}
          >
            {row.map((key) => {
              const palette = keyColors(key.kind, colors);
              return (
                <Pressable
                  id={`calculator.key.${key.ariaLabel.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}
                  key={key.label}
                  label={key.ariaLabel}
                  onKeyDown={handleKeyDown}
                  onPress={(): void => {
                    dispatch(key.action);
                  }}
                  role="button"
                  style={{
                    align: "center",
                    backgroundColor: palette.background,
                    flexGrow: 1,
                    justify: "center",
                    minHeight: 56,
                    radius: sevynTokens.radius.md,
                  }}
                >
                  <Text
                    id={`calculator.key.${key.label}.label`}
                    style={{
                      color: palette.foreground,
                      fontSize: key.kind === "digit" ? 26 : 22,
                      fontWeight: 600,
                      textAlign: "center",
                    }}
                    text={key.label}
                  />
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      <Text
        id="calculator.hint.text"
        style={{
          color: colors.textMuted,
          fontSize: 10,
          paddingBottom: 10,
          paddingHorizontal: sevynTokens.spacing.md,
          textAlign: "center",
        }}
        text="Keyboard: digits and + − * / · Enter = · Backspace deletes · Esc clears"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  providerRoot: { flexGrow: 1 },
});

export function createCalculatorApplicationElement(
  sdk: SevynApplicationSdk,
): ReactElement {
  return createElement(
    SevynApplicationSdkProvider,
    { sdk },
    createElement(
      View,
      { style: styles.providerRoot },
      createElement(CalculatorApplication),
    ),
  ) as ReactElement;
}
