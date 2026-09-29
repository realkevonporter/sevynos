import { useCallback, useEffect, useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type FileSystemEntry,
  type SevynFileSystem,
  type SystemNotificationService,
  type SevynApplicationManifest,
  type SevynStorageService,
  type SevynVolume,
} from "@sevynos/react-native";

export const filesManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.files",
  name: "File Manager",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Files",
  developer: "SevynOS",
  icon: "icons/files.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["filesystem.read", "filesystem.write", "removable-storage"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "multiple",
};

export interface FilesApplicationProps {
  readonly filesystem?: SevynFileSystem | undefined;
  readonly storage?: SevynStorageService | undefined;
  readonly notifications?: SystemNotificationService | undefined;
  readonly initialPath?: string | undefined;
}

interface QuickFolder {
  readonly name: string;
  readonly path: string;
  readonly icon: string;
}

const QUICK_LOCATIONS: readonly QuickFolder[] = [
  { name: "Home", path: "/", icon: "🏠" },
  { name: "Desktop", path: "/Desktop", icon: "🖥️" },
  { name: "Documents", path: "/Documents", icon: "📄" },
  { name: "Downloads", path: "/Downloads", icon: "📥" },
  { name: "Pictures", path: "/Pictures", icon: "🖼️" },
  { name: "Music", path: "/Music", icon: "🎵" },
  { name: "Videos", path: "/Videos", icon: "🎬" },
  { name: "Trash", path: "/.Trash", icon: "🗑️" },
];

function getFileIcon(name: string, kind: "file" | "directory"): string {
  if (kind === "directory") return "📁";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "svg", "bmp", "webp"].includes(ext)) return "🖼️";
  if (["mp3", "wav", "flac", "ogg"].includes(ext)) return "🎵";
  if (["mp4", "mkv", "webm", "mov"].includes(ext)) return "🎬";
  if (["ts", "tsx", "js", "json", "py", "rs", "cpp", "c", "sh"].includes(ext))
    return "⚙️";
  if (["txt", "md", "log"].includes(ext)) return "📝";
  return "📄";
}

export function FilesApplication({
  filesystem,
  storage,
  notifications,
  initialPath = "/",
}: FilesApplicationProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string>(initialPath);
  const [entries, setEntries] = useState<readonly FileSystemEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [volumes, setVolumes] = useState<readonly SevynVolume[]>([]);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [backStack, setBackStack] = useState<readonly string[]>([]);
  const [forwardStack, setForwardStack] = useState<readonly string[]>([]);
  const [directoryError, setDirectoryError] = useState<string | undefined>(undefined);
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameName, setRenameName] = useState<string>("");
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState<boolean>(false);

  const isInTrash = currentPath === "/.Trash";

  const loadDirectory = useCallback(
    async (dirPath: string): Promise<boolean> => {
      if (!filesystem) {
        setEntries([
          { name: "documents", path: `${dirPath}/documents`, kind: "directory", size: 0 },
          { name: "Downloads", path: `${dirPath}/Downloads`, kind: "directory", size: 0 },
          { name: "desktop", path: `${dirPath}/desktop`, kind: "directory", size: 0 },
          {
            name: "welcome.txt",
            path: `${dirPath}/welcome.txt`,
            kind: "file",
            size: 1024,
          },
        ]);
        setCurrentPath(dirPath);
        setDirectoryError(undefined);
        return true;
      }
      try {
        // Special handling for Trash: use listTrash instead of list
        const items =
          dirPath === "/.Trash"
            ? ((await filesystem.listTrash?.()) ?? [])
            : await filesystem.list(dirPath);
        setEntries(items);
        setCurrentPath(dirPath);
        setSelectedPath(undefined);
        setSearchQuery("");
        setDirectoryError(undefined);
        setConfirmEmptyTrash(false);
        return true;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : `Cannot open directory ${dirPath}`;
        setDirectoryError(message);
        notifications?.show({
          title: "File Manager",
          message,
        });
        return false;
      }
    },
    [filesystem, notifications],
  );

  useEffect(() => {
    void loadDirectory(initialPath);
  }, [loadDirectory, initialPath]);

  // Subscribe to USB/removable volume changes.
  useEffect(() => {
    if (!storage) return;
    const unsubscribe = storage.subscribe((newVolumes: readonly SevynVolume[]) => {
      setVolumes(newVolumes);
    });
    // Also fetch initial list.
    void storage
      .listVolumes()
      .then(setVolumes)
      .catch(() => {
        // Volumes unavailable; sidebar shows none.
      });
    return unsubscribe;
  }, [storage]);

  const navigateTo = useCallback(
    async (path: string): Promise<void> => {
      if (path === currentPath) return;
      if (await loadDirectory(path)) {
        setBackStack((previous) => [...previous, currentPath]);
        setForwardStack([]);
      }
    },
    [currentPath, loadDirectory],
  );

  const handleEject = useCallback(
    async (volumeId: string): Promise<void> => {
      if (!storage) return;
      try {
        await storage.eject(volumeId);
        // If we were browsing the ejected volume, go home.
        const volume = volumes.find((v) => v.id === volumeId);
        if (volume && currentPath.startsWith(volume.mountPoint)) {
          await navigateTo("/");
        }
      } catch (error: unknown) {
        setDirectoryError(
          error instanceof Error ? error.message : "Could not eject the device.",
        );
      }
    },
    [storage, volumes, currentPath, navigateTo],
  );

  const handleNavigateBack = async (): Promise<void> => {
    const destination = backStack.at(-1);
    if (destination === undefined) return;
    if (await loadDirectory(destination)) {
      setBackStack((previous) => previous.slice(0, -1));
      setForwardStack((previous) => [currentPath, ...previous]);
    }
  };

  const handleNavigateForward = async (): Promise<void> => {
    const destination = forwardStack[0];
    if (destination === undefined) return;
    if (await loadDirectory(destination)) {
      setForwardStack((previous) => previous.slice(1));
      setBackStack((previous) => [...previous, currentPath]);
    }
  };

  const handleOpenItem = (entry: FileSystemEntry) => {
    if (entry.kind === "directory") {
      void navigateTo(entry.path);
    } else {
      setSelectedPath(entry.path);
      notifications?.show({
        title: "File Selected",
        message: `Selected ${entry.name}`,
      });
    }
  };

  const handleNavigateUp = () => {
    if (currentPath === "/" || !currentPath.includes("/")) return;
    const segments = currentPath.split("/").filter(Boolean);
    segments.pop();
    const parent = "/" + segments.join("/");
    void navigateTo(parent || "/");
  };

  const visibleEntries = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
  );
  const selectedEntry = entries.find((entry) => entry.path === selectedPath);
  const pathSegments = currentPath.split("/").filter(Boolean);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setIsCreatingFolder(false);
      return;
    }
    const targetPath = `${currentPath}/${newFolderName.trim()}`.replace(/\/\//g, "/");
    if (filesystem) {
      try {
        await filesystem.createDirectory(targetPath);
        void loadDirectory(currentPath);
        notifications?.show({
          title: "Folder Created",
          message: `Created ${newFolderName}`,
        });
      } catch {
        notifications?.show({
          title: "Error",
          message: "Failed to create folder",
        });
      }
    }
    setNewFolderName("");
    setIsCreatingFolder(false);
  };

  const handleDelete = async () => {
    if (!selectedPath || !filesystem?.moveToTrash || isInTrash) return;
    try {
      await filesystem.moveToTrash(selectedPath);
      notifications?.show({
        title: "Moved to Trash",
        message: `Moved ${selectedPath.split("/").pop() ?? selectedPath} to Trash`,
      });
      void loadDirectory(currentPath);
    } catch {
      notifications?.show({
        title: "Error",
        message: "Failed to move to Trash",
      });
    }
  };

  const handleRename = async () => {
    if (!selectedPath || !renameName.trim() || !filesystem?.rename) return;
    const dir = selectedPath.substring(0, selectedPath.lastIndexOf("/")) || "/";
    const newPath = `${dir}/${renameName.trim()}`.replace(/\/\//g, "/");
    try {
      await filesystem.rename(selectedPath, newPath);
      notifications?.show({
        title: "Renamed",
        message: `Renamed to ${renameName.trim()}`,
      });
      setIsRenaming(false);
      setRenameName("");
      void loadDirectory(currentPath);
    } catch {
      notifications?.show({
        title: "Error",
        message: "Failed to rename",
      });
    }
  };

  const handleRestore = async () => {
    if (!selectedPath || !filesystem?.restoreFromTrash || !isInTrash) return;
    const entry = entries.find((e) => e.path === selectedPath);
    if (!entry) return;
    try {
      await filesystem.restoreFromTrash(entry.name);
      notifications?.show({
        title: "Restored",
        message: `Restored ${entry.name}`,
      });
      void loadDirectory(currentPath);
    } catch {
      notifications?.show({
        title: "Error",
        message: "Failed to restore",
      });
    }
  };

  const handleEmptyTrash = async () => {
    if (!filesystem?.emptyTrash || !isInTrash) return;
    if (!confirmEmptyTrash) {
      setConfirmEmptyTrash(true);
      return;
    }
    try {
      await filesystem.emptyTrash();
      notifications?.show({
        title: "Trash Emptied",
        message: "All items permanently deleted",
      });
      setConfirmEmptyTrash(false);
      void loadDirectory(currentPath);
    } catch {
      notifications?.show({
        title: "Error",
        message: "Failed to empty Trash",
      });
    }
  };

  const startRename = () => {
    if (!selectedPath) return;
    const name = selectedPath.split("/").pop() ?? "";
    setRenameName(name);
    setIsRenaming(true);
  };

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="File Manager"
      style={styles.container}
    >
      {/* Sidebar Places */}
      <View style={styles.sidebar}>
        <Text style={styles.sidebarSectionTitle}>Places</Text>
        <ScrollView style={styles.quickLocations}>
          {QUICK_LOCATIONS.map((loc) => {
            const isActive = currentPath === loc.path;
            return (
              <Pressable
                key={loc.path}
                accessibilityRole="button"
                accessibilityLabel={`Open ${loc.name}`}
                onPress={() => void navigateTo(loc.path)}
                style={isActive ? styles.locationItemActive : styles.locationItem}
              >
                <Text style={styles.locationIcon}>{loc.icon}</Text>
                <Text style={isActive ? styles.locationNameActive : styles.locationName}>
                  {loc.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {/* Removable Devices (USB drives) */}
        {volumes.length > 0 && (
          <>
            <Text style={styles.sidebarSectionTitle}>Devices</Text>
            <ScrollView style={styles.quickLocations}>
              {volumes.map((volume) => {
                const isActive = currentPath === volume.mountPoint;
                return (
                  <View key={volume.id} style={styles.deviceRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${volume.label}`}
                      onPress={() => void navigateTo(volume.mountPoint)}
                      style={isActive ? styles.locationItemActive : styles.locationItem}
                    >
                      <Text style={styles.locationIcon}>💾</Text>
                      <Text
                        style={isActive ? styles.locationNameActive : styles.locationName}
                      >
                        {volume.label}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Eject ${volume.label}`}
                      onPress={() => void handleEject(volume.id)}
                      style={styles.ejectButton}
                    >
                      <Text style={styles.ejectIcon}>⏏</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          </>
        )}
      </View>

      {/* Main Files Area */}
      <View style={styles.main}>
        {/* Navigation Toolbar */}
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            disabled={backStack.length === 0}
            onPress={() => void handleNavigateBack()}
            style={backStack.length === 0 ? styles.navButtonDisabled : styles.navButton}
          >
            <Text style={styles.navButtonText}>←</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go forward"
            disabled={forwardStack.length === 0}
            onPress={() => void handleNavigateForward()}
            style={
              forwardStack.length === 0 ? styles.navButtonDisabled : styles.navButton
            }
          >
            <Text style={styles.navButtonText}>→</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to parent folder"
            disabled={currentPath === "/"}
            onPress={handleNavigateUp}
            style={currentPath === "/" ? styles.navButtonDisabled : styles.navButton}
          >
            <Text style={styles.navButtonText}>↑ Up</Text>
          </Pressable>

          <View style={styles.pathBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Home"
              onPress={() => void navigateTo("/")}
            >
              <Text style={styles.pathText}>Home</Text>
            </Pressable>
            {pathSegments.map((segment, index) => {
              const path = `/${pathSegments.slice(0, index + 1).join("/")}`;
              return (
                <View key={path} style={styles.breadcrumbPart}>
                  <Text style={styles.breadcrumbSeparator}>›</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${segment}`}
                    onPress={() => void navigateTo(path)}
                  >
                    <Text style={styles.pathText}>{segment}</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>

          <TextInput
            accessibilityLabel="Search this folder"
            onChangeText={setSearchQuery}
            placeholder="Search"
            placeholderTextColor="#6B7280"
            style={styles.searchInput}
            value={searchQuery}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create a folder"
            onPress={() => {
              setIsCreatingFolder(true);
            }}
            style={styles.actionButton}
          >
            <Text style={styles.actionButtonText}>+ Folder</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh this folder"
            onPress={() => void loadDirectory(currentPath)}
            style={styles.actionButton}
          >
            <Text style={styles.actionButtonText}>↻</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Use ${viewMode === "grid" ? "list" : "grid"} view`}
            onPress={() => {
              setViewMode(viewMode === "grid" ? "list" : "grid");
            }}
            style={styles.actionButton}
          >
            <Text style={styles.actionButtonText}>
              {viewMode === "grid" ? "☰" : "⊞"}
            </Text>
          </Pressable>

          {/* File operations - only show when an item is selected */}
          {selectedPath !== undefined && !isInTrash && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rename selected item"
                onPress={startRename}
                style={styles.actionButton}
              >
                <Text style={styles.actionButtonText}>✏️</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Move selected item to Trash"
                onPress={() => void handleDelete()}
                style={styles.actionButton}
              >
                <Text style={styles.actionButtonText}>🗑️</Text>
              </Pressable>
            </>
          )}

          {/* Trash operations */}
          {isInTrash && (
            <>
              {selectedPath !== undefined && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Restore selected item"
                  onPress={() => void handleRestore()}
                  style={styles.actionButton}
                >
                  <Text style={styles.actionButtonText}>↩️ Restore</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Empty Trash"
                onPress={() => void handleEmptyTrash()}
                style={styles.actionButton}
              >
                <Text style={styles.actionButtonText}>
                  {confirmEmptyTrash ? "⚠️ Confirm" : "Empty"}
                </Text>
              </Pressable>
            </>
          )}
        </View>

        {directoryError !== undefined && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{directoryError}</Text>
          </View>
        )}

        {/* Inline Folder Creation Prompt */}
        {isCreatingFolder && (
          <View style={styles.newFolderBar}>
            <TextInput
              onChangeText={setNewFolderName}
              onSubmitEditing={() => void handleCreateFolder()}
              placeholder="New folder name…"
              placeholderTextColor="#6B7280"
              style={styles.newFolderInput}
              value={newFolderName}
            />
            <Pressable
              onPress={() => void handleCreateFolder()}
              style={styles.confirmButton}
            >
              <Text style={styles.confirmButtonText}>Create</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setIsCreatingFolder(false);
                setNewFolderName("");
              }}
              style={styles.cancelButton}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {/* Inline Rename Prompt */}
        {isRenaming && (
          <View style={styles.newFolderBar}>
            <TextInput
              onChangeText={setRenameName}
              onSubmitEditing={() => void handleRename()}
              placeholder="New name…"
              placeholderTextColor="#6B7280"
              style={styles.newFolderInput}
              value={renameName}
            />
            <Pressable onPress={() => void handleRename()} style={styles.confirmButton}>
              <Text style={styles.confirmButtonText}>Rename</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setIsRenaming(false);
                setRenameName("");
              }}
              style={styles.cancelButton}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {/* Directory Contents Viewport */}
        <ScrollView style={styles.contentScroll}>
          {visibleEntries.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📂</Text>
              <Text style={styles.emptyText}>
                {searchQuery.trim() === ""
                  ? "This folder is empty"
                  : `No items match “${searchQuery}”`}
              </Text>
            </View>
          ) : viewMode === "grid" ? (
            <View style={styles.gridContainer}>
              {visibleEntries.map((entry) => {
                const isSelected = selectedPath === entry.path;
                return (
                  <Pressable
                    key={entry.path}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${entry.name}`}
                    onPress={() => {
                      handleOpenItem(entry);
                    }}
                    style={isSelected ? styles.gridCardSelected : styles.gridCard}
                  >
                    <Text style={styles.gridIcon}>
                      {getFileIcon(entry.name, entry.kind)}
                    </Text>
                    <Text style={styles.gridName}>{entry.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View style={styles.listContainer}>
              {visibleEntries.map((entry) => {
                const isSelected = selectedPath === entry.path;
                return (
                  <Pressable
                    key={entry.path}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${entry.name}`}
                    onPress={() => {
                      handleOpenItem(entry);
                    }}
                    style={isSelected ? styles.listItemSelected : styles.listItem}
                  >
                    <Text style={styles.listIcon}>
                      {getFileIcon(entry.name, entry.kind)}
                    </Text>
                    <Text style={styles.listName}>{entry.name}</Text>
                    <Text style={styles.listKind}>
                      {entry.kind === "directory" ? "Folder" : "File"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>

        {/* Status Bar */}
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            {visibleEntries.length} {visibleEntries.length === 1 ? "item" : "items"}
            {selectedEntry === undefined
              ? ""
              : ` · ${selectedEntry.name}${
                  selectedEntry.kind === "file"
                    ? ` · ${String(selectedEntry.size)} bytes`
                    : " · Folder"
                }`}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default FilesApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#0F1115",
  },
  sidebar: {
    width: 200,
    backgroundColor: "#161920",
    borderRightWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 12,
  },
  sidebarSectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#6B7280",
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  quickLocations: {
    flex: 1,
  },
  locationItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
    marginBottom: 4,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  ejectButton: {
    padding: 8,
    marginLeft: 4,
  },
  ejectIcon: {
    fontSize: 14,
    color: "#9aa4b2",
  },
  locationItemActive: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
    marginBottom: 4,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
  },
  locationIcon: {
    fontSize: 15,
  },
  locationName: {
    fontSize: 13,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  locationNameActive: {
    fontSize: 13,
    color: "#D7AC57",
    fontWeight: "700",
  },
  main: {
    flex: 1,
  },
  toolbar: {
    minHeight: 48,
    backgroundColor: "#1A1D24",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 8,
  },
  navButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  navButtonDisabled: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    opacity: 0.3,
  },
  navButtonText: {
    color: "#F3F4F6",
    fontSize: 12,
    fontWeight: "600",
  },
  pathBar: {
    flex: 1,
    height: 32,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  pathText: {
    color: "#D7AC57",
    fontSize: 12,
    fontWeight: "500",
  },
  breadcrumbPart: {
    flexDirection: "row",
    alignItems: "center",
  },
  breadcrumbSeparator: {
    color: "#6B7280",
    fontSize: 15,
    paddingHorizontal: 4,
  },
  searchInput: {
    width: 150,
    height: 32,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    color: "#F3F4F6",
    fontSize: 12,
    paddingHorizontal: 12,
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderBottomWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: {
    color: "#FCA5A5",
    fontSize: 12,
  },
  actionButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  actionButtonText: {
    color: "#F3F4F6",
    fontSize: 12,
    fontWeight: "600",
  },
  newFolderBar: {
    flexDirection: "row",
    padding: 8,
    backgroundColor: "#1F2430",
    gap: 8,
    alignItems: "center",
  },
  newFolderInput: {
    flex: 1,
    height: 32,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
    paddingHorizontal: 12,
    color: "#F3F4F6",
    fontSize: 13,
  },
  confirmButton: {
    backgroundColor: "#D7AC57",
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 8,
    justifyContent: "center",
  },
  confirmButtonText: {
    color: "#0F1115",
    fontWeight: "700",
    fontSize: 12,
  },
  cancelButton: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 8,
    justifyContent: "center",
  },
  cancelButtonText: {
    color: "#F3F4F6",
    fontSize: 12,
  },
  contentScroll: {
    flex: 1,
    padding: 16,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    padding: 48,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyText: {
    color: "#6B7280",
    fontSize: 14,
  },
  gridContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  gridCard: {
    width: 104,
    height: 96,
    borderRadius: 8,
    backgroundColor: "#1A1D24",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center",
    justifyContent: "center",
    padding: 8,
    gap: 8,
  },
  gridCardSelected: {
    width: 104,
    height: 96,
    borderRadius: 8,
    backgroundColor: "rgba(215, 172, 87, 0.12)",
    borderWidth: 1,
    borderColor: "#D7AC57",
    alignItems: "center",
    justifyContent: "center",
    padding: 8,
    gap: 8,
  },
  gridIcon: {
    fontSize: 30,
  },
  gridName: {
    fontSize: 11,
    color: "#E2E8F0",
    textAlign: "center",
  },
  listContainer: {
    gap: 4,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#161920",
    gap: 12,
  },
  listItemSelected: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    gap: 12,
  },
  listIcon: {
    fontSize: 18,
  },
  listName: {
    flex: 1,
    fontSize: 13,
    color: "#F3F4F6",
  },
  listKind: {
    fontSize: 11,
    color: "#6B7280",
  },
  statusBar: {
    height: 24,
    backgroundColor: "#161920",
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  statusText: {
    fontSize: 11,
    color: "#6B7280",
  },
});
