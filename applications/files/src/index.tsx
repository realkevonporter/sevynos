import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  SevynIcon,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SevynIconName,
  type FileSystemEntry,
  type SevynFileSystem,
  type SystemNotificationService,
  type SevynApplicationManifest,
  type SevynStorageService,
  type SevynVolume,
} from "@sevynos/react-native";
import {
  deleteTrashItemForever,
  emptyTrashBin,
  formatBytes,
  formatDeletedAt,
  loadTrashItems,
  restoreTrashItem,
  type TrashItem,
} from "./trash.js";
import {
  detectUnpluggedBrowsePath,
  formatVolumeCapacity,
  isPathOnVolume,
} from "./volumes.js";
import type { ArchiveProgress, SevynArchiveService } from "@sevynos/file-archives";

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
  /**
   * Host-provided archive backend. The Extract affordance only appears when
   * this is injected — without it the app shows no archive UI at all.
   */
  readonly archiveService?: SevynArchiveService | undefined;
}

/** Archive extensions the extraction backend supports. */
function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar")
  );
}

function stripArchiveExtension(name: string): string {
  return name.replace(/\.(tar\.gz|tgz|zip|tar)$/i, "");
}

interface QuickFolder {
  readonly name: string;
  readonly path: string;
  readonly icon: SevynIconName;
}

const QUICK_LOCATIONS: readonly QuickFolder[] = [
  { name: "Home", path: "/", icon: "home" },
  { name: "Desktop", path: "/Desktop", icon: "monitor" },
  { name: "Documents", path: "/Documents", icon: "file-text" },
  { name: "Downloads", path: "/Downloads", icon: "download" },
  { name: "Pictures", path: "/Pictures", icon: "image" },
  { name: "Music", path: "/Music", icon: "music-note" },
  { name: "Videos", path: "/Videos", icon: "film" },
  { name: "Trash", path: "/.Trash", icon: "trash" },
];

function getFileIcon(name: string, kind: "file" | "directory"): SevynIconName {
  if (kind === "directory") return "folder";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "svg", "bmp", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "ogg"].includes(ext)) return "music-note";
  if (["mp4", "mkv", "webm", "mov"].includes(ext)) return "film";
  if (["ts", "tsx", "js", "json", "py", "rs", "cpp", "c", "sh"].includes(ext))
    return "gear";
  if (["txt", "md", "log"].includes(ext)) return "file-text";
  return "file-text";
}

export function FilesApplication({
  filesystem,
  storage,
  notifications,
  initialPath = "/",
  archiveService,
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
  const [trashItems, setTrashItems] = useState<readonly TrashItem[]>([]);
  const [trashLoading, setTrashLoading] = useState<boolean>(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | undefined>(
    undefined,
  );
  const [ejectingVolumeId, setEjectingVolumeId] = useState<string | undefined>(undefined);
  const [extractDialog, setExtractDialog] = useState<
    { archiveName: string; archivePath: string; destinationName: string } | undefined
  >(undefined);
  const [extractProgress, setExtractProgress] = useState<ArchiveProgress | undefined>(
    undefined,
  );
  const [extractError, setExtractError] = useState<string | undefined>(undefined);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);

  // Mount points ever seen from the volume service, used to detect a device
  // that vanished while we were browsing it (unplug without eject).
  const seenMountPointsRef = useRef<ReadonlySet<string>>(new Set());
  const volumesPrimedRef = useRef<boolean>(false);

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
        // Special handling for Trash: build the rich view model (original
        // location + deletion date from the .trashinfo records).
        if (dirPath === "/.Trash") {
          setTrashLoading(true);
          try {
            const items = await loadTrashItems(filesystem);
            setTrashItems(items);
            setEntries(items.map((item) => item.entry));
          } finally {
            setTrashLoading(false);
          }
        } else {
          setTrashItems([]);
          setEntries(await filesystem.list(dirPath));
        }
        setCurrentPath(dirPath);
        setSelectedPath(undefined);
        setSearchQuery("");
        setDirectoryError(undefined);
        setConfirmEmptyTrash(false);
        setConfirmDeleteName(undefined);
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
    const applyVolumes = (newVolumes: readonly SevynVolume[]): void => {
      seenMountPointsRef.current = new Set([
        ...seenMountPointsRef.current,
        ...newVolumes.map((volume) => volume.mountPoint),
      ]);
      setVolumes(newVolumes);
      volumesPrimedRef.current = true;
    };
    const unsubscribe = storage.subscribe(applyVolumes);
    // Also fetch initial list.
    void storage
      .listVolumes()
      .then(applyVolumes)
      .catch(() => {
        // Volumes unavailable; sidebar shows none.
        volumesPrimedRef.current = true;
      });
    return unsubscribe;
  }, [storage]);

  // Graceful unplug-during-browse: if the device backing the current folder
  // vanishes (unplugged without eject), leave the dead folder instead of
  // showing a stale listing or crashing on the next refresh.
  useEffect(() => {
    if (!volumesPrimedRef.current) return;
    const vanished = detectUnpluggedBrowsePath(
      currentPath,
      seenMountPointsRef.current,
      volumes,
    );
    if (vanished === undefined) return;
    notifications?.show({
      title: "Device removed",
      message: "The USB device was unplugged.",
    });
    setBackStack([]);
    setForwardStack([]);
    void loadDirectory("/");
  }, [volumes, currentPath, notifications, loadDirectory]);

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
      if (!storage || ejectingVolumeId !== undefined) return;
      const volume = volumes.find((v) => v.id === volumeId);
      setEjectingVolumeId(volumeId);
      try {
        await storage.eject(volumeId);
        notifications?.show({
          title: "Device ejected",
          message: `${volume?.label ?? "USB device"} is safe to remove.`,
        });
        // If we were browsing the ejected volume, go home.
        if (volume && isPathOnVolume(currentPath, volume.mountPoint)) {
          setBackStack([]);
          setForwardStack([]);
          await loadDirectory("/");
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Could not eject the device.";
        setDirectoryError(message);
        notifications?.show({ title: "Eject failed", message });
      } finally {
        setEjectingVolumeId(undefined);
      }
    },
    [storage, volumes, currentPath, ejectingVolumeId, notifications, loadDirectory],
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
  const visibleTrashItems = trashItems.filter((item) =>
    item.name.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
  );
  const extractPercent =
    extractProgress !== undefined && extractProgress.entriesTotal > 0
      ? Math.min(
          100,
          Math.round((extractProgress.entriesDone / extractProgress.entriesTotal) * 100),
        )
      : 0;
  const extractLabel =
    extractProgress !== undefined && extractProgress.entriesTotal > 0
      ? `${extractProgress.currentEntry} (${String(extractProgress.entriesDone)}/${String(extractProgress.entriesTotal)})`
      : "Extracting…";
  const extractWidth = `${String(extractPercent)}%` as `${number}%`;
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

  const handleRestore = async (name: string) => {
    if (!filesystem || !isInTrash) return;
    try {
      await restoreTrashItem(filesystem, name);
      notifications?.show({
        title: "Restored",
        message: `Restored ${name}`,
      });
      void loadDirectory(currentPath);
    } catch (error: unknown) {
      notifications?.show({
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to restore",
      });
    }
  };

  const handleDeleteForever = async (name: string) => {
    if (!filesystem || !isInTrash) return;
    if (confirmDeleteName !== name) {
      setConfirmDeleteName(name);
      return;
    }
    try {
      await deleteTrashItemForever(filesystem, name);
      notifications?.show({
        title: "Deleted",
        message: `${name} was permanently deleted`,
      });
      setConfirmDeleteName(undefined);
      void loadDirectory(currentPath);
    } catch (error: unknown) {
      notifications?.show({
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to delete permanently",
      });
    }
  };

  const handleEmptyTrash = async () => {
    if (!filesystem || !isInTrash) return;
    if (!confirmEmptyTrash) {
      setConfirmEmptyTrash(true);
      return;
    }
    try {
      await emptyTrashBin(filesystem);
      notifications?.show({
        title: "Trash Emptied",
        message: "All items permanently deleted",
      });
      setConfirmEmptyTrash(false);
      void loadDirectory(currentPath);
    } catch (error: unknown) {
      notifications?.show({
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to empty Trash",
      });
    }
  };

  const openExtractDialog = () => {
    if (archiveService === undefined) return;
    if (selectedEntry?.kind !== "file") return;
    if (!isArchiveName(selectedEntry.name)) return;
    const base = stripArchiveExtension(selectedEntry.name);
    setExtractDialog({
      archiveName: selectedEntry.name,
      archivePath: selectedEntry.path,
      destinationName: base === "" ? `${selectedEntry.name}-extracted` : base,
    });
    setExtractError(undefined);
    setExtractProgress(undefined);
  };

  const closeExtractDialog = () => {
    if (isExtracting) return;
    setExtractDialog(undefined);
    setExtractProgress(undefined);
    setExtractError(undefined);
  };

  const runExtract = async () => {
    if (!archiveService || !extractDialog || isExtracting) return;
    const destinationName = extractDialog.destinationName.trim();
    if (destinationName === "" || destinationName.includes("/")) {
      setExtractError("Enter a folder name without slashes.");
      return;
    }
    setIsExtracting(true);
    setExtractError(undefined);
    try {
      const destinationDir = `${currentPath}/${destinationName}`.replace(/\/\//g, "/");
      const result = await archiveService.extract(
        extractDialog.archivePath,
        destinationDir,
        (progress) => {
          setExtractProgress(progress);
        },
      );
      const skippedNote =
        result.skipped.length > 0 ? ` (${String(result.skipped.length)} skipped)` : "";
      notifications?.show({
        title: "Archive extracted",
        message: `${String(result.entriesExtracted)} items extracted to ${destinationName}${skippedNote}`,
      });
      setExtractDialog(undefined);
      setExtractProgress(undefined);
      void loadDirectory(currentPath);
    } catch (error: unknown) {
      setExtractError(error instanceof Error ? error.message : "Extraction failed.");
    } finally {
      setIsExtracting(false);
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
                <SevynIcon name={loc.icon} size={15} color="#C7CDD8" />
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
                const isActive = isPathOnVolume(currentPath, volume.mountPoint);
                const isEjecting = ejectingVolumeId === volume.id;
                return (
                  <View key={volume.id} style={styles.deviceRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${volume.label}`}
                      onPress={() => void navigateTo(volume.mountPoint)}
                      style={isActive ? styles.deviceItemActive : styles.deviceItem}
                    >
                      <SevynIcon name="hard-drive" size={15} color="#C7CDD8" />
                      <View style={styles.deviceLabelColumn}>
                        <Text
                          style={
                            isActive ? styles.locationNameActive : styles.locationName
                          }
                          numberOfLines={1}
                        >
                          {volume.label}
                        </Text>
                        <Text style={styles.deviceCapacity} numberOfLines={1}>
                          {formatVolumeCapacity(
                            volume.sizeBytes,
                            volume.availableBytes,
                            formatBytes,
                          )}
                        </Text>
                      </View>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Eject ${volume.label}`}
                      disabled={isEjecting}
                      onPress={() => void handleEject(volume.id)}
                      style={isEjecting ? styles.ejectButtonDisabled : styles.ejectButton}
                    >
                      <Text style={styles.ejectIcon}>{isEjecting ? "…" : "⏏"}</Text>
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
            <SevynIcon
              name={viewMode === "grid" ? "menu" : "grid"}
              size={12}
              color="#F3F4F6"
            />
          </Pressable>

          {/* File operations - only show when an item is selected */}
          {selectedPath !== undefined && !isInTrash && (
            <>
              {selectedEntry?.kind === "file" &&
                isArchiveName(selectedEntry.name) &&
                archiveService !== undefined && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Extract ${selectedEntry.name}`}
                    onPress={openExtractDialog}
                    style={styles.actionButton}
                  >
                    <View style={styles.actionButtonGlyphRow}>
                      <SevynIcon name="package" size={12} color="#F3F4F6" />
                      <Text style={styles.actionButtonText}>Extract</Text>
                    </View>
                  </Pressable>
                )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rename selected item"
                onPress={startRename}
                style={styles.actionButton}
              >
                <SevynIcon name="edit" size={12} color="#F3F4F6" />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Move selected item to Trash"
                onPress={() => void handleDelete()}
                style={styles.actionButton}
              >
                <SevynIcon name="trash" size={12} color="#F3F4F6" />
              </Pressable>
            </>
          )}

          {/* Trash operations */}
          {isInTrash && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                confirmEmptyTrash ? "Confirm emptying the Trash" : "Empty Trash"
              }
              onPress={() => void handleEmptyTrash()}
              style={confirmEmptyTrash ? styles.dangerButtonConfirm : styles.actionButton}
            >
              <Text
                style={
                  confirmEmptyTrash
                    ? styles.dangerButtonConfirmText
                    : styles.actionButtonText
                }
              >
                {confirmEmptyTrash ? "Click again to confirm" : "Empty Trash"}
              </Text>
            </Pressable>
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
        {isInTrash ? (
          <ScrollView style={styles.contentScroll}>
            {trashLoading ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>Loading Trash…</Text>
              </View>
            ) : visibleTrashItems.length === 0 ? (
              <View style={styles.emptyState}>
                <SevynIcon name="trash" size={44} color="#5B6472" />
                <Text style={styles.emptyText}>
                  {searchQuery.trim() === ""
                    ? "Trash is empty"
                    : `No trashed items match “${searchQuery}”`}
                </Text>
              </View>
            ) : (
              <View style={styles.trashTable}>
                <View style={styles.trashHeaderRow}>
                  <Text style={styles.trashHeaderNameCell}>Name</Text>
                  <Text style={styles.trashHeaderLocationCell}>Original location</Text>
                  <Text style={styles.trashHeaderDateCell}>Date deleted</Text>
                  <Text style={styles.trashHeaderSizeCell}>Size</Text>
                  <View style={styles.trashHeaderActionsCell} />
                </View>
                {visibleTrashItems.map((item) => {
                  const confirmingDelete = confirmDeleteName === item.name;
                  return (
                    <View key={item.name} style={styles.trashRow}>
                      <View style={styles.trashNameCell}>
                        <SevynIcon
                          name={getFileIcon(item.name, item.kind)}
                          size={16}
                          color="#C7CDD8"
                        />
                        <Text style={styles.trashName} numberOfLines={1}>
                          {item.name}
                        </Text>
                      </View>
                      <Text style={styles.trashLocationCell} numberOfLines={1}>
                        {item.originalLocation ?? "Unknown"}
                      </Text>
                      <Text style={styles.trashDateCell} numberOfLines={1}>
                        {formatDeletedAt(item.deletedAt)}
                      </Text>
                      <Text style={styles.trashSizeCell} numberOfLines={1}>
                        {item.kind === "directory" ? "Folder" : formatBytes(item.size)}
                      </Text>
                      <View style={styles.trashActionsCell}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Restore ${item.name}`}
                          onPress={() => void handleRestore(item.name)}
                          style={styles.trashRowButton}
                        >
                          <SevynIcon name="refresh" size={12} color="#D7AC57" />
                          <Text style={styles.trashRowButtonText}>Restore</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            confirmingDelete
                              ? `Confirm permanently deleting ${item.name}`
                              : `Delete ${item.name} forever`
                          }
                          onPress={() => void handleDeleteForever(item.name)}
                          style={
                            confirmingDelete
                              ? styles.trashDeleteConfirmButton
                              : styles.trashRowButton
                          }
                        >
                          <SevynIcon
                            name="trash"
                            size={12}
                            color={confirmingDelete ? "#0F1115" : "#F87171"}
                          />
                          <Text
                            style={
                              confirmingDelete
                                ? styles.trashDeleteConfirmText
                                : styles.trashDeleteText
                            }
                          >
                            {confirmingDelete ? "Confirm" : "Delete"}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </ScrollView>
        ) : (
          <ScrollView style={styles.contentScroll}>
            {visibleEntries.length === 0 ? (
              <View style={styles.emptyState}>
                <SevynIcon name="folder" size={44} color="#5B6472" />
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
                      <SevynIcon
                        name={getFileIcon(entry.name, entry.kind)}
                        size={28}
                        color="#C7CDD8"
                      />
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
                      <SevynIcon
                        name={getFileIcon(entry.name, entry.kind)}
                        size={16}
                        color="#C7CDD8"
                      />
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
        )}

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

      {/* Archive extraction dialog */}
      {extractDialog !== undefined && (
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Extract archive</Text>
            <Text style={styles.dialogSubtitle} numberOfLines={1}>
              {extractDialog.archiveName}
            </Text>

            {isExtracting || extractProgress !== undefined ? (
              <>
                <Text style={styles.dialogStatus} numberOfLines={1}>
                  {extractLabel}
                </Text>
                <View style={styles.progressTrack}>
                  <View
                    style={{
                      backgroundColor: "#D7AC57",
                      height: 8,
                      borderRadius: 4,
                      width: extractWidth,
                    }}
                  />
                </View>
                {extractError !== undefined && (
                  <Text style={styles.dialogError}>{extractError}</Text>
                )}
                <View style={styles.dialogButtons}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    disabled={isExtracting}
                    onPress={closeExtractDialog}
                    style={
                      isExtracting ? styles.cancelButtonDisabled : styles.cancelButton
                    }
                  >
                    <Text style={styles.cancelButtonText}>Close</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.dialogLabel}>Extract to a new folder:</Text>
                <TextInput
                  accessibilityLabel="Destination folder name"
                  onChangeText={(name) => {
                    setExtractDialog({ ...extractDialog, destinationName: name });
                  }}
                  placeholder="Folder name"
                  placeholderTextColor="#6B7280"
                  style={styles.dialogInput}
                  value={extractDialog.destinationName}
                />
                {extractError !== undefined && (
                  <Text style={styles.dialogError}>{extractError}</Text>
                )}
                <View style={styles.dialogButtons}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel extraction"
                    onPress={closeExtractDialog}
                    style={styles.cancelButton}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Extract the archive"
                    onPress={() => void runExtract()}
                    style={styles.confirmButton}
                  >
                    <Text style={styles.confirmButtonText}>Extract</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      )}
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
  actionButtonGlyphRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
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
  deviceItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
  },
  deviceItemActive: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
  },
  deviceLabelColumn: {
    flex: 1,
    minWidth: 0,
  },
  deviceCapacity: {
    fontSize: 10,
    color: "#6B7280",
    marginTop: 2,
  },
  ejectButtonDisabled: {
    padding: 8,
    marginLeft: 4,
    opacity: 0.4,
  },
  dangerButtonConfirm: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(239, 68, 68, 0.25)",
    borderWidth: 1,
    borderColor: "#EF4444",
  },
  dangerButtonConfirmText: {
    color: "#FCA5A5",
    fontSize: 12,
    fontWeight: "700",
  },
  trashTable: {
    gap: 4,
  },
  trashHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 12,
  },
  trashHeaderNameCell: {
    flex: 2,
    minWidth: 0,
    fontSize: 11,
    fontWeight: "700",
    color: "#6B7280",
    textTransform: "uppercase",
  },
  trashHeaderLocationCell: {
    flex: 3,
    minWidth: 0,
    fontSize: 11,
    fontWeight: "700",
    color: "#6B7280",
    textTransform: "uppercase",
  },
  trashHeaderDateCell: {
    flex: 2,
    minWidth: 0,
    fontSize: 11,
    fontWeight: "700",
    color: "#6B7280",
    textTransform: "uppercase",
  },
  trashHeaderSizeCell: {
    width: 80,
    fontSize: 11,
    fontWeight: "700",
    color: "#6B7280",
    textTransform: "uppercase",
  },
  trashHeaderActionsCell: {
    width: 190,
  },
  trashRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#161920",
    gap: 12,
  },
  trashNameCell: {
    flex: 2,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  trashName: {
    flex: 1,
    fontSize: 13,
    color: "#F3F4F6",
    fontWeight: "500",
  },
  trashLocationCell: {
    flex: 3,
    minWidth: 0,
    fontSize: 12,
    color: "#9CA3AF",
  },
  trashDateCell: {
    flex: 2,
    minWidth: 0,
    fontSize: 12,
    color: "#9CA3AF",
  },
  trashSizeCell: {
    width: 80,
    fontSize: 12,
    color: "#9CA3AF",
  },
  trashActionsCell: {
    width: 190,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  trashRowButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  trashRowButtonText: {
    fontSize: 12,
    color: "#D7AC57",
    fontWeight: "600",
  },
  trashDeleteText: {
    fontSize: 12,
    color: "#F87171",
    fontWeight: "600",
  },
  trashDeleteConfirmButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#EF4444",
  },
  trashDeleteConfirmText: {
    fontSize: 12,
    color: "#0F1115",
    fontWeight: "700",
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
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  dialog: {
    width: 420,
    backgroundColor: "#1A1D24",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    padding: 20,
    gap: 12,
  },
  dialogTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  dialogSubtitle: {
    fontSize: 13,
    color: "#9CA3AF",
  },
  dialogLabel: {
    fontSize: 12,
    color: "#9CA3AF",
  },
  dialogInput: {
    height: 36,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    color: "#F3F4F6",
    fontSize: 13,
    paddingHorizontal: 12,
  },
  dialogError: {
    fontSize: 12,
    color: "#FCA5A5",
  },
  dialogStatus: {
    fontSize: 12,
    color: "#D7AC57",
  },
  dialogButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  cancelButtonDisabled: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 8,
    justifyContent: "center",
    opacity: 0.4,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
  },
});
