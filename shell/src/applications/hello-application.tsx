import type { JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ReactNativeApplicationProps } from "@sevynos/runtime";

export function HelloApplication(props: ReactNativeApplicationProps): JSX.Element {

  return (
    <View style={[styles.container]}>
      <Text style={styles.symbol}>7</Text>

      <Text style={styles.title}>Hello from SevynOS</Text>

      <Text style={styles.subtitle}>Application: {props.applicationId}</Text>

      <Text style={styles.session}>Session: {props.sessionId}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#111111",
  },

  symbol: {
    marginBottom: 20,
    color: "#ffffff",
    fontSize: 72,
    fontWeight: "800",
  },

  title: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
  },

  subtitle: {
    marginTop: 12,
    color: "#b7b7b7",
    fontSize: 15,
    textAlign: "center",
  },

  session: {
    marginTop: 6,
    color: "#777777",
    fontSize: 12,
    textAlign: "center",
  },
});
