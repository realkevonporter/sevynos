import { useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type SystemMonitorModel,
  type SevynApplicationManifest,
} from "@sevynos/react-native";

export const systemMonitorManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.system-monitor",
  name: "System Monitor",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "SystemMonitor",
  developer: "SevynOS",
  icon: "icons/system-monitor.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export interface SystemMonitorApplicationProps {
  readonly model?: SystemMonitorModel | undefined;
}

export function SystemMonitorApplication({
  model,
}: SystemMonitorApplicationProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<"performance" | "processes">("performance");

  const sessions = model?.runningApplicationSessions ?? 2;
  const focused = model?.focusedWindow ?? "System Monitor";
  const frames = model?.frameExecutionCount ?? 1240;
  const workspace = model?.activeWorkspace ?? "workspace-1";

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="System Monitor"
      style={styles.container}
    >
      {/* Tab Switcher */}
      <View style={styles.header}>
        <View style={styles.tabButtons}>
          <Pressable
            onPress={() => {
              setActiveTab("performance");
            }}
            style={
              activeTab === "performance" ? styles.tabButtonActive : styles.tabButton
            }
          >
            <Text
              style={activeTab === "performance" ? styles.tabTextActive : styles.tabText}
            >
              Performance
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setActiveTab("processes");
            }}
            style={activeTab === "processes" ? styles.tabButtonActive : styles.tabButton}
          >
            <Text
              style={activeTab === "processes" ? styles.tabTextActive : styles.tabText}
            >
              Applications ({sessions})
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView style={styles.content}>
        {activeTab === "performance" ? (
          <View style={styles.metricsGrid}>
            {/* CPU Metric Card */}
            <View style={styles.metricCard}>
              <View style={styles.metricHeader}>
                <Text style={styles.metricTitle}>CPU Usage</Text>
                <Text style={styles.metricValue}>14%</Text>
              </View>
              <View style={styles.progressBar}>
                <View
                  style={{
                    ...styles.progressFill,
                    width: 28,
                    backgroundColor: "#10B981",
                  }}
                />
              </View>
              <Text style={styles.metricFooter}>8 Cores Active • 3.2 GHz</Text>
            </View>

            {/* Memory Metric Card */}
            <View style={styles.metricCard}>
              <View style={styles.metricHeader}>
                <Text style={styles.metricTitle}>Memory (RAM)</Text>
                <Text style={styles.metricValue}>1.4 GB / 8.0 GB</Text>
              </View>
              <View style={styles.progressBar}>
                <View
                  style={{
                    ...styles.progressFill,
                    width: 35,
                    backgroundColor: "#D7AC57",
                  }}
                />
              </View>
              <Text style={styles.metricFooter}>18% Used • 6.6 GB Available</Text>
            </View>

            {/* Genesis Compositor Card */}
            <View style={styles.metricCard}>
              <View style={styles.metricHeader}>
                <Text style={styles.metricTitle}>Genesis Wayland Compositor</Text>
                <Text style={styles.metricValue}>60 FPS</Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.statLabel}>Total Frames Rendered:</Text>
                <Text style={styles.statValue}>{frames}</Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.statLabel}>Active Workspace:</Text>
                <Text style={styles.statValue}>{workspace}</Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.statLabel}>Focused Window:</Text>
                <Text style={styles.statValue}>{focused}</Text>
              </View>
            </View>

            {/* Graphics Card */}
            <View style={styles.metricCard}>
              <View style={styles.metricHeader}>
                <Text style={styles.metricTitle}>Graphics & Hardware Engine</Text>
                <Text style={styles.metricValue}>Active</Text>
              </View>
              <Text style={styles.metricFooter}>
                DRM/KMS Framebuffer • Direct Hardware Acceleration
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.processList}>
            <View style={styles.processHeader}>
              <Text style={styles.colName}>Application</Text>
              <Text style={styles.colStatus}>Status</Text>
              <Text style={styles.colMemory}>Memory</Text>
            </View>

            <View style={styles.processRow}>
              <Text style={styles.colName}>System Monitor</Text>
              <Text style={styles.statusActive}>Focused</Text>
              <Text style={styles.colMemory}>42 MB</Text>
            </View>
            <View style={styles.processRow}>
              <Text style={styles.colName}>Genesis Shell</Text>
              <Text style={styles.statusRunning}>Running</Text>
              <Text style={styles.colMemory}>78 MB</Text>
            </View>
            <View style={styles.processRow}>
              <Text style={styles.colName}>Web Browser</Text>
              <Text style={styles.statusRunning}>Running</Text>
              <Text style={styles.colMemory}>120 MB</Text>
            </View>
            <View style={styles.processRow}>
              <Text style={styles.colName}>Notes</Text>
              <Text style={styles.statusIdle}>Idle</Text>
              <Text style={styles.colMemory}>34 MB</Text>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

export default SystemMonitorApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F1115",
  },
  header: {
    height: 44,
    backgroundColor: "#161920",
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  tabButtons: {
    flexDirection: "row",
    gap: 8,
  },
  tabButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  tabButtonActive: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(215, 172, 87, 0.2)",
    borderWidth: 1,
    borderColor: "#D7AC57",
  },
  tabText: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  tabTextActive: {
    fontSize: 12,
    color: "#D7AC57",
    fontWeight: "700",
  },
  content: {
    flex: 1,
    padding: 20,
  },
  metricsGrid: {
    gap: 16,
    maxWidth: 680,
  },
  metricCard: {
    backgroundColor: "#1A1D24",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 16,
  },
  metricHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  metricTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  metricValue: {
    fontSize: 14,
    fontWeight: "700",
    color: "#D7AC57",
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: 8,
    borderRadius: 4,
  },
  metricFooter: {
    fontSize: 11,
    color: "#6B7280",
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  statLabel: {
    fontSize: 12,
    color: "#9CA3AF",
  },
  statValue: {
    fontSize: 12,
    color: "#F3F4F6",
    fontWeight: "600",
  },
  processList: {
    backgroundColor: "#1A1D24",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
    maxWidth: 680,
  },
  processHeader: {
    flexDirection: "row",
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: "#161920",
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  colName: {
    flex: 2,
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
  },
  colStatus: {
    flex: 1,
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
  },
  colMemory: {
    width: 80,
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
    textAlign: "right",
  },
  processRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  statusActive: {
    flex: 1,
    fontSize: 11,
    color: "#D7AC57",
    fontWeight: "700",
  },
  statusRunning: {
    flex: 1,
    fontSize: 11,
    color: "#10B981",
    fontWeight: "600",
  },
  statusIdle: {
    flex: 1,
    fontSize: 11,
    color: "#6B7280",
  },
});
