import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ApplicationSession } from "@sevynos/runtime";
import { SevynShellTheme } from "@sevynos/system-applications";

import type { ReactNativeSurfaceStore } from "../runtime/react-native-surface-store";
import { useMountedApplication } from "../runtime/use-mounted-application";

export interface ApplicationViewportProps {
  readonly store: ReactNativeSurfaceStore;
  readonly session: ApplicationSession;
  readonly onClose: (session: ApplicationSession) => Promise<void>;
}

export function ApplicationViewport(props: ApplicationViewportProps): JSX.Element {
  const mountedApplication = useMountedApplication(props.store);
  if (mountedApplication === undefined) {
    return (
      <View style={styles.loadingContainer}>
        <View style={styles.loadingMark}>
          <Text style={styles.loadingMarkText}>7</Text>
        </View>
        <Text style={styles.loadingText}>Preparing your application…</Text>
      </View>
    );
  }

  const RootComponent = mountedApplication.component;
  return (
    <View style={styles.container}>
      <View style={styles.applicationBar}>
        <View style={styles.titleGroup}>
          <View style={styles.applicationIndicator} />
          <Text numberOfLines={1} style={styles.applicationTitle}>
            {props.session.application.manifest.name}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={`Close ${props.session.application.manifest.name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={(): void => {
            void props.onClose(props.session);
          }}
          style={({ pressed }) => [styles.closeButton, pressed && styles.closePressed]}
        >
          <Text style={styles.closeButtonText}>×</Text>
        </Pressable>
      </View>
      <View style={styles.applicationContainer}>
        <RootComponent {...mountedApplication.props} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: SevynShellTheme.colors.backgroundRaised,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.xl,
    borderWidth: 1,
    flex: 1,
    marginHorizontal: SevynShellTheme.spacing.sm,
    overflow: "hidden",
  },
  applicationBar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderBottomColor: SevynShellTheme.colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    height: 52,
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  titleGroup: { alignItems: "center", flexDirection: "row", flex: 1 },
  applicationIndicator: {
    backgroundColor: SevynShellTheme.colors.gold,
    borderRadius: SevynShellTheme.radius.round,
    height: 7,
    marginRight: 10,
    width: 7,
  },
  applicationTitle: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    marginRight: 16,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "rgba(244, 109, 117, 0.11)",
    borderRadius: SevynShellTheme.radius.round,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  closePressed: { opacity: 0.58, transform: [{ scale: 0.92 }] },
  closeButtonText: {
    color: "#FF9AA0",
    fontSize: 20,
    fontWeight: "400",
    lineHeight: 22,
  },
  applicationContainer: { flex: 1 },
  loadingContainer: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.backgroundRaised,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.xl,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    marginHorizontal: SevynShellTheme.spacing.sm,
  },
  loadingMark: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderRadius: 18,
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  loadingMarkText: {
    color: SevynShellTheme.colors.gold,
    fontSize: 26,
    fontWeight: "800",
  },
  loadingText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    marginTop: 16,
  },
});
