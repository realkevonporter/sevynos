import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import {
  NativeScrollView,
  NativeText,
  NativeTextInput,
  Pressable,
  View,
  type FileSystemEntry,
  type SevynBrowserEngine,
  type SevynFileSystem,
  type SystemNotificationService,
} from "@sevynos/react-native";
import { SevynCodeApp } from "@sevynos/app-sevyn-code";

const heading = (id: string, text: string) =>
  NativeText({
    key: id,
    id,
    text,
    role: "heading",
    style: { height: 34, fontSize: 24, fontWeight: 700 },
  });
const label = (id: string, text: string) =>
  NativeText({
    key: id,
    id,
    text,
    style: { minWidth: Math.max(32, text.length * 8 + 8), height: 22, fontSize: 13 },
  });
const button = (id: string, text: string, onPress?: () => void) =>
  Pressable({
    key: id,
    id,
    role: "button",
    label: text,
    ...(onPress === undefined ? {} : { onPress }),
    style: {
      minWidth: Math.max(54, text.length * 8 + 24),
      height: 36,
      radius: 8,
      padding: 8,
    },
    children: label(`${id}.label`, text),
  });
export function InstallerApplication(): ReactElement {
  return NativeScrollView({
    id: "installer.app",
    role: "application",
    label: "Install SevynOS",
    style: { padding: 24, gap: 18, overflow: "scroll" },
    children: [
      heading("installer.heading", "Install SevynOS"),
      NativeText({
        key: "intro",
        id: "installer.intro",
        text: "Install SevynOS on this computer or alongside your existing operating system.",
        style: { height: 52, fontSize: 16 },
      }),
      View({
        key: "details",
        id: "installer.details",
        style: {
          padding: 18,
          gap: 10,
          radius: 12,
          backgroundColor: "rgba(215, 172, 87, 0.08)",
        },
        children: [
          label("installer.backup", "Back up important files before continuing."),
          label("installer.power", "Keep your computer connected to power."),
          label(
            "installer.choice",
            "You will choose the target disk before any changes are made.",
          ),
        ],
      }),
      Pressable({
        key: "launch",
        id: "installer.launch",
        role: "button",
        label: "Start Installer",
        action: "installer-launch",
        style: { width: 220, height: 48, padding: 12, radius: 10 },
        children: label("installer.launch.label", "Start Installer"),
      }),
    ],
  });
}

export function TextEditorApplication(props: {
  readonly filesystem: Pick<SevynFileSystem, "list" | "read" | "write">;
  readonly notifications?: Pick<SystemNotificationService, "show"> | undefined;
}): ReactElement {
  const [files, setFiles] = useState<readonly FileSystemEntry[]>([]);
  const [path, setPath] = useState("/Documents/Welcome.txt");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("Opening…");
  const requestRevision = useRef(0);

  const refreshFiles = async (revision: number): Promise<void> => {
    const entries = await props.filesystem.list("/Documents");
    if (revision === requestRevision.current) {
      setFiles(entries.filter((entry) => entry.kind === "file"));
    }
  };
  const open = async (
    nextPath: string,
    revision = requestRevision.current,
  ): Promise<void> => {
    setStatus("Opening…");
    try {
      const value = await props.filesystem.read(nextPath);
      if (revision === requestRevision.current) {
        setPath(nextPath);
        setContent(value);
        setStatus("Saved");
      }
    } catch (error: unknown) {
      if (revision === requestRevision.current) {
        setStatus(error instanceof Error ? error.message : "Could not open file.");
      }
    }
  };
  useEffect(() => {
    const revision = ++requestRevision.current;
    void refreshFiles(revision).catch((error: unknown) => {
      if (revision === requestRevision.current) {
        setStatus(error instanceof Error ? error.message : "Could not list documents.");
      }
    });
    void open("/Documents/Welcome.txt", revision);
    return () => {
      requestRevision.current += 1;
    };
  }, [props.filesystem]);

  const save = () => {
    const normalizedPath = path.startsWith("/") ? path : `/Documents/${path}`;
    setStatus("Saving…");
    void props.filesystem
      .write(normalizedPath, content)
      .then(() => {
        setPath(normalizedPath);
        setStatus("Saved");
        void refreshFiles(requestRevision.current);
        props.notifications?.show({
          title: "Text Editor",
          message: `Saved ${normalizedPath}`,
        });
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "Could not save file.");
      });
  };

  return View({
    id: "text-editor.app",
    role: "application",
    label: "Text Editor",
    style: { direction: "row", padding: 12, gap: 12 },
    children: [
      NativeScrollView({
        key: "files",
        id: "text-editor.files",
        role: "list",
        label: "Documents",
        style: { width: 180, overflow: "scroll", gap: 6, padding: 8 },
        children: [
          heading("text-editor.documents", "Documents"),
          button("text-editor.new", "New document", () => {
            setPath("/Documents/Untitled.txt");
            setContent("");
            setStatus("Unsaved");
          }),
          ...files.map((file) =>
            Pressable({
              key: file.path,
              id: `text-editor.file.${file.path}`,
              role: "listitem",
              label: file.name,
              selected: file.path === path,
              onPress: () => {
                void open(file.path);
              },
              style: { height: 36, padding: 8 },
              children: NativeText({
                id: `text-editor.file.${file.path}.label`,
                text: file.name,
              }),
            }),
          ),
        ],
      }),
      View({
        key: "editor",
        id: "text-editor.editor",
        style: { flexGrow: 1, gap: 8 },
        children: [
          View({
            key: "toolbar",
            id: "text-editor.toolbar",
            style: { direction: "row", height: 40, gap: 8 },
            children: [
              NativeTextInput({
                key: "path",
                id: "text-editor.path",
                role: "textbox",
                label: "Document path",
                value: path,
                onTextInput: (value) => {
                  setPath(value);
                  setStatus("Unsaved");
                },
                style: { flexGrow: 1, height: 40, radius: 8 },
              }),
              button("text-editor.save", "Save", save),
            ],
          }),
          NativeTextInput({
            key: "content",
            id: "text-editor.content",
            role: "textbox",
            label: "Document content",
            multiline: true,
            value: content,
            onTextInput: (value) => {
              setContent(value);
              setStatus("Unsaved");
            },
            onKeyDown: (event) => {
              if ((event.control || event.meta) && event.key.toLowerCase() === "s")
                save();
            },
            style: {
              flexGrow: 1,
              padding: 10,
              backgroundColor: "#11151D",
              color: "#F4F4F6",
              radius: 8,
              fontSize: 13,
            },
          }),
          NativeText({
            key: "status",
            id: "text-editor.status",
            text: `${status} · Ctrl/Cmd+S to save`,
            style: { height: 22, fontSize: 11 },
          }),
        ],
      }),
    ],
  });
}

export interface NotesApplicationProps {
  readonly filesystem?: SevynFileSystem | undefined;
  readonly notifications?: SystemNotificationService | undefined;
}

interface NoteItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly folder: string;
  readonly updatedAt: string;
}

export function NotesApplication(props: NotesApplicationProps): ReactElement {
  const [selectedFolder, setSelectedFolder] = useState<string>("All Notes");
  const [selectedNoteId, setSelectedNoteId] = useState<string>("note-1");
  const [searchQuery, setSearchQuery] = useState("");
  const [notes, setNotes] = useState<readonly NoteItem[]>([
    {
      id: "note-1",
      title: "Welcome to Sevyn Notes",
      body: "Sevyn Notes is a native React Native application running directly on SevynOS.\n\nAll notes are automatically stored in the virtual filesystem at /Documents/Notes/.\n\nYou can organize notes into folders, search across titles and content, and write without distraction.",
      folder: "Quick Notes",
      updatedAt: "Today at 9:41 AM",
    },
    {
      id: "note-2",
      title: "React Native System Architecture",
      body: "SevynOS executes standard React Native component trees directly into Wayland surfaces.\n\nPrimitives like View, Text, TextInput, Pressable, and ScrollView map directly to native render commands.",
      folder: "Projects",
      updatedAt: "Yesterday",
    },
    {
      id: "note-3",
      title: "Ideas & Project Wishlist",
      body: "1. Integrate Meta's Yoga engine for 100% flexbox compliance.\n2. Built-in AsyncStorage persistence.\n3. Add React Navigation support for multi-screen apps.",
      folder: "Ideas",
      updatedAt: "Sep 4",
    },
  ]);

  const folders = ["All Notes", "Quick Notes", "Projects", "Ideas", "Personal"];
  const activeNote = notes.find((n) => n.id === selectedNoteId) ?? notes[0];

  const filteredNotes = notes.filter((note) => {
    const matchesFolder =
      selectedFolder === "All Notes" || note.folder === selectedFolder;
    const matchesSearch =
      searchQuery === "" ||
      note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      note.body.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFolder && matchesSearch;
  });

  const handleCreateNote = () => {
    const newId = `note-${String(Date.now())}`;
    const newNote: NoteItem = {
      id: newId,
      title: "Untitled Note",
      body: "",
      folder: selectedFolder === "All Notes" ? "Quick Notes" : selectedFolder,
      updatedAt: "Just now",
    };
    setNotes([newNote, ...notes]);
    setSelectedNoteId(newId);
    if (props.filesystem) {
      void props.filesystem.write(`/Documents/Notes/${newNote.title}.txt`, newNote.body);
    }
  };

  const handleUpdateTitle = (title: string) => {
    setNotes(
      notes.map((n) =>
        n.id === selectedNoteId ? { ...n, title, updatedAt: "Just now" } : n,
      ),
    );
  };

  const handleUpdateBody = (body: string) => {
    setNotes(
      notes.map((n) =>
        n.id === selectedNoteId ? { ...n, body, updatedAt: "Just now" } : n,
      ),
    );
    if (props.filesystem && activeNote) {
      void props.filesystem.write(`/Documents/Notes/${activeNote.title}.txt`, body);
    }
  };

  const handleDeleteNote = () => {
    if (!activeNote) return;
    const remaining = notes.filter((n) => n.id !== activeNote.id);
    setNotes(remaining);
    setSelectedNoteId(remaining[0]?.id ?? "");
    props.notifications?.show({
      title: "Note Deleted",
      message: `Removed ${activeNote.title}`,
    });
  };

  return View({
    id: "notes.app",
    role: "application",
    label: "Notes",
    style: { direction: "row", padding: 12, gap: 10, flexGrow: 1 },
    children: [
      // 1. Sidebar (Folders)
      View({
        key: "sidebar",
        id: "notes.sidebar",
        style: {
          width: 170,
          padding: 10,
          gap: 6,
          backgroundColor: "rgba(255, 255, 255, 0.03)",
          borderColor: "rgba(255, 255, 255, 0.06)",
          borderWidth: 1,
          radius: 10,
        },
        children: [
          NativeText({
            key: "h",
            id: "notes.sidebar.title",
            text: "Notes",
            role: "heading",
            style: { fontSize: 18, fontWeight: 700, color: "#F0F6FC", height: 26 },
          }),
          NativeText({
            key: "sub",
            id: "notes.sidebar.folders-label",
            text: "FOLDERS",
            style: { fontSize: 10, fontWeight: 700, color: "#8B949E", height: 16 },
          }),
          ...folders.map((fld) => {
            const count =
              fld === "All Notes"
                ? notes.length
                : notes.filter((n) => n.folder === fld).length;
            const isSelected = selectedFolder === fld;
            return Pressable({
              key: fld,
              id: `notes.folder.${fld}`,
              role: "button",
              label: fld,
              selected: isSelected,
              onPress: () => {
                setSelectedFolder(fld);
              },
              style: {
                height: 32,
                direction: "row",
                align: "center",
                justify: "space-between",
                padding: 6,
                radius: 6,
                backgroundColor: isSelected ? "rgba(215, 172, 87, 0.18)" : "transparent",
                borderColor: isSelected ? "rgba(215, 172, 87, 0.40)" : "transparent",
                borderWidth: 1,
              },
              children: [
                NativeText({
                  key: "name",
                  id: `notes.folder.${fld}.name`,
                  text: `${fld === "All Notes" ? "●" : "○"} ${fld}`,
                  style: {
                    fontSize: 12,
                    fontWeight: isSelected ? 700 : 500,
                    color: isSelected ? "#D7AC57" : "#BBC1CA",
                  },
                }),
                NativeText({
                  key: "count",
                  id: `notes.folder.${fld}.count`,
                  text: String(count),
                  style: { fontSize: 11, color: "#8B949E" },
                }),
              ],
            });
          }),
          View({ key: "spacer", id: "notes.sidebar.spacer", style: { flexGrow: 1 } }),
          Pressable({
            key: "new-btn",
            id: "notes.new-btn",
            role: "button",
            label: "New Note",
            onPress: handleCreateNote,
            style: {
              height: 34,
              padding: 8,
              backgroundColor: "#238636",
              radius: 6,
              align: "center",
              justify: "center",
            },
            children: NativeText({
              id: "notes.new-btn.t",
              text: "+ New Note",
              style: { color: "#FFF", fontWeight: 700, fontSize: 12 },
            }),
          }),
        ],
      }),

      // 2. Note List Pane
      View({
        key: "list-pane",
        id: "notes.list-pane",
        style: {
          width: 220,
          padding: 8,
          gap: 6,
          backgroundColor: "rgba(255, 255, 255, 0.02)",
          borderColor: "rgba(255, 255, 255, 0.06)",
          borderWidth: 1,
          radius: 10,
        },
        children: [
          NativeTextInput({
            key: "search",
            id: "notes.search",
            role: "textbox",
            label: "Search notes",
            value: searchQuery,
            onTextInput: setSearchQuery,
            style: {
              height: 32,
              padding: 6,
              backgroundColor: "#0D1117",
              color: "#FFF",
              radius: 6,
              borderColor: "rgba(255, 255, 255, 0.10)",
              borderWidth: 1,
              fontSize: 12,
            },
          }),
          NativeScrollView({
            key: "scroll",
            id: "notes.scroll",
            role: "list",
            style: { flexGrow: 1, gap: 4, overflow: "scroll" },
            children:
              filteredNotes.length === 0
                ? [
                    NativeText({
                      key: "empty",
                      id: "notes.empty",
                      text: "No notes found in this folder.",
                      style: { fontSize: 12, color: "#8B949E", padding: 8 },
                    }),
                  ]
                : filteredNotes.map((note) => {
                    const isSelected = note.id === selectedNoteId;
                    return Pressable({
                      key: note.id,
                      id: `note.item.${note.id}`,
                      role: "listitem",
                      label: note.title,
                      selected: isSelected,
                      onPress: () => {
                        setSelectedNoteId(note.id);
                      },
                      style: {
                        padding: 8,
                        gap: 3,
                        radius: 6,
                        backgroundColor: isSelected
                          ? "rgba(215, 172, 87, 0.16)"
                          : "rgba(255, 255, 255, 0.03)",
                        borderColor: isSelected
                          ? "rgba(215, 172, 87, 0.45)"
                          : "rgba(255, 255, 255, 0.06)",
                        borderWidth: 1,
                      },
                      children: [
                        NativeText({
                          key: "t",
                          id: `note.item.${note.id}.t`,
                          text: note.title || "Untitled",
                          style: {
                            fontSize: 13,
                            fontWeight: 700,
                            color: isSelected ? "#D7AC57" : "#F0F6FC",
                          },
                        }),
                        NativeText({
                          key: "time",
                          id: `note.item.${note.id}.time`,
                          text: `${note.updatedAt} · ${note.folder}`,
                          style: { fontSize: 10, color: "#8B949E" },
                        }),
                      ],
                    });
                  }),
          }),
        ],
      }),

      // 3. Editor Pane
      View({
        key: "editor-pane",
        id: "notes.editor-pane",
        style: {
          flexGrow: 1,
          padding: 14,
          gap: 8,
          backgroundColor: "#0D1117",
          borderColor: "rgba(255, 255, 255, 0.08)",
          borderWidth: 1,
          radius: 10,
        },
        children: activeNote
          ? [
              View({
                key: "header-row",
                id: "notes.editor.h-row",
                style: { direction: "row", justify: "space-between", align: "center" },
                children: [
                  NativeText({
                    key: "meta",
                    id: "notes.editor.meta",
                    text: `${activeNote.updatedAt} · Folder: ${activeNote.folder}`,
                    style: { fontSize: 11, color: "#67C695" },
                  }),
                  Pressable({
                    key: "del",
                    id: "notes.editor.del",
                    role: "button",
                    label: "Delete",
                    onPress: handleDeleteNote,
                    style: {
                      height: 26,
                      padding: 4,
                      paddingHorizontal: 8,
                      backgroundColor: "rgba(217, 101, 109, 0.18)",
                      borderColor: "rgba(217, 101, 109, 0.50)",
                      borderWidth: 1,
                      radius: 4,
                    },
                    children: NativeText({
                      id: "notes.editor.del.t",
                      text: "× Delete",
                      style: { fontSize: 11, color: "#FF7B72" },
                    }),
                  }),
                ],
              }),
              NativeTextInput({
                key: "title-inp",
                id: "notes.editor.title",
                role: "textbox",
                label: "Note Title",
                value: activeNote.title,
                onTextInput: handleUpdateTitle,
                style: {
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#F0F6FC",
                  height: 36,
                  padding: 4,
                  backgroundColor: "transparent",
                },
              }),
              NativeTextInput({
                key: "body-inp",
                id: "notes.editor.body",
                role: "textbox",
                label: "Note Content",
                multiline: true,
                value: activeNote.body,
                onTextInput: handleUpdateBody,
                style: {
                  flexGrow: 1,
                  padding: 8,
                  color: "#C9D1D9",
                  fontSize: 13,
                  backgroundColor: "rgba(255, 255, 255, 0.02)",
                  radius: 6,
                },
              }),
            ]
          : [
              NativeText({
                key: "no-note",
                id: "notes.editor.empty",
                text: "Select or create a note to begin editing.",
                style: { color: "#8B949E", fontSize: 13, padding: 12 },
              }),
            ],
      }),
    ],
  });
}

export function ComponentGalleryApplication(): ReactElement {
  const states = [
    ["idle", "theme"],
    ["hovered", "accent"],
    ["focused", "taskbar-position"],
    ["pressed", "workspace-count"],
    ["disabled", "reduced-motion"],
  ] as const;
  return NativeScrollView({
    id: "gallery.app",
    role: "application",
    label: "Sevyn Component Gallery",
    style: { padding: 24, gap: 12, overflow: "scroll" },
    children: [
      heading("gallery.heading", "Sevyn Component Gallery"),
      NativeText({
        key: "description",
        id: "gallery.description",
        text: "Primitives, interaction states, motion, and accessibility semantics.",
        style: { height: 28 },
      }),
      ...states.map(([state, action]) =>
        Pressable({
          key: state,
          id: `gallery.${state}`,
          action,
          role: "button",
          label: `${state} button`,
          disabled: state === "disabled",
          interactionState: state,
          style: { height: 42, width: 220, padding: 10 },
          children: NativeText({ id: `gallery.${state}.label`, text: state }),
        }),
      ),
      NativeTextInput({
        key: "input",
        id: "gallery.input",
        role: "textbox",
        label: "Example text input",
        defaultValue: "Editable value",
        style: { height: 40 },
      }),
    ],
  });
}

export interface AppManagerEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly developer: string;
  readonly permissions: readonly string[];
  readonly storageBytes: number;
  readonly status?: string;
  readonly metrics?:
    | {
        readonly inboundMessages: number;
        readonly outboundMessages: number;
        readonly inboundQueueDepth: number;
        readonly outboundQueueDepth: number;
        readonly averageEventDuration: number;
        readonly timeoutCount: number;
        readonly restartCount: number;
        readonly terminationReason?: string;
      }
    | undefined;
}
export interface AppManagerApplicationProps {
  readonly applications: readonly AppManagerEntry[];
  readonly onLaunch?: ((applicationId: string) => Promise<void> | void) | undefined;
  readonly onTerminate?: ((applicationId: string) => Promise<void> | void) | undefined;
}

export function AppManagerApplication(props: AppManagerApplicationProps): ReactElement {
  const [selected, setSelected] = useState(props.applications[0]?.id);
  const [activity, setActivity] = useState<string>();
  const current = props.applications.find((application) => application.id === selected);

  useEffect(() => {
    if (current === undefined) setSelected(props.applications[0]?.id);
  }, [current, props.applications]);

  const runAction = (
    verb: "Launching" | "Terminating",
    action: ((applicationId: string) => Promise<void> | void) | undefined,
  ): void => {
    if (current === undefined || action === undefined || activity !== undefined) return;
    setActivity(`${verb} ${current.name}…`);
    void Promise.resolve(action(current.id)).then(
      () => {
        setActivity(
          verb === "Launching"
            ? `${current.name} is ready.`
            : `${current.name} was terminated.`,
        );
      },
      (error: unknown) => {
        setActivity(
          error instanceof Error ? error.message : `${verb} ${current.name} failed.`,
        );
      },
    );
  };

  return View({
    id: "app-manager.app",
    role: "application",
    label: "App Manager",
    style: { direction: "row", padding: 16, gap: 16 },
    children: [
      NativeScrollView({
        key: "installed",
        id: "app-manager.installed",
        role: "list",
        style: { width: 260, overflow: "scroll", gap: 6 },
        children: [
          heading("app-manager.heading", "Installed Applications"),
          ...props.applications.map((application) =>
            Pressable({
              key: application.id,
              id: `app-manager.${application.id}`,
              role: "listitem",
              label: application.name,
              selected: application.id === selected,
              onPress: () => {
                setSelected(application.id);
              },
              children: NativeText({
                id: `app-manager.${application.id}.name`,
                text: application.name,
              }),
            }),
          ),
        ],
      }),
      View({
        key: "details",
        id: "app-manager.details",
        style: { flexGrow: 1, gap: 10 },
        children:
          current === undefined
            ? NativeText({ id: "app-manager.empty", text: "No application selected" })
            : [
                heading("app-manager.name", current.name),
                label("app-manager.version", `Version ${current.version}`),
                label("app-manager.developer", current.developer),
                label(
                  "app-manager.permissions",
                  `Permissions: ${current.permissions.join(", ") || "None"}`,
                ),
                label(
                  "app-manager.storage",
                  `Storage: ${String(current.storageBytes)} bytes`,
                ),
                label("app-manager.status", `Process: ${current.status ?? "unknown"}`),
                ...(current.metrics === undefined
                  ? []
                  : [
                      label(
                        "app-manager.metrics",
                        `Messages: ${String(current.metrics.inboundMessages + current.metrics.outboundMessages)} · Queue: ${String(current.metrics.inboundQueueDepth + current.metrics.outboundQueueDepth)} · Timeouts: ${String(current.metrics.timeoutCount)} · Restarts: ${String(current.metrics.restartCount)}`,
                      ),
                    ]),
                ...(props.onLaunch === undefined
                  ? []
                  : [
                      button("app-manager.launch", "Launch", () => {
                        runAction("Launching", props.onLaunch);
                      }),
                    ]),
                ...(props.onTerminate === undefined || current.status === "terminated"
                  ? []
                  : [
                      button("app-manager.terminate", "Terminate", () => {
                        runAction("Terminating", props.onTerminate);
                      }),
                    ]),
                NativeText({
                  id: "app-manager.activity",
                  text:
                    activity ??
                    "Built-in applications are protected. Install and removal are handled by the package installer.",
                  role: "status",
                  style: { minHeight: 24, fontSize: 12, color: "#8B949E" },
                }),
              ],
      }),
    ],
  });
}

export function FilesApplication(props: {
  readonly filesystem: SevynFileSystem;
  readonly notifications?: SystemNotificationService;
}): ReactElement {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<readonly FileSystemEntry[]>([]);
  const [selected, setSelected] = useState<string>();
  const [grid, setGrid] = useState(false);
  const isImage = (name: string): boolean =>
    /\.(png|jpe?g|gif|svg|bmp|webp)$/i.test(name);

  const [error, setError] = useState<string>();
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const requestRevision = useRef(0);
  const inTrash = path === "/.Trash";

  const reportError = (failure: unknown): void => {
    setError(failure instanceof Error ? failure.message : "The file operation failed.");
  };
  const refreshEntries = async (): Promise<void> => {
    const revision = ++requestRevision.current;
    try {
      const items = inTrash
        ? ((await props.filesystem.listTrash?.()) ?? [])
        : await props.filesystem.list(path);
      if (revision === requestRevision.current) {
        setEntries(items);
        setError(undefined);
      }
    } catch (failure) {
      if (revision === requestRevision.current) reportError(failure);
    }
  };

  useEffect(() => {
    setEntries([]);
    setSelected(undefined);
    setConfirmEmpty(false);
    void refreshEntries();
    return () => {
      requestRevision.current += 1;
    };
  }, [path, props.filesystem]);

  const runOperation = (operation: () => Promise<void>, title: string): void => {
    setError(undefined);
    const revision = requestRevision.current;
    void operation()
      .then(async () => {
        if (revision !== requestRevision.current) return;
        await refreshEntries();
        setSelected(undefined);
        props.notifications?.show({ title, message: "File operation completed." });
      })
      .catch((failure: unknown) => {
        if (revision === requestRevision.current) reportError(failure);
      });
  };

  const goUp = (): void => {
    if (path !== "/") setPath(path.replace(/\/[^/]+$/, "") || "/");
  };
  const createNewFile = (): void => {
    const name = `Document_${String(Date.now())}.txt`;
    runOperation(
      () => props.filesystem.write(`${path === "/" ? "" : path}/${name}`, ""),
      "File created",
    );
  };
  const createNewFolder = (): void => {
    const name = `Folder_${String(Date.now())}`;
    runOperation(
      () => props.filesystem.createDirectory(`${path === "/" ? "" : path}/${name}`),
      "Folder created",
    );
  };
  const deleteSelected = (): void => {
    const move = props.filesystem.moveToTrash?.bind(props.filesystem);
    if (!selected || !move || inTrash) return;
    runOperation(() => move(selected), "Moved to Trash");
  };
  const restoreSelected = (): void => {
    const entry = entries.find((item) => item.path === selected);
    const restore = props.filesystem.restoreFromTrash?.bind(props.filesystem);
    if (!entry || !restore) return;
    runOperation(() => restore(entry.name), "Restored from Trash");
  };
  const emptyTrash = (): void => {
    const empty = props.filesystem.emptyTrash?.bind(props.filesystem);
    if (!empty) return;
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    runOperation(() => empty(), "Trash emptied");
  };

  const selectedEntry = entries.find((e) => e.path === selected);

  return View({
    id: "files.app",
    role: "application",
    label: "Files",
    style: { direction: "row", padding: 12, gap: 12 },
    children: [
      View({
        key: "sidebar",
        id: "files.sidebar",
        style: { width: 170, padding: 12, gap: 8 },
        children: [
          heading("files.title", "Files"),
          label("files.locations", "LOCATIONS"),
          button("files.loc.root", "📁 / (Root)", () => {
            setPath("/");
          }),
          button("files.loc.desktop", "💻 Desktop", () => {
            setPath("/Desktop");
          }),
          button("files.loc.docs", "📄 Documents", () => {
            setPath("/Documents");
          }),
          button("files.loc.downloads", "📥 Downloads", () => {
            setPath("/Downloads");
          }),
          button("files.loc.pics", "🎨 Pictures", () => {
            setPath("/Pictures");
          }),
          button("files.loc.music", "🎵 Music", () => {
            setPath("/Music");
          }),
          button("files.loc.videos", "🎬 Videos", () => {
            setPath("/Videos");
          }),
          button("files.loc.trash", "🗑 Trash", () => {
            setPath("/.Trash");
          }),
          View({
            key: "div",
            id: "files.sidebar.div",
            style: { height: 1, backgroundColor: "rgba(255,255,255,0.08)" },
          }),
          button("files.view", grid ? "List view" : "Grid view", () => {
            setGrid((value) => !value);
          }),
        ],
      }),
      View({
        key: "browser",
        id: "files.browser",
        style: { flexGrow: 1, gap: 8 },
        children: [
          View({
            key: "toolbar",
            id: "files.toolbar",
            style: { direction: "row", height: 36, gap: 8, align: "center" },
            children: [
              ...(path !== "/" ? [button("files.up", "↑ Up", goUp)] : []),
              NativeText({
                key: "breadcrumb",
                id: "files.breadcrumb",
                text: `Location: ${path}`,
                role: "heading",
                style: {
                  flexGrow: 1,
                  height: 26,
                  fontWeight: 650,
                  color: "#D7AC57",
                  fontSize: 13,
                },
              }),
              ...(!inTrash
                ? [
                    button("files.new_file", "+ File", createNewFile),
                    button("files.new_folder", "+ Folder", createNewFolder),
                  ]
                : []),
              button("files.refresh", "Refresh", () => {
                void refreshEntries();
              }),
              ...(inTrash && selected && props.filesystem.restoreFromTrash
                ? [button("files.restore", "Restore", restoreSelected)]
                : []),
              ...(path === "/.Trash" && props.filesystem.emptyTrash
                ? [
                    button(
                      "files.empty_trash",
                      confirmEmpty ? "Confirm permanent deletion" : "Empty Trash",
                      emptyTrash,
                    ),
                    ...(confirmEmpty
                      ? [
                          button("files.cancel_empty", "Cancel", () => {
                            setConfirmEmpty(false);
                          }),
                        ]
                      : []),
                  ]
                : []),
              ...(selected && !inTrash && props.filesystem.moveToTrash
                ? [button("files.delete", "🗑 Trash", deleteSelected)]
                : []),
            ],
          }),
          ...(error
            ? [
                NativeText({
                  key: "error",
                  id: "files.error",
                  text: error,
                  style: { height: 42, color: "#FF8989", fontSize: 12 },
                }),
              ]
            : []),
          NativeScrollView({
            key: "entries",
            id: "files.entries",
            role: "list",
            style: {
              flexGrow: 1,
              overflow: "scroll",
              direction: grid ? "row" : "column",
              gap: 6,
            },
            children:
              entries.length === 0
                ? [
                    NativeText({
                      key: "empty",
                      id: "files.empty",
                      text: inTrash
                        ? "Trash is empty."
                        : "This folder is empty. Use '+ File' or '+ Folder' above.",
                      style: { height: 40, color: "#8B949E", padding: 12 },
                    }),
                  ]
                : entries.map((entry) =>
                    Pressable({
                      key: entry.path,
                      id: `file.${entry.path}`,
                      role: "listitem",
                      label: entry.name,
                      selected: selected === entry.path,
                      onPress: () => {
                        setSelected(entry.path);
                        if (!inTrash && entry.kind === "directory") setPath(entry.path);
                      },
                      style: {
                        height: grid ? 80 : 36,
                        width: grid ? 120 : "100%",
                        padding: 8,
                        radius: 6,
                        backgroundColor:
                          selected === entry.path
                            ? "rgba(215, 172, 87, 0.20)"
                            : "rgba(255, 255, 255, 0.03)",
                        borderColor:
                          selected === entry.path
                            ? "rgba(215, 172, 87, 0.50)"
                            : "rgba(255, 255, 255, 0.06)",
                        borderWidth: 1,
                      },
                      children: NativeText({
                        id: `file.${entry.path}.label`,
                        text: `${entry.kind === "directory" ? "📁" : isImage(entry.name) ? "🖼" : "📄"} ${entry.name}${entry.kind === "file" ? ` (${String(entry.size)}B)` : ""}`,
                        style: {
                          color: selected === entry.path ? "#D7AC57" : "#F0F6FC",
                          fontSize: 13,
                        },
                      }),
                    }),
                  ),
          }),
          ...(selectedEntry && isImage(selectedEntry.name)
            ? [
                View({
                  key: "preview",
                  id: "files.preview",
                  style: {
                    height: 50,
                    direction: "row",
                    align: "center",
                    padding: 8,
                    backgroundColor: "#0D1117",
                    radius: 6,
                    gap: 12,
                    borderColor: "rgba(215, 172, 87, 0.3)",
                    borderWidth: 1,
                  },
                  children: [
                    NativeText({
                      key: "p-icon",
                      id: "files.preview.icon",
                      text: "🖼",
                      style: { fontSize: 24, width: 32 },
                    }),
                    View({
                      key: "p-info",
                      id: "files.preview.info",
                      style: { flexGrow: 1, gap: 2 },
                      children: [
                        NativeText({
                          key: "p-title",
                          id: "files.preview.title",
                          text: selectedEntry.name,
                          style: { fontSize: 12, fontWeight: 700, color: "#F0F6FC" },
                        }),
                        NativeText({
                          key: "p-desc",
                          id: "files.preview.desc",
                          text: selectedEntry.mimeType ?? "Image file",
                          style: { fontSize: 11, color: "#67C695" },
                        }),
                      ],
                    }),
                  ],
                }),
              ]
            : []),
          ...(selectedEntry
            ? [
                View({
                  key: "inspector",
                  id: "files.inspector",
                  style: {
                    height: 38,
                    direction: "row",
                    align: "center",
                    padding: 8,
                    backgroundColor: "#161B22",
                    radius: 6,
                    gap: 12,
                  },
                  children: [
                    NativeText({
                      key: "type",
                      id: "files.inspector.type",
                      text:
                        selectedEntry.kind === "directory"
                          ? "📁 Folder"
                          : isImage(selectedEntry.name)
                            ? "🖼 Picture"
                            : "📄 Document",
                      style: { fontSize: 12, color: "#D7AC57", fontWeight: 700 },
                    }),
                    NativeText({
                      key: "name",
                      id: "files.inspector.name",
                      text: selectedEntry.name,
                      style: { fontSize: 12, color: "#F0F6FC", flexGrow: 1 },
                    }),
                    NativeText({
                      key: "size",
                      id: "files.inspector.size",
                      text:
                        selectedEntry.kind === "file"
                          ? `${String(selectedEntry.size)} bytes`
                          : "Folder",
                      style: { fontSize: 11, color: "#8B949E" },
                    }),
                  ],
                }),
              ]
            : []),
        ],
      }),
    ],
  });
}

export type CoreSystemApplicationKind =
  "installer" | "gallery" | "text-editor" | "app-manager" | "ide" | "notes" | "files";
export function createCoreSystemApplication(
  options:
    | { readonly kind: "installer" }
    | { readonly kind: "gallery" }
    | {
        readonly kind: "text-editor";
        readonly filesystem: SevynFileSystem;
        readonly notifications: SystemNotificationService;
      }
    | {
        readonly kind: "app-manager";
        readonly applications: readonly AppManagerEntry[];
        readonly onLaunch?: ((applicationId: string) => Promise<void> | void) | undefined;
        readonly onTerminate?:
          ((applicationId: string) => Promise<void> | void) | undefined;
      }
    | {
        readonly kind: "ide";
        readonly browserEngine?: SevynBrowserEngine | undefined;
      }
    | {
        readonly kind: "notes";
        readonly filesystem?: SevynFileSystem;
        readonly notifications?: SystemNotificationService;
      }
    | {
        readonly kind: "files";
        readonly filesystem: SevynFileSystem;
        readonly notifications: SystemNotificationService;
      },
): ReactElement {
  switch (options.kind) {
    case "installer":
      return createElement(InstallerApplication);
    case "gallery":
      return createElement(ComponentGalleryApplication);
    case "text-editor":
      return createElement(TextEditorApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
      });
    case "app-manager":
      return createElement(AppManagerApplication, {
        applications: options.applications,
        ...(options.onLaunch === undefined ? {} : { onLaunch: options.onLaunch }),
        ...(options.onTerminate === undefined
          ? {}
          : { onTerminate: options.onTerminate }),
      });
    case "ide":
      return createElement(SevynCodeApp, {
        engine: options.browserEngine,
      });
    case "notes":
      return createElement(NotesApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
      });
    case "files":
      return createElement(FilesApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
      });
  }
}
