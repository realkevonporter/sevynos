import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import { View, Text, Pressable } from "./primitives.js";
import { StyleSheet } from "./stylesheet.js";

export interface SevynErrorBoundaryProps {
  readonly children?: ReactNode;
  readonly fallback?: ((error: Error, reset: () => void) => ReactNode) | undefined;
  readonly onError?: ((error: Error, info: ErrorInfo) => void) | undefined;
  readonly title?: string | undefined;
}

interface SevynErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
}

export class SevynErrorBoundary extends Component<
  SevynErrorBoundaryProps,
  SevynErrorBoundaryState
> {
  public override state: SevynErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): SevynErrorBoundaryState {
    return { hasError: true, error };
  }

  #mounted = false;

  public override componentDidMount(): void {
    this.#mounted = true;
  }

  public override componentWillUnmount(): void {
    this.#mounted = false;
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("SevynErrorBoundary caught an error:", error.message, error.stack, info.componentStack);
    this.props.onError?.(error, info);
  }

  public reset = (): void => {
    this.state = { hasError: false, error: null };
    if (this.#mounted) {
      this.setState({ hasError: false, error: null });
    }
  };

  public override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback(this.state.error, this.reset);
      }

      return createElement(
        View,
        { style: styles.container },
        createElement(
          View,
          { style: styles.card },
          createElement(
            View,
            { style: styles.badge },
            createElement(Text, { style: styles.badgeText }, "⚠ System Recovered"),
          ),
          createElement(
            Text,
            { style: styles.title },
            this.props.title ?? "Application Encountered an Error",
          ),
          createElement(Text, { style: styles.message }, this.state.error.message),
          createElement(
            Pressable,
            {
              accessibilityRole: "button",
              accessibilityLabel: "Reload application",
              onPress: this.reset,
              style: styles.retryButton,
            },
            createElement(Text, { style: styles.retryButtonText }, "Reload Application"),
          ),
        ),
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#07090D",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    backgroundColor: "#121620",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(244, 109, 117, 0.3)",
    padding: 28,
    alignItems: "center",
  },
  badge: {
    backgroundColor: "rgba(244, 109, 117, 0.15)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 16,
  },
  badgeText: {
    color: "#F46D75",
    fontSize: 12,
    fontWeight: "700",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
    textAlign: "center",
  },
  message: {
    color: "#8B949E",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: "#D7AC57",
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: "#07090D",
    fontSize: 14,
    fontWeight: "700",
  },
});
