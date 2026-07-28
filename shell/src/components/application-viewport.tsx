import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ApplicationSession } from "@sevynos/runtime";

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
        <Text style={styles.loadingText}>Starting application…</Text>
      </View>
    );
  }

  const RootComponent = mountedApplication.component;

  const closeApplication = (): void => {
    void props.onClose(props.session);
  };

  return (
    <View style={styles.container}>
      <View style={styles.systemBar}>
        <Text numberOfLines={1} style={styles.applicationTitle}>
          {props.session.application.manifest.name}
        </Text>

        <Pressable
          accessibilityLabel="Close application"
          onPress={closeApplication}
          style={styles.closeButton}
        >
          <Text style={styles.closeButtonText}>Close</Text>
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
    flex: 1,
    backgroundColor: "#000000",
  },

  systemBar: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#333333",
    backgroundColor: "#171717",
  },

  applicationTitle: {
    flex: 1,
    marginRight: 16,
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
  },

  closeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#2a2a2a",
  },

  closeButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },

  applicationContainer: {
    flex: 1,
  },

  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111111",
  },

  loadingText: {
    color: "#ffffff",
  },
});
