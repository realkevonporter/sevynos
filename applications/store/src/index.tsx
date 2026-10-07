import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  SevynIcon,
  StyleSheet,
  Text,
  TextInput,
  View,
  type FileSystemEntry,
  type SevynApplicationManifest,
  type SevynFileSystem,
} from "@sevynos/react-native";
import {
  OsUpdateService,
  defaultAppCatalogFeedUrl,
  type AppCatalogEntry,
  type StagedUpdate,
  type UpdateCheckResult,
} from "@sevynos/os-update";
import {
  describeSignatureStatus,
  formatBytes,
  installedAppSubtitle,
  isBundleFilename,
  loadAppCatalog,
  mergeCatalogWithInstalled,
  selectAppUpdates,
  type BundlePreview,
  type CatalogAppView,
  type CatalogLoadResult,
  type InstalledAppInfo,
} from "./store-model.js";

export const storeManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.store",
  name: "Software",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Software",
  developer: "SevynOS",
  icon: "icons/store.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["network", "filesystem.read"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export interface StoreApplicationProps {
  /** Seed for the installed-app list; replaced by onRefreshApps when provided. */
  readonly installedApps?: readonly InstalledAppInfo[] | undefined;
  /** Reads the installed-application catalog from the real app registry. */
  readonly onRefreshApps?: (() => Promise<readonly InstalledAppInfo[]>) | undefined;
  /**
   * Installs a `.sevyn` bundle from a filesystem path into the real app
   * registry (same code path as `sevyn install`). The host resolves the
   * app-scoped virtual path the file picker returns.
   */
  readonly onInstallApp?: ((bundlePath: string) => Promise<InstalledAppInfo>) | undefined;
  /** Removes an app from the real app registry (protected apps rejected). */
  readonly onUninstallApp?: ((appId: string) => Promise<void>) | undefined;
  /**
   * Extracts a bundle's manifest.json for pre-install review. The host
   * implements this with the runtime bundle extractor; the store sandbox
   * cannot unzip bundles itself.
   */
  readonly onInspectBundle?: ((bundlePath: string) => Promise<BundlePreview>) | undefined;
  /**
   * Downloads a catalog entry's bundle (verifying its sha256) and installs it
   * through the real app registry. Host-implemented.
   */
  readonly onInstallCatalogEntry?:
    ((entry: AppCatalogEntry) => Promise<InstalledAppInfo>) | undefined;
  /** The host's shared OS update service (same instance Settings uses). */
  readonly update?: OsUpdateService | undefined;
  readonly power?: { restart(): Promise<void> } | undefined;
  /** App-scoped filesystem for the sideload file picker. */
  readonly filesystem?: SevynFileSystem | undefined;
  readonly catalogFeedUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

type StoreTab = "discover" | "installed" | "updates";

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; result: CatalogLoadResult }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

interface DownloadProgress {
  readonly received: number;
  readonly total: number;
}

const TABS: readonly {
  id: StoreTab;
  label: string;
  icon: "globe" | "package" | "refresh";
}[] = [
  { id: "discover", label: "Discover", icon: "globe" },
  { id: "installed", label: "Installed", icon: "package" },
  { id: "updates", label: "Updates", icon: "refresh" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StoreApplication({
  installedApps: initialInstalledApps,
  onRefreshApps,
  onInstallApp,
  onUninstallApp,
  onInspectBundle,
  onInstallCatalogEntry,
  update,
  power,
  filesystem,
  catalogFeedUrl,
  fetchImpl,
}: StoreApplicationProps): JSX.Element {
  const [tab, setTab] = useState<StoreTab>("discover");
  const [installed, setInstalled] = useState<readonly InstalledAppInfo[]>(
    initialInstalledApps ?? [],
  );
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installedError, setInstalledError] = useState<string | undefined>(undefined);
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "loading" });
  const [busyEntry, setBusyEntry] = useState<string | undefined>(undefined);
  const [entryError, setEntryError] = useState<string | undefined>(undefined);
  const [confirmUninstallId, setConfirmUninstallId] = useState<string | undefined>(
    undefined,
  );
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string>(update?.status ?? "idle");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | undefined>(
    update?.lastResult,
  );
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | undefined>(
    undefined,
  );
  const [stagedUpdate, setStagedUpdate] = useState<StagedUpdate | undefined>(undefined);
  // Sideload dialog state.
  const [sideloadOpen, setSideloadOpen] = useState(false);
  const [sideloadDir, setSideloadDir] = useState("/Downloads");
  const [sideloadEntries, setSideloadEntries] = useState<readonly FileSystemEntry[]>([]);
  const [sideloadLoading, setSideloadLoading] = useState(false);
  const [sideloadError, setSideloadError] = useState<string | undefined>(undefined);
  const [selectedBundle, setSelectedBundle] = useState<string | undefined>(undefined);
  const [bundlePreview, setBundlePreview] = useState<BundlePreview | undefined>(
    undefined,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sideloadBusy, setSideloadBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshInstalled = useCallback(async () => {
    if (!onRefreshApps) return;
    setInstalledLoading(true);
    setInstalledError(undefined);
    try {
      const apps = await onRefreshApps();
      if (mountedRef.current) setInstalled(apps);
    } catch (error) {
      if (mountedRef.current) setInstalledError(errorMessage(error));
    } finally {
      if (mountedRef.current) setInstalledLoading(false);
    }
  }, [onRefreshApps]);

  const loadCatalog = useCallback(async () => {
    setCatalogState({ kind: "loading" });
    setEntryError(undefined);
    try {
      const result = await loadAppCatalog(
        catalogFeedUrl ?? defaultAppCatalogFeedUrl(),
        fetchImpl ?? fetch,
      );
      if (!mountedRef.current) return;
      if (result === undefined) {
        setCatalogState({
          kind: "unavailable",
          reason: "The app catalog could not be reached.",
        });
      } else {
        setCatalogState({ kind: "ready", result });
      }
    } catch (error) {
      if (mountedRef.current)
        setCatalogState({ kind: "error", message: errorMessage(error) });
    }
  }, [catalogFeedUrl, fetchImpl]);

  useEffect(() => {
    void refreshInstalled();
    void loadCatalog();
  }, [refreshInstalled, loadCatalog]);

  // Mirror the shared OS update service state (same instance Settings uses).
  useEffect(() => {
    if (!update) return undefined;
    setUpdateStatus(update.status);
    setUpdateResult(update.lastResult);
    return update.subscribe(() => {
      setUpdateStatus(update.status);
      setUpdateResult(update.lastResult);
    });
  }, [update]);

  const handleInstallCatalogEntry = useCallback(
    (entry: AppCatalogEntry) => {
      if (!onInstallCatalogEntry || busyEntry !== undefined) return;
      setBusyEntry(entry.id);
      setEntryError(undefined);
      void onInstallCatalogEntry(entry)
        .then(() => refreshInstalled())
        .catch((error: unknown) => {
          setEntryError(`Could not install ${entry.name}: ${errorMessage(error)}`);
        })
        .finally(() => {
          if (mountedRef.current) setBusyEntry(undefined);
        });
    },
    [onInstallCatalogEntry, busyEntry, refreshInstalled],
  );

  const handleUninstall = useCallback(
    (appId: string) => {
      if (!onUninstallApp) return;
      if (confirmUninstallId !== appId) {
        setConfirmUninstallId(appId);
        return;
      }
      setConfirmUninstallId(undefined);
      setInstalledError(undefined);
      void onUninstallApp(appId)
        .then(() => refreshInstalled())
        .catch((error: unknown) => {
          setInstalledError(`Could not uninstall: ${errorMessage(error)}`);
        });
    },
    [onUninstallApp, confirmUninstallId, refreshInstalled],
  );

  const handleCheckForUpdates = useCallback(() => {
    if (!update || updateBusy) return;
    setUpdateBusy(true);
    void update
      .checkNow()
      .catch((error: unknown) => {
        console.warn("update check failed:", error);
      })
      .finally(() => {
        if (mountedRef.current) setUpdateBusy(false);
      });
  }, [update, updateBusy]);

  const handleDownloadUpdate = useCallback(() => {
    if (!update || updateStatus === "downloading") return;
    setDownloadProgress({ received: 0, total: 0 });
    void update
      .downloadUpdate((received, total) => {
        if (mountedRef.current) setDownloadProgress({ received, total });
      })
      .then((staged) => {
        if (mountedRef.current) {
          setStagedUpdate(staged);
          setDownloadProgress(undefined);
        }
      })
      .catch((error: unknown) => {
        console.warn("update download failed:", error);
        if (mountedRef.current) setDownloadProgress(undefined);
      });
  }, [update, updateStatus]);

  const handleApplyUpdate = useCallback(() => {
    if (!update || !stagedUpdate) return;
    void update.applyUpdate(stagedUpdate).catch((error: unknown) => {
      console.warn("update apply failed:", error);
    });
  }, [update, stagedUpdate]);

  const handleRestart = useCallback(() => {
    void power?.restart().catch((error: unknown) => {
      console.warn("restart failed:", error);
    });
  }, [power]);

  // --- Sideload file picker -------------------------------------------------
  const browseSideloadDir = useCallback(
    async (dir: string) => {
      if (!filesystem) return;
      setSideloadLoading(true);
      setSideloadError(undefined);
      setSelectedBundle(undefined);
      setBundlePreview(undefined);
      try {
        const entries = await filesystem.list(dir);
        if (!mountedRef.current) return;
        setSideloadDir(dir);
        setSideloadEntries(
          entries
            .filter((entry) => entry.kind === "directory" || isBundleFilename(entry.name))
            .sort((a, b) => {
              if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
              return a.name.localeCompare(b.name);
            }),
        );
      } catch (error) {
        if (mountedRef.current)
          setSideloadError(`Could not list ${dir}: ${errorMessage(error)}`);
      } finally {
        if (mountedRef.current) setSideloadLoading(false);
      }
    },
    [filesystem],
  );

  const openSideload = useCallback(() => {
    setSideloadOpen(true);
    setSideloadError(undefined);
    setSelectedBundle(undefined);
    setBundlePreview(undefined);
    void browseSideloadDir("/Downloads");
  }, [browseSideloadDir]);

  const handleSelectBundle = useCallback(
    (path: string) => {
      setSelectedBundle(path);
      setBundlePreview(undefined);
      setSideloadError(undefined);
      if (!onInspectBundle) return;
      setPreviewLoading(true);
      void onInspectBundle(path)
        .then((preview) => {
          if (mountedRef.current) setBundlePreview(preview);
        })
        .catch((error: unknown) => {
          if (mountedRef.current)
            setSideloadError(`Could not read bundle: ${errorMessage(error)}`);
        })
        .finally(() => {
          if (mountedRef.current) setPreviewLoading(false);
        });
    },
    [onInspectBundle],
  );

  const handleConfirmSideload = useCallback(() => {
    if (!onInstallApp || !selectedBundle || sideloadBusy) return;
    setSideloadBusy(true);
    setSideloadError(undefined);
    void onInstallApp(selectedBundle)
      .then(() => {
        if (!mountedRef.current) return;
        setSideloadOpen(false);
        setSelectedBundle(undefined);
        setBundlePreview(undefined);
        void refreshInstalled();
        setTab("installed");
      })
      .catch((error: unknown) => {
        if (mountedRef.current)
          setSideloadError(`Install failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (mountedRef.current) setSideloadBusy(false);
      });
  }, [onInstallApp, selectedBundle, sideloadBusy, refreshInstalled]);

  const sideloadParentDir =
    sideloadDir === "/" ? undefined : sideloadDir.replace(/\/[^/]+\/?$/, "") || "/";

  const mergedCatalog: readonly CatalogAppView[] =
    catalogState.kind === "ready"
      ? mergeCatalogWithInstalled(catalogState.result.feed.apps, installed)
      : [];
  const appUpdates = selectAppUpdates(mergedCatalog);
  const filteredCatalog = mergedCatalog.filter((view) => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) return true;
    return (
      view.entry.name.toLowerCase().includes(query) ||
      view.entry.summary.toLowerCase().includes(query) ||
      view.entry.id.toLowerCase().includes(query)
    );
  });

  const registryUnavailable = onRefreshApps === undefined;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <SevynIcon name="package" size={22} color="#C4B5FD" />
          <Text style={styles.title}>Software</Text>
        </View>
        <View style={styles.headerActions}>
          {filesystem !== undefined && onInstallApp !== undefined && (
            <Pressable
              accessibilityLabel="Install a .sevyn bundle from a file"
              onPress={openSideload}
              style={styles.sideloadButton}
            >
              <SevynIcon name="download" size={14} color="#E2E8F0" />
              <Text style={styles.sideloadButtonText}>Install from file…</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.tabBar}>
        {TABS.map((entry) => {
          const active = tab === entry.id;
          return (
            <Pressable
              key={entry.id}
              accessibilityLabel={`${entry.label} tab`}
              onPress={() => {
                setTab(entry.id);
              }}
              style={active ? { ...styles.tab, ...styles.tabActive } : styles.tab}
            >
              <SevynIcon
                name={entry.icon}
                size={14}
                color={active ? "#C4B5FD" : "#94A3B8"}
              />
              <Text
                style={
                  active
                    ? { ...styles.tabLabel, ...styles.tabLabelActive }
                    : styles.tabLabel
                }
              >
                {entry.label}
              </Text>
              {entry.id === "updates" && appUpdates.length > 0 && (
                <View style={styles.updateBadge}>
                  <Text style={styles.updateBadgeText}>{String(appUpdates.length)}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {entryError !== undefined && (
        <View style={styles.errorBanner}>
          <SevynIcon name="warning" size={14} color="#FCA5A5" />
          <Text style={styles.errorBannerText}>{entryError}</Text>
        </View>
      )}

      <ScrollView style={styles.content}>
        {tab === "discover" && (
          <DiscoverPane
            catalogState={catalogState}
            views={filteredCatalog}
            searchQuery={searchQuery}
            onSearchQuery={setSearchQuery}
            onRetry={() => {
              void loadCatalog();
            }}
            busyEntry={busyEntry}
            canInstall={onInstallCatalogEntry !== undefined}
            onInstall={handleInstallCatalogEntry}
          />
        )}
        {tab === "installed" && (
          <InstalledPane
            apps={installed}
            loading={installedLoading}
            error={installedError}
            registryUnavailable={registryUnavailable}
            confirmUninstallId={confirmUninstallId}
            canUninstall={onUninstallApp !== undefined}
            onUninstall={handleUninstall}
            onRefresh={() => {
              void refreshInstalled();
            }}
          />
        )}
        {tab === "updates" && (
          <UpdatesPane
            update={update}
            updateStatus={updateStatus}
            updateResult={updateResult}
            updateBusy={updateBusy}
            downloadProgress={downloadProgress}
            stagedUpdate={stagedUpdate}
            canRestart={power !== undefined}
            onCheck={handleCheckForUpdates}
            onDownload={handleDownloadUpdate}
            onApply={handleApplyUpdate}
            onRestart={handleRestart}
            appUpdates={appUpdates}
            catalogReady={catalogState.kind === "ready"}
            busyEntry={busyEntry}
            canInstall={onInstallCatalogEntry !== undefined}
            onInstall={handleInstallCatalogEntry}
          />
        )}
      </ScrollView>

      {sideloadOpen && (
        <SideloadDialog
          dir={sideloadDir}
          parentDir={sideloadParentDir}
          entries={sideloadEntries}
          loading={sideloadLoading}
          error={sideloadError}
          selectedBundle={selectedBundle}
          preview={bundlePreview}
          previewLoading={previewLoading}
          previewSupported={onInspectBundle !== undefined}
          busy={sideloadBusy}
          onNavigate={(dir: string) => {
            void browseSideloadDir(dir);
          }}
          onSelect={handleSelectBundle}
          onConfirm={handleConfirmSideload}
          onClose={() => {
            setSideloadOpen(false);
          }}
        />
      )}
    </View>
  );
}

// --- Discover ---------------------------------------------------------------

function DiscoverPane(props: {
  readonly catalogState: CatalogState;
  readonly views: readonly CatalogAppView[];
  readonly searchQuery: string;
  readonly onSearchQuery: (query: string) => void;
  readonly onRetry: () => void;
  readonly busyEntry: string | undefined;
  readonly canInstall: boolean;
  readonly onInstall: (entry: AppCatalogEntry) => void;
}): JSX.Element {
  const { catalogState } = props;
  if (catalogState.kind === "loading") {
    return (
      <View style={styles.centerBox}>
        <Text style={styles.mutedText}>Loading app catalog…</Text>
      </View>
    );
  }
  if (catalogState.kind === "unavailable" || catalogState.kind === "error") {
    return (
      <View style={styles.centerBox}>
        <SevynIcon name="globe" size={40} color="#475569" />
        <Text style={styles.emptyTitle}>No app catalog available</Text>
        <Text style={styles.emptyBody}>
          {catalogState.kind === "unavailable"
            ? "The configured app catalog feed could not be reached. You can still manage installed apps, install .sevyn bundles from files, and check for OS updates."
            : `The catalog feed is invalid: ${catalogState.message}`}
        </Text>
        <Pressable
          accessibilityLabel="Retry loading the app catalog"
          onPress={props.onRetry}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View>
      <TextInput
        accessibilityLabel="Search the app catalog"
        value={props.searchQuery}
        onChangeText={props.onSearchQuery}
        placeholder="Search apps…"
        placeholderTextColor="#64748B"
        style={styles.searchInput}
      />
      {props.views.length === 0 ? (
        <View style={styles.centerBox}>
          <Text style={styles.emptyTitle}>
            {props.searchQuery.trim().length > 0
              ? "No matching apps"
              : "Catalog is empty"}
          </Text>
          <Text style={styles.emptyBody}>
            {props.searchQuery.trim().length > 0
              ? "Try a different search."
              : "The catalog feed published no apps yet."}
          </Text>
        </View>
      ) : (
        props.views.map((view) => (
          <CatalogRow
            key={view.entry.id}
            view={view}
            busy={props.busyEntry === view.entry.id}
            canInstall={props.canInstall}
            onInstall={props.onInstall}
          />
        ))
      )}
    </View>
  );
}

function CatalogRow(props: {
  readonly view: CatalogAppView;
  readonly busy: boolean;
  readonly canInstall: boolean;
  readonly onInstall: (entry: AppCatalogEntry) => void;
}): JSX.Element {
  const { entry, installState, installedVersion } = props.view;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleBlock}>
          <Text style={styles.cardTitle}>{entry.name}</Text>
          <Text style={styles.cardSubtitle}>
            {entry.developer ?? entry.id} · v{entry.version} ·{" "}
            {formatBytes(entry.sizeBytes)}
          </Text>
        </View>
        {installState === "installed" && <StateChip label="Installed" tone="ok" />}
        {installState === "update-available" && (
          <StateChip label={`Update · v${installedVersion ?? "?"}`} tone="info" />
        )}
      </View>
      <Text style={styles.cardBody}>{entry.summary}</Text>
      {entry.permissions.length > 0 && (
        <Text style={styles.permissionsLine}>
          Permissions: {entry.permissions.join(", ")}
        </Text>
      )}
      {installState !== "installed" && (
        <View style={styles.cardActions}>
          {props.canInstall ? (
            <Pressable
              accessibilityLabel={`${installState === "update-available" ? "Update" : "Install"} ${entry.name}`}
              onPress={() => {
                props.onInstall(entry);
              }}
              disabled={props.busy}
              style={
                props.busy
                  ? { ...styles.primaryButton, ...styles.buttonDisabled }
                  : styles.primaryButton
              }
            >
              <Text style={styles.primaryButtonText}>
                {props.busy
                  ? "Working…"
                  : installState === "update-available"
                    ? "Update"
                    : "Install"}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.mutedText}>
              Installing from the catalog needs the system installer connection.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// --- Installed ---------------------------------------------------------------

function InstalledPane(props: {
  readonly apps: readonly InstalledAppInfo[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly registryUnavailable: boolean;
  readonly confirmUninstallId: string | undefined;
  readonly canUninstall: boolean;
  readonly onUninstall: (appId: string) => void;
  readonly onRefresh: () => void;
}): JSX.Element {
  if (props.registryUnavailable) {
    return (
      <View style={styles.centerBox}>
        <SevynIcon name="package" size={40} color="#475569" />
        <Text style={styles.emptyTitle}>Registry unavailable</Text>
        <Text style={styles.emptyBody}>
          This app needs the system application registry connection to list installed
          apps.
        </Text>
      </View>
    );
  }
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>
          {props.loading ? "Loading…" : `${String(props.apps.length)} installed`}
        </Text>
        <Pressable
          accessibilityLabel="Refresh installed apps"
          onPress={props.onRefresh}
          style={styles.ghostButton}
        >
          <SevynIcon name="refresh" size={14} color="#C4B5FD" />
          <Text style={styles.ghostButtonText}>Refresh</Text>
        </Pressable>
      </View>
      {props.error !== undefined && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{props.error}</Text>
        </View>
      )}
      {props.apps.map((app) => {
        const confirming = props.confirmUninstallId === app.id;
        const isProtected = app.system === true;
        return (
          <View key={app.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleBlock}>
                <Text style={styles.cardTitle}>{app.name}</Text>
                <Text style={styles.cardSubtitle}>
                  {installedAppSubtitle(app)}
                  {"\n"}
                  {app.id}
                </Text>
              </View>
              {isProtected ? (
                <StateChip label="System" tone="muted" />
              ) : (
                props.canUninstall && (
                  <Pressable
                    accessibilityLabel={
                      confirming
                        ? `Confirm uninstall ${app.name}`
                        : `Uninstall ${app.name}`
                    }
                    onPress={() => {
                      props.onUninstall(app.id);
                    }}
                    style={
                      confirming
                        ? { ...styles.dangerButton, ...styles.dangerButtonArmed }
                        : styles.dangerButton
                    }
                  >
                    <Text style={styles.dangerButtonText}>
                      {confirming ? "Confirm" : "Uninstall"}
                    </Text>
                  </Pressable>
                )
              )}
            </View>
            {app.description !== undefined && app.description.length > 0 && (
              <Text style={styles.cardBody}>{app.description}</Text>
            )}
            {confirming && (
              <Text style={styles.confirmHint}>
                Press Confirm again to remove {app.name} from this system.
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

// --- Updates -----------------------------------------------------------------

function UpdatesPane(props: {
  readonly update: OsUpdateService | undefined;
  readonly updateStatus: string;
  readonly updateResult: UpdateCheckResult | undefined;
  readonly updateBusy: boolean;
  readonly downloadProgress: DownloadProgress | undefined;
  readonly stagedUpdate: StagedUpdate | undefined;
  readonly canRestart: boolean;
  readonly onCheck: () => void;
  readonly onDownload: () => void;
  readonly onApply: () => void;
  readonly onRestart: () => void;
  readonly appUpdates: readonly CatalogAppView[];
  readonly catalogReady: boolean;
  readonly busyEntry: string | undefined;
  readonly canInstall: boolean;
  readonly onInstall: (entry: AppCatalogEntry) => void;
}): JSX.Element {
  const { update, updateResult } = props;
  const progressPercent =
    props.downloadProgress !== undefined && props.downloadProgress.total > 0
      ? Math.round((props.downloadProgress.received / props.downloadProgress.total) * 100)
      : 0;
  return (
    <View>
      <Text style={styles.sectionTitle}>System updates</Text>
      {update === undefined ? (
        <View style={styles.card}>
          <Text style={styles.cardBody}>
            The OS update service is not connected in this session.
          </Text>
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleBlock}>
              <Text style={styles.cardTitle}>SevynOS {update.currentVersion}</Text>
              <Text style={styles.cardSubtitle}>
                {updateResult?.checkedAt !== undefined
                  ? `Last checked ${new Date(updateResult.checkedAt).toLocaleString()}`
                  : "Not checked yet"}
              </Text>
            </View>
            <OsUpdateChip status={props.updateStatus} />
          </View>
          {updateResult?.status === "update-available" && (
            <View>
              <Text style={styles.cardBody}>
                SevynOS {updateResult.latestVersion ?? ""} is available.
                {updateResult.publishedAt !== undefined
                  ? ` Published ${new Date(updateResult.publishedAt).toLocaleDateString()}.`
                  : ""}
              </Text>
              {updateResult.releaseNotes !== undefined &&
                updateResult.releaseNotes.length > 0 && (
                  <Text style={styles.releaseNotes}>{updateResult.releaseNotes}</Text>
                )}
            </View>
          )}
          {updateResult?.status === "error" && updateResult.error !== undefined && (
            <Text style={styles.errorText}>{updateResult.error}</Text>
          )}
          {props.downloadProgress !== undefined && (
            <View style={styles.progressTrack}>
              {/* Keep the number inside the template so the literal type stays `${number}%`
                  (String() here would widen it to `${string}%` and fail typecheck). */}
              {/* eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- intentional number in template for the `${number}%` width type */}
              <View style={{ ...styles.progressFill, width: `${progressPercent}%` }} />
            </View>
          )}
          <View style={styles.cardActions}>
            <Pressable
              accessibilityLabel="Check for system updates"
              onPress={props.onCheck}
              disabled={props.updateBusy || props.updateStatus === "checking"}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>
                {props.updateStatus === "checking" ? "Checking…" : "Check for updates"}
              </Text>
            </Pressable>
            {updateResult?.status === "update-available" &&
              props.updateStatus !== "pending-reboot" && (
                <Pressable
                  accessibilityLabel="Download system update"
                  onPress={props.onDownload}
                  disabled={props.updateStatus === "downloading"}
                  style={
                    props.updateStatus === "downloading"
                      ? { ...styles.primaryButton, ...styles.buttonDisabled }
                      : styles.primaryButton
                  }
                >
                  <Text style={styles.primaryButtonText}>
                    {props.updateStatus === "downloading"
                      ? `Downloading… ${String(progressPercent)}%`
                      : "Download"}
                  </Text>
                </Pressable>
              )}
            {props.updateStatus === "downloaded" && props.stagedUpdate !== undefined && (
              <Pressable
                accessibilityLabel="Install system update and reboot"
                onPress={props.onApply}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Install update</Text>
              </Pressable>
            )}
            {props.updateStatus === "pending-reboot" && props.canRestart && (
              <Pressable
                accessibilityLabel="Restart now to finish the update"
                onPress={props.onRestart}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Restart now</Text>
              </Pressable>
            )}
          </View>
          {props.updateStatus === "pending-reboot" && (
            <Text style={styles.cardBody}>
              The update is staged and will be applied on reboot.
            </Text>
          )}
        </View>
      )}

      <Text style={styles.sectionTitle}>App updates</Text>
      {!props.catalogReady ? (
        <View style={styles.card}>
          <Text style={styles.cardBody}>
            App updates need the app catalog, which is not available right now.
          </Text>
        </View>
      ) : props.appUpdates.length === 0 ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <SevynIcon name="check" size={16} color="#6EE7B7" />
            <Text style={styles.cardBody}>All installed apps are up to date.</Text>
          </View>
        </View>
      ) : (
        props.appUpdates.map((view) => (
          <View key={view.entry.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleBlock}>
                <Text style={styles.cardTitle}>{view.entry.name}</Text>
                <Text style={styles.cardSubtitle}>
                  v{view.installedVersion ?? "?"} → v{view.entry.version}
                </Text>
              </View>
              {props.canInstall ? (
                <Pressable
                  accessibilityLabel={`Update ${view.entry.name}`}
                  onPress={() => {
                    props.onInstall(view.entry);
                  }}
                  disabled={props.busyEntry === view.entry.id}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>
                    {props.busyEntry === view.entry.id ? "Working…" : "Update"}
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.mutedText}>Installer unavailable</Text>
              )}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function OsUpdateChip(props: { readonly status: string }): JSX.Element {
  switch (props.status) {
    case "up-to-date":
      return <StateChip label="Up to date" tone="ok" />;
    case "update-available":
      return <StateChip label="Update available" tone="info" />;
    case "checking":
      return <StateChip label="Checking…" tone="muted" />;
    case "downloading":
      return <StateChip label="Downloading" tone="info" />;
    case "downloaded":
      return <StateChip label="Downloaded" tone="info" />;
    case "applying":
      return <StateChip label="Installing…" tone="info" />;
    case "pending-reboot":
      return <StateChip label="Restart to finish" tone="warn" />;
    case "error":
      return <StateChip label="Error" tone="warn" />;
    default:
      return <StateChip label="Not checked" tone="muted" />;
  }
}

function StateChip(props: {
  readonly label: string;
  readonly tone: "ok" | "info" | "warn" | "muted";
}): JSX.Element {
  const toneStyle =
    props.tone === "ok"
      ? styles.chipOk
      : props.tone === "info"
        ? styles.chipInfo
        : props.tone === "warn"
          ? styles.chipWarn
          : styles.chipMuted;
  return (
    <View style={{ ...styles.chip, ...toneStyle }}>
      <Text style={styles.chipText}>{props.label}</Text>
    </View>
  );
}

// --- Sideload dialog ----------------------------------------------------------

function SideloadDialog(props: {
  readonly dir: string;
  readonly parentDir: string | undefined;
  readonly entries: readonly FileSystemEntry[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly selectedBundle: string | undefined;
  readonly preview: BundlePreview | undefined;
  readonly previewLoading: boolean;
  readonly previewSupported: boolean;
  readonly busy: boolean;
  readonly onNavigate: (dir: string) => void;
  readonly onSelect: (path: string) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const parentDir = props.parentDir;
  return (
    <View style={styles.dialogOverlay}>
      <View style={styles.dialog}>
        <View style={styles.dialogHeader}>
          <Text style={styles.dialogTitle}>Install from file</Text>
          <Pressable accessibilityLabel="Close install dialog" onPress={props.onClose}>
            <SevynIcon name="x" size={16} color="#94A3B8" />
          </Pressable>
        </View>
        <Text style={styles.dialogPath}>{props.dir}</Text>
        {parentDir !== undefined && (
          <Pressable
            accessibilityLabel="Go to parent folder"
            onPress={() => {
              props.onNavigate(parentDir);
            }}
            style={styles.dirRow}
          >
            <SevynIcon name="folder" size={14} color="#C4B5FD" />
            <Text style={styles.dirRowText}>.. (parent folder)</Text>
          </Pressable>
        )}
        <ScrollView style={styles.dialogList}>
          {props.loading ? (
            <Text style={styles.mutedText}>Loading…</Text>
          ) : (
            props.entries.map((entry) => {
              const isDir = entry.kind === "directory";
              const selected = props.selectedBundle === entry.path;
              return (
                <Pressable
                  key={entry.path}
                  accessibilityLabel={
                    isDir ? `Open ${entry.name}` : `Select ${entry.name}`
                  }
                  onPress={() => {
                    if (isDir) props.onNavigate(entry.path);
                    else props.onSelect(entry.path);
                  }}
                  style={
                    selected
                      ? { ...styles.dirRow, ...styles.dirRowSelected }
                      : styles.dirRow
                  }
                >
                  <SevynIcon
                    name={isDir ? "folder" : "package"}
                    size={14}
                    color={selected ? "#C4B5FD" : "#94A3B8"}
                  />
                  <Text style={styles.dirRowText}>{entry.name}</Text>
                  {!isDir && (
                    <Text style={styles.dirRowSize}>{formatBytes(entry.size)}</Text>
                  )}
                </Pressable>
              );
            })
          )}
          {!props.loading && props.entries.length === 0 && (
            <Text style={styles.mutedText}>No .sevyn bundles in this folder.</Text>
          )}
        </ScrollView>

        {props.error !== undefined && <Text style={styles.errorText}>{props.error}</Text>}

        {props.selectedBundle !== undefined && (
          <View style={styles.previewBox}>
            <Text style={styles.previewTitle}>
              {props.preview?.name ?? props.selectedBundle.split("/").pop()}
            </Text>
            {props.previewLoading ? (
              <Text style={styles.mutedText}>Reading bundle manifest…</Text>
            ) : props.preview !== undefined ? (
              <View>
                <Text style={styles.previewLine}>
                  {props.preview.id} · v{props.preview.version}
                </Text>
                <Text style={styles.previewLine}>
                  Signature: {describeSignatureStatus(props.preview.signatureStatus)}
                </Text>
                {props.preview.permissions.length > 0 ? (
                  <Text style={styles.previewLine}>
                    Permissions: {props.preview.permissions.join(", ")}
                  </Text>
                ) : (
                  <Text style={styles.previewLine}>Permissions: none requested</Text>
                )}
                {props.preview.signatureStatus === "unsigned" && (
                  <Text style={styles.unsignedNotice}>
                    This bundle is unsigned. SevynOS allows installing unsigned bundles,
                    but only install software from sources you trust.
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.mutedText}>
                {props.previewSupported
                  ? "Select a bundle to preview it."
                  : "Bundle preview is not available in this session; the bundle will be validated by the installer on install."}
              </Text>
            )}
          </View>
        )}

        <View style={styles.dialogActions}>
          <Pressable
            accessibilityLabel="Cancel install"
            onPress={props.onClose}
            style={styles.ghostButton}
          >
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Install selected bundle"
            onPress={props.onConfirm}
            disabled={props.selectedBundle === undefined || props.busy}
            style={
              props.selectedBundle === undefined || props.busy
                ? { ...styles.primaryButton, ...styles.buttonDisabled }
                : styles.primaryButton
            }
          >
            <Text style={styles.primaryButtonText}>
              {props.busy ? "Installing…" : "Install"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// --- Styles -------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0F172A" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: "#F1F5F9", fontSize: 18, fontWeight: "700" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  sideloadButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#4F46E5",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sideloadButtonText: { color: "#E2E8F0", fontSize: 12, fontWeight: "600" },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabActive: { backgroundColor: "#1E1B4B" },
  tabLabel: { color: "#94A3B8", fontSize: 13, fontWeight: "600" },
  tabLabelActive: { color: "#C4B5FD" },
  updateBadge: {
    backgroundColor: "#4F46E5",
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  updateBadgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  content: { flex: 1, padding: 12 },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 12,
    marginBottom: 0,
    padding: 10,
    backgroundColor: "#450A0A",
    borderRadius: 8,
  },
  errorBannerText: { color: "#FCA5A5", fontSize: 12, flex: 1 },
  centerBox: { alignItems: "center", padding: 32, gap: 8 },
  emptyTitle: { color: "#F1F5F9", fontSize: 15, fontWeight: "700", textAlign: "center" },
  emptyBody: { color: "#94A3B8", fontSize: 13, textAlign: "center", lineHeight: 19 },
  mutedText: { color: "#64748B", fontSize: 12 },
  searchInput: {
    backgroundColor: "#1E293B",
    color: "#F1F5F9",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    marginBottom: 10,
  },
  card: {
    backgroundColor: "#1E293B",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitleBlock: { flex: 1 },
  cardTitle: { color: "#F1F5F9", fontSize: 14, fontWeight: "700" },
  cardSubtitle: { color: "#94A3B8", fontSize: 11, marginTop: 2 },
  cardBody: { color: "#CBD5E1", fontSize: 12, marginTop: 6, lineHeight: 17 },
  cardActions: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center" },
  permissionsLine: { color: "#94A3B8", fontSize: 11, marginTop: 6 },
  releaseNotes: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 6,
    lineHeight: 17,
    fontStyle: "italic",
  },
  errorText: { color: "#FCA5A5", fontSize: 12, marginTop: 8 },
  confirmHint: { color: "#FCA5A5", fontSize: 11, marginTop: 8 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionTitle: {
    color: "#F1F5F9",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 6,
    marginBottom: 8,
  },
  primaryButton: {
    backgroundColor: "#4F46E5",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: "center",
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  buttonDisabled: { opacity: 0.5 },
  ghostButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  ghostButtonText: { color: "#C4B5FD", fontSize: 12, fontWeight: "600" },
  dangerButton: {
    borderWidth: 1,
    borderColor: "#7F1D1D",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  dangerButtonArmed: { backgroundColor: "#7F1D1D" },
  dangerButtonText: { color: "#FCA5A5", fontSize: 12, fontWeight: "700" },
  chip: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 11, fontWeight: "700", color: "#F1F5F9" },
  chipOk: { backgroundColor: "#065F46" },
  chipInfo: { backgroundColor: "#1E3A8A" },
  chipWarn: { backgroundColor: "#92400E" },
  chipMuted: { backgroundColor: "#334155" },
  progressTrack: {
    height: 6,
    backgroundColor: "#334155",
    borderRadius: 3,
    marginTop: 10,
    overflow: "hidden",
  },
  progressFill: { height: 6, backgroundColor: "#4F46E5", borderRadius: 3 },
  dialogOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(2, 6, 23, 0.75)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  dialog: {
    backgroundColor: "#1E293B",
    borderRadius: 12,
    padding: 16,
    width: "100%",
    maxWidth: 480,
  },
  dialogHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  dialogTitle: { color: "#F1F5F9", fontSize: 15, fontWeight: "700" },
  dialogPath: { color: "#64748B", fontSize: 11, marginBottom: 8 },
  dialogList: { maxHeight: 220, marginBottom: 8 },
  dirRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  dirRowSelected: { backgroundColor: "#1E1B4B" },
  dirRowText: { color: "#E2E8F0", fontSize: 13, flex: 1 },
  dirRowSize: { color: "#64748B", fontSize: 11 },
  previewBox: {
    backgroundColor: "#0F172A",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  previewTitle: { color: "#F1F5F9", fontSize: 13, fontWeight: "700" },
  previewLine: { color: "#94A3B8", fontSize: 12, marginTop: 4 },
  unsignedNotice: { color: "#FCD34D", fontSize: 12, marginTop: 6, lineHeight: 17 },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});

export const storeApplicationBundle = `(() => {
  const { AppRegistry } = globalThis.__SEVYN_MODULES__["react-native"];
  const { StoreApplication } = globalThis.__SEVYN_MODULES__["@sevynos/app-store"];
  AppRegistry.registerComponent("Software", () => StoreApplication);
})();`;
