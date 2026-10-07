// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ProcessInfo,
  type ProcessSnapshot,
  type SevynApplicationManifest,
  type SevynProcessService,
  type SevynSystemService,
  type SystemHardwareSnapshot,
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
  permissions: ["hardware:query", "process:inspect"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

/** Shell-provided session summary (application workers, windows). */
export interface SystemMonitorModel {
  readonly runningApplicationSessions: number;
  readonly openWindows: number;
  readonly focusedWindow: string | undefined;
  readonly cursorKind: string;
  readonly frameExecutionCount: number;
  readonly activeWorkspace: string;
  readonly graphicsEngine?: string;
}

export interface SystemMonitorApplicationProps {
  readonly system?: SevynSystemService | undefined;
  readonly processes?: SevynProcessService | undefined;
  readonly model?: SystemMonitorModel | undefined;
}

const REFRESH_INTERVAL_MS = 2000;
const MAX_PROCESS_ROWS = 150;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${String(value >= 100 ? Math.round(value) : value.toFixed(1))} ${String(units[index])}`;
}

export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0s";
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0 || days > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${String(minutes)}m`);
  parts.push(`${String(seconds % 60)}s`);
  return parts.join(" ");
}

export function describeProcessState(state: string): string {
  switch (state.toUpperCase()) {
    case "R":
      return "Running";
    case "S":
      return "Sleeping";
    case "D":
      return "Disk wait";
    case "Z":
      return "Zombie";
    case "T":
    case "t":
      return "Stopped";
    case "I":
      return "Idle";
    case "X":
      return "Dead";
    case "W":
      return "Paging";
    default:
      return state.length > 0 ? state : "Unknown";
  }
}

/** Builds a `${number}%` dimension the framework's style system accepts. */
export function percentWidth(percent: number): `${number}%` {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return `${String(clamped)}%` as `${number}%`;
}

export function formatThroughput(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function filterProcesses(
  processes: readonly ProcessInfo[],
  query: string,
): readonly ProcessInfo[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return processes;
  return processes.filter(
    (process) =>
      process.name.toLowerCase().includes(needle) || String(process.pid).includes(needle),
  );
}

interface LiveState {
  hardware: SystemHardwareSnapshot | undefined;
  processes: ProcessSnapshot | undefined;
  error: string | undefined;
}

export function SystemMonitorApplication({
  system,
  processes,
  model,
}: SystemMonitorApplicationProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<"performance" | "processes">("performance");
  const [filter, setFilter] = useState("");
  const [live, setLive] = useState<LiveState>({
    hardware: undefined,
    processes: undefined,
    error: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const [hardware, processSnapshot] = await Promise.all([
          system?.snapshot(),
          processes?.snapshot(),
        ]);
        if (cancelled) return;
        setLive({ hardware, processes: processSnapshot, error: undefined });
      } catch (error) {
        if (cancelled) return;
        setLive((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "Failed to read metrics.",
        }));
      }
    };
    void refresh();
    const unsubscribeSystem = system?.subscribe(() => {
      void refresh();
    });
    const unsubscribeProcesses = processes?.subscribe(() => {
      void refresh();
    });
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribeSystem?.();
      unsubscribeProcesses?.();
    };
  }, [system, processes]);

  const filteredProcesses = useMemo(
    () => filterProcesses(live.processes?.processes ?? [], filter),
    [live.processes, filter],
  );
  const totalProcesses = live.processes?.processes.length ?? 0;
  const visibleProcesses = filteredProcesses.slice(0, MAX_PROCESS_ROWS);

  const hardware = live.hardware;
  const memoryUsed = hardware?.memoryUsedBytes ?? 0;
  const memoryTotal = hardware?.memoryTotalBytes ?? 0;
  const memoryPercent =
    memoryTotal > 0 ? Math.round((memoryUsed / memoryTotal) * 100) : 0;
  const cpuPercent = Math.round(hardware?.cpuPercent ?? 0);
  const corePercents = hardware?.cpuCorePercents ?? [];
  const disks = hardware?.disks ?? [];
  const networkInterfaces = hardware?.networkInterfaces ?? [];
  const uptime = hardware !== undefined ? formatUptime(hardware.uptimeSeconds) : "—";

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="System Monitor"
      style={styles.container}
    >
      <View style={styles.header}>
        <View style={styles.tabButtons}>
          <Pressable
            accessibilityRole="tab"
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
            accessibilityRole="tab"
            onPress={() => {
              setActiveTab("processes");
            }}
            style={activeTab === "processes" ? styles.tabButtonActive : styles.tabButton}
          >
            <Text
              style={activeTab === "processes" ? styles.tabTextActive : styles.tabText}
            >
              Processes ({totalProcesses})
            </Text>
          </Pressable>
        </View>
        <Text style={styles.uptimeLabel}>Uptime {uptime}</Text>
      </View>

      <ScrollView style={styles.content}>
        {live.error !== undefined ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{live.error}</Text>
          </View>
        ) : null}

        {activeTab === "performance" ? (
          <View style={styles.metricsGrid}>
            <View style={styles.metricCard}>
              <View style={styles.metricHeader}>
                <Text style={styles.metricTitle}>CPU Usage</Text>
                <Text style={styles.metricValue}>{String(cpuPercent)}%</Text>
              </View>
              <View style={styles.progressBar}>
                <View
                  style={{
                    ...styles.progressFill,
                    width: percentWidth(cpuPercent),
                    backgroundColor: "#10B981",
                  }}
                />
              </View>
              {corePercents.length > 0 ? (
                <View style={styles.coreList}>
                  {corePercents.map((corePercent, index) => (
                    <View key={`core-${String(index)}`} style={styles.coreRow}>
                      <Text style={styles.coreLabel}>Core {String(index)}</Text>
                      <View style={styles.coreBar}>
                        <View
                          style={{
                            ...styles.progressFill,
                            width: percentWidth(corePercent),
                            backgroundColor: "#3B82F6",
                          }}
                        />
                      </View>
                      <Text style={styles.coreValue}>
                        {String(Math.round(corePercent))}%
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.metricFooter}>{hardware?.cpuCores ?? 0} cores</Text>
              )}
            </View>

            <View style={styles.metricCard}>
              <View style={styles.metricHeader}>
                <Text style={styles.metricTitle}>Memory (RAM)</Text>
                <Text style={styles.metricValue}>
                  {formatBytes(memoryUsed)} / {formatBytes(memoryTotal)}
                </Text>
              </View>
              <View style={styles.progressBar}>
                <View
                  style={{
                    ...styles.progressFill,
                    width: percentWidth(memoryPercent),
                    backgroundColor: "#D7AC57",
                  }}
                />
              </View>
              <Text style={styles.metricFooter}>
                {String(memoryPercent)}% used •{" "}
                {formatBytes(Math.max(0, memoryTotal - memoryUsed))} available
              </Text>
            </View>

            {disks.length > 0 ? (
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <Text style={styles.metricTitle}>Storage</Text>
                </View>
                {disks.map((disk) => {
                  const diskPercent =
                    disk.totalBytes > 0
                      ? Math.round((disk.usedBytes / disk.totalBytes) * 100)
                      : 0;
                  return (
                    <View key={disk.mountPoint} style={styles.diskRow}>
                      <View style={styles.rowBetween}>
                        <Text style={styles.statLabel}>{disk.mountPoint}</Text>
                        <Text style={styles.statValue}>
                          {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                        </Text>
                      </View>
                      <View style={styles.progressBar}>
                        <View
                          style={{
                            ...styles.progressFill,
                            width: percentWidth(diskPercent),
                            backgroundColor: "#8B5CF6",
                          }}
                        />
                      </View>
                      <Text style={styles.metricFooter}>
                        {String(diskPercent)}% used • {formatBytes(disk.freeBytes)} free
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {networkInterfaces.length > 0 ? (
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <Text style={styles.metricTitle}>Network</Text>
                </View>
                {networkInterfaces.map((iface) => (
                  <View key={iface.name} style={styles.ifaceRow}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.statLabel}>{iface.name}</Text>
                      <Text style={styles.statValue}>
                        RX {formatThroughput(iface.rxBytesPerSecond)} • TX{" "}
                        {formatThroughput(iface.txBytesPerSecond)}
                      </Text>
                    </View>
                    <Text style={styles.metricFooter}>
                      Received {formatBytes(iface.rxBytesTotal)} • Sent{" "}
                      {formatBytes(iface.txBytesTotal)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {model !== undefined ? (
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <Text style={styles.metricTitle}>Application Sessions</Text>
                  <Text style={styles.metricValue}>
                    {String(model.runningApplicationSessions)}
                  </Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.statLabel}>Open windows:</Text>
                  <Text style={styles.statValue}>{String(model.openWindows)}</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.statLabel}>Focused window:</Text>
                  <Text style={styles.statValue}>{model.focusedWindow ?? "None"}</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.statLabel}>Frames rendered:</Text>
                  <Text style={styles.statValue}>{model.frameExecutionCount}</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.statLabel}>Active workspace:</Text>
                  <Text style={styles.statValue}>{model.activeWorkspace}</Text>
                </View>
              </View>
            ) : null}
          </View>
        ) : (
          <View>
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter by name or PID"
              placeholderTextColor="#6B7280"
              style={styles.filterInput}
            />
            <View style={styles.processList}>
              <View style={styles.processHeader}>
                <Text style={styles.colPid}>PID</Text>
                <Text style={styles.colName}>Name</Text>
                <Text style={styles.colState}>State</Text>
                <Text style={styles.colMemory}>Memory</Text>
              </View>
              {hardware === undefined && live.processes === undefined ? (
                <View style={styles.processRow}>
                  <Text style={styles.loadingText}>Reading processes…</Text>
                </View>
              ) : visibleProcesses.length === 0 ? (
                <View style={styles.processRow}>
                  <Text style={styles.loadingText}>
                    {filter.trim().length > 0
                      ? "No processes match the filter."
                      : "No processes reported."}
                  </Text>
                </View>
              ) : (
                visibleProcesses.map((process) => (
                  <View key={String(process.pid)} style={styles.processRow}>
                    <Text style={styles.colPid}>{String(process.pid)}</Text>
                    <Text style={styles.colName} numberOfLines={1} ellipsizeMode="tail">
                      {process.name}
                    </Text>
                    <Text style={styles.colState}>
                      {describeProcessState(process.state)}
                    </Text>
                    <Text style={styles.colMemory}>
                      {formatBytes(process.memoryBytes)}
                    </Text>
                  </View>
                ))
              )}
            </View>
            {filteredProcesses.length > MAX_PROCESS_ROWS ? (
              <Text style={styles.moreText}>
                Showing {String(MAX_PROCESS_ROWS)} of {String(filteredProcesses.length)}{" "}
                processes
              </Text>
            ) : null}
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
    minHeight: 44,
    backgroundColor: "#161920",
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  uptimeLabel: {
    fontSize: 11,
    color: "#6B7280",
  },
  content: {
    flex: 1,
    padding: 20,
  },
  errorCard: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "#EF4444",
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    maxWidth: 680,
  },
  errorText: {
    fontSize: 12,
    color: "#FCA5A5",
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
  coreList: {
    gap: 6,
    marginTop: 4,
  },
  coreRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  coreLabel: {
    width: 52,
    fontSize: 11,
    color: "#9CA3AF",
  },
  coreBar: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
  },
  coreValue: {
    width: 36,
    fontSize: 11,
    color: "#9CA3AF",
    textAlign: "right",
  },
  diskRow: {
    marginBottom: 12,
  },
  ifaceRow: {
    paddingVertical: 6,
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
  filterInput: {
    backgroundColor: "#1A1D24",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    color: "#F3F4F6",
    marginBottom: 12,
    maxWidth: 680,
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
  colPid: {
    width: 64,
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
  },
  colName: {
    flex: 2,
    fontSize: 12,
    color: "#F3F4F6",
    fontWeight: "500",
  },
  colState: {
    flex: 1,
    fontSize: 12,
    color: "#9CA3AF",
  },
  colMemory: {
    width: 80,
    fontSize: 12,
    color: "#F3F4F6",
    textAlign: "right",
  },
  processRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  loadingText: {
    fontSize: 12,
    color: "#6B7280",
  },
  moreText: {
    fontSize: 11,
    color: "#6B7280",
    marginTop: 8,
  },
});
