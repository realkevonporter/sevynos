import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  SafeAreaView,
  ScrollView,
  SevynApplicationSdkProvider,
  StyleSheet,
  Text,
  TextInput,
  View,
  resolveSevynColors,
  sevynTokens,
  useSevynApplicationSdk,
  useWindowDimensions,
  type SevynApplicationManifest,
  type SevynApplicationSdk,
  type SevynSemanticColors,
} from "@sevynos/react-native";
import {
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTE_COUNT,
  MAX_NOTE_TITLE_LENGTH,
  NOTE_FOLDERS,
  NOTES_STORAGE_KEY,
  createBlankNote,
  createDefaultNotesDocument,
  decodeNotesDocument,
  displayNoteTitle,
  duplicateNote,
  encodeNotesDocument,
  filterNotes,
  notePreview,
  notesReducer,
  type NoteFolder,
  type NotesFilter,
} from "./notes-model.js";

export * from "./notes-model.js";

export const notesManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.notes",
  name: "Notes",
  version: "1.1.0",
  runtime: "react-native",
  applicationKey: "Notes",
  developer: "SevynOS",
  icon: "icons/notes.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["notifications"],
  services: [],
  windowModes: ["standard", "utility"],
  instanceMode: "multiple",
};

export const notesApplicationBundle = `(() => {
  const { AppRegistry } = globalThis.__SEVYN_MODULES__["react-native"];
  const { NotesApplication } = globalThis.__SEVYN_MODULES__["@sevynos/app-notes"];
  AppRegistry.registerComponent("Notes", () => NotesApplication);
})();`;

type SaveStatus = "loading" | "saving" | "saved" | "error";
type CompactPane = "library" | "editor";
interface Banner {
  readonly tone: "warning" | "danger";
  readonly message: string;
}

const FILTERS = Object.freeze([
  { value: "all" as const, label: "All" },
  { value: "pinned" as const, label: "Pinned" },
  ...NOTE_FOLDERS.map((folder) => ({ value: folder, label: folder })),
]);

function formatUpdatedAt(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${String(Math.floor(elapsed / 60_000))}m ago`;
  if (elapsed < 86_400_000) return `${String(Math.floor(elapsed / 3_600_000))}h ago`;
  if (elapsed < 604_800_000) return `${String(Math.floor(elapsed / 86_400_000))}d ago`;
  const date = new Date(timestamp);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getMonth()];
  return `${month ?? ""} ${String(date.getDate())}`.trim();
}

function wordCount(value: string): number {
  const words = value.trim().match(/\S+/g);
  return words?.length ?? 0;
}

function filterId(filter: NotesFilter): string {
  return filter.toLocaleLowerCase().replaceAll(" ", "-");
}

function noteCountLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "note" : "notes"}`;
}

function statusLabel(status: SaveStatus): string {
  switch (status) {
    case "loading":
      return "Opening notes…";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved privately";
    case "error":
      return "Not saved";
  }
}

function statusColor(status: SaveStatus, colors: SevynSemanticColors): string {
  if (status === "error") return colors.danger;
  if (status === "saved") return colors.success;
  return colors.textMuted;
}

function actionButton(
  id: string,
  label: string,
  onPress: () => void,
  colors: SevynSemanticColors,
  options: {
    readonly selected?: boolean;
    readonly destructive?: boolean;
    readonly disabled?: boolean;
  } = {},
): ReactElement {
  const color = options.destructive === true ? colors.danger : colors.textSecondary;
  return (
    <Pressable
      disabled={options.disabled === true}
      id={id}
      label={label}
      onPress={onPress}
      role="button"
      selected={options.selected === true}
      style={{
        align: "center",
        backgroundColor:
          options.selected === true
            ? colors.materialStrong
            : options.destructive === true
              ? colors.surfaceRaised
              : colors.material,
        borderColor: options.selected === true ? colors.accent : colors.border,
        borderWidth: 1,
        minHeight: 34,
        opacity: options.disabled === true ? 0.45 : 1,
        paddingHorizontal: 11,
        paddingVertical: 7,
        radius: sevynTokens.radius.xs,
      }}
    >
      <Text
        id={`${id}.label`}
        style={{ color, fontSize: 12, fontWeight: 600, textAlign: "center" }}
        text={label}
      />
    </Pressable>
  );
}

function NotesLoadingView(props: { readonly colors: SevynSemanticColors }): ReactElement {
  return (
    <SafeAreaView
      id="notes.app"
      label="Notes"
      role="application"
      style={{
        align: "center",
        backgroundColor: props.colors.canvas,
        flexGrow: 1,
        justify: "center",
        padding: sevynTokens.spacing.lg,
      }}
    >
      <View
        id="notes.loading.card"
        style={{
          align: "center",
          backgroundColor: props.colors.surface,
          borderColor: props.colors.border,
          borderWidth: 1,
          gap: sevynTokens.spacing.sm,
          maxWidth: 360,
          padding: sevynTokens.spacing.xl,
          radius: sevynTokens.radius.lg,
          width: "100%",
        }}
      >
        <View
          id="notes.loading.mark"
          style={{
            backgroundColor: props.colors.accent,
            height: 42,
            radius: 14,
            width: 42,
          }}
        />
        <Text
          id="notes.loading.title"
          role="heading"
          style={{ color: props.colors.text, fontSize: 21, fontWeight: 700 }}
          text="Opening Notes"
        />
        <Text
          id="notes.loading.message"
          style={{ color: props.colors.textMuted, fontSize: 13, textAlign: "center" }}
          text="Restoring your private library…"
        />
      </View>
    </SafeAreaView>
  );
}

export function NotesApplication(): ReactElement {
  const sdk = useSevynApplicationSdk();
  const { width } = useWindowDimensions();
  const colors = useMemo(
    () => resolveSevynColors(sdk.theme.appearance, sdk.theme.accent),
    [sdk.theme.accent, sdk.theme.appearance],
  );
  const compact = width < 720;
  const [document, dispatch] = useReducer(notesReducer, undefined, () =>
    createDefaultNotesDocument(),
  );
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [banner, setBanner] = useState<Banner>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<NotesFilter>("all");
  const [compactPane, setCompactPane] = useState<CompactPane>("library");
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const documentRef = useRef(document);
  const savedPayloadRef = useRef<string | undefined>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const serializedDocument = useMemo(() => encodeNotesDocument(document), [document]);

  const persist = useCallback(
    (payload: string): void => {
      if (payload === savedPayloadRef.current) {
        if (mountedRef.current) setSaveStatus("saved");
        return;
      }
      const generation = saveGenerationRef.current + 1;
      saveGenerationRef.current = generation;
      if (mountedRef.current) setSaveStatus("saving");
      const request = saveQueueRef.current
        .catch(() => undefined)
        .then(() => sdk.storage.set(NOTES_STORAGE_KEY, payload));
      saveQueueRef.current = request;
      void request.then(
        () => {
          savedPayloadRef.current = payload;
          if (mountedRef.current && generation === saveGenerationRef.current)
            setSaveStatus("saved");
        },
        () => {
          if (mountedRef.current && generation === saveGenerationRef.current) {
            setSaveStatus("error");
            setBanner({
              tone: "danger",
              message:
                "Notes could not save this change. Shorten large notes or try Save again.",
            });
          }
        },
      );
    },
    [sdk.storage],
  );

  useEffect(() => {
    let active = true;
    setSaveStatus("loading");
    void sdk.storage
      .get(NOTES_STORAGE_KEY)
      .then((stored) => {
        if (!active) return;
        if (stored === undefined) {
          savedPayloadRef.current = undefined;
          return;
        }
        const decoded = decodeNotesDocument(stored);
        if (decoded === undefined) {
          setBanner({
            tone: "danger",
            message:
              "Saved notes could not be opened. Notes started a safe library without replacing that data yet.",
          });
          return;
        }
        dispatch({ type: "replace", document: decoded.document });
        savedPayloadRef.current =
          decoded.source === "current" && !decoded.recovered
            ? encodeNotesDocument(decoded.document)
            : undefined;
        if (decoded.source === "legacy" || decoded.recovered)
          setBanner({
            tone: "warning",
            message:
              decoded.source === "legacy"
                ? "Your existing notes were upgraded to the new library format."
                : "Notes recovered the valid items from your saved library.",
          });
      })
      .catch(() => {
        if (!active) return;
        setBanner({
          tone: "danger",
          message:
            "Saved notes are unavailable right now. You can keep writing and try Save again.",
        });
      })
      .finally(() => {
        if (!active) return;
        setHydrated(true);
        setSaveStatus(savedPayloadRef.current === undefined ? "saving" : "saved");
      });
    return () => {
      active = false;
    };
  }, [sdk.storage]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    if (!hydrated || serializedDocument === savedPayloadRef.current) return;
    setSaveStatus("saving");
    if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = undefined;
      persist(serializedDocument);
    }, 300);
    return () => {
      if (saveTimerRef.current !== undefined) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
    };
  }, [hydrated, persist, serializedDocument]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
      const payload = encodeNotesDocument(documentRef.current);
      if (payload !== savedPayloadRef.current)
        void saveQueueRef.current
          .catch(() => undefined)
          .then(() => sdk.storage.set(NOTES_STORAGE_KEY, payload))
          .catch(() => undefined);
    };
  }, [sdk.storage]);

  useEffect(() => {
    setPendingDeleteId(undefined);
  }, [document.selectedNoteId]);

  const activeNote = document.notes.find((note) => note.id === document.selectedNoteId);
  const visibleNotes = useMemo(
    () => filterNotes(document.notes, filter, query),
    [document.notes, filter, query],
  );
  const counts = useMemo(
    () =>
      new Map<NotesFilter, number>([
        ["all", document.notes.length],
        ["pinned", document.notes.filter((note) => note.pinned).length],
        ...NOTE_FOLDERS.map(
          (folder) =>
            [
              folder,
              document.notes.filter((note) => note.folder === folder).length,
            ] as const,
        ),
      ]),
    [document.notes],
  );

  const handleCreate = (): void => {
    if (document.notes.length >= MAX_NOTE_COUNT) {
      setBanner({
        tone: "warning",
        message: `This library supports ${String(MAX_NOTE_COUNT)} notes. Delete one before creating another.`,
      });
      return;
    }
    const folder: NoteFolder =
      filter === "all" || filter === "pinned" ? "Quick Notes" : filter;
    const note = createBlankNote(document.notes, folder);
    dispatch({ type: "create", note });
    setPendingDeleteId(undefined);
    setCompactPane("editor");
    sdk.notifications?.show({
      applicationId: notesManifest.id,
      title: "Notes",
      message: "New private note created.",
    });
  };

  const handleSelect = (noteId: string): void => {
    dispatch({ type: "select", noteId });
    setCompactPane("editor");
  };

  const handleDelete = (): void => {
    if (activeNote === undefined) return;
    if (pendingDeleteId !== activeNote.id) {
      setPendingDeleteId(activeNote.id);
      return;
    }
    const returnToLibrary = document.notes.length <= 1;
    dispatch({ type: "delete", noteId: activeNote.id });
    setPendingDeleteId(undefined);
    if (returnToLibrary) setCompactPane("library");
    sdk.notifications?.show({
      applicationId: notesManifest.id,
      title: "Notes",
      message: "Note deleted.",
    });
  };

  const handleDuplicate = (): void => {
    if (activeNote === undefined) return;
    if (document.notes.length >= MAX_NOTE_COUNT) {
      setBanner({
        tone: "warning",
        message: `This library supports ${String(MAX_NOTE_COUNT)} notes. Delete one before duplicating another.`,
      });
      return;
    }
    const note = duplicateNote(activeNote, document.notes);
    dispatch({ type: "duplicate", sourceId: activeNote.id, note });
    setPendingDeleteId(undefined);
  };

  const handleSaveNow = (): void => {
    if (saveTimerRef.current !== undefined) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    persist(encodeNotesDocument(documentRef.current));
  };

  const renderFilterRows = (): ReactElement => (
    <View id="notes.filters" style={{ gap: 6 }}>
      {[FILTERS.slice(0, 3), FILTERS.slice(3)].map((row, rowIndex) => (
        <View
          id={`notes.filters.row-${String(rowIndex + 1)}`}
          key={`filter-row-${String(rowIndex + 1)}`}
          style={{ direction: "row", gap: 6 }}
        >
          {row.map((item) => {
            const selected = filter === item.value;
            return (
              <Pressable
                id={`notes.filter.${filterId(item.value)}`}
                key={item.value}
                label={`${item.label}, ${noteCountLabel(counts.get(item.value) ?? 0)}`}
                onPress={(): void => {
                  setFilter(item.value);
                }}
                role="button"
                selected={selected}
                style={{
                  align: "center",
                  backgroundColor: selected ? colors.accent : colors.material,
                  borderColor: selected ? colors.accent : colors.border,
                  borderWidth: 1,
                  flexGrow: 1,
                  minHeight: 30,
                  paddingHorizontal: 7,
                  paddingVertical: 6,
                  radius: sevynTokens.radius.xs,
                }}
              >
                <Text
                  id={`notes.filter.${filterId(item.value)}.label`}
                  style={{
                    color: selected ? colors.accentText : colors.textSecondary,
                    fontSize: 10,
                    fontWeight: selected ? 700 : 600,
                    textAlign: "center",
                  }}
                  text={`${item.label} ${String(counts.get(item.value) ?? 0)}`}
                />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );

  const renderLibrary = (): ReactElement => (
    <View
      id="notes.library"
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: compact ? 0 : 1,
        flexGrow: compact ? 1 : 0,
        gap: sevynTokens.spacing.sm,
        padding: compact ? sevynTokens.spacing.md : sevynTokens.spacing.sm,
        radius: compact ? 0 : sevynTokens.radius.md,
        width: compact ? "100%" : 326,
      }}
    >
      <View
        id="notes.library.header"
        style={{ direction: "row", align: "center", justify: "space-between", gap: 12 }}
      >
        <View id="notes.library.heading" style={{ flexGrow: 1, gap: 2 }}>
          <Text
            id="notes.library.title"
            role="heading"
            style={{ color: colors.text, fontSize: 23, fontWeight: 700 }}
            text="Notes"
          />
          <Text
            id="notes.library.count"
            style={{ color: colors.textMuted, fontSize: 11 }}
            text={`${noteCountLabel(document.notes.length)} · private storage`}
          />
        </View>
        <Pressable
          disabled={document.notes.length >= MAX_NOTE_COUNT}
          id="notes.new"
          label="Create a new note"
          onPress={handleCreate}
          role="button"
          style={{
            align: "center",
            backgroundColor: colors.accent,
            minHeight: 38,
            opacity: document.notes.length >= MAX_NOTE_COUNT ? 0.5 : 1,
            paddingHorizontal: 14,
            paddingVertical: 9,
            radius: sevynTokens.radius.sm,
          }}
        >
          <Text
            id="notes.new.label"
            style={{ color: colors.accentText, fontSize: 12, fontWeight: 700 }}
            text="＋ New"
          />
        </Pressable>
      </View>

      <View
        id="notes.search.wrap"
        style={{
          backgroundColor: colors.canvas,
          borderColor: query.length > 0 ? colors.accent : colors.border,
          borderWidth: 1,
          direction: "row",
          align: "center",
          paddingHorizontal: 10,
          radius: sevynTokens.radius.sm,
        }}
      >
        <Text
          id="notes.search.glyph"
          style={{ color: colors.textMuted, fontSize: 15 }}
          text="⌕"
        />
        <TextInput
          id="notes.search"
          label="Search titles and note text"
          maxLength={120}
          onChangeText={setQuery}
          placeholder="Search your notes"
          role="textbox"
          style={{
            backgroundColor: "transparent",
            color: colors.text,
            flexGrow: 1,
            fontSize: 13,
            minHeight: 38,
            paddingHorizontal: 8,
            paddingVertical: 8,
          }}
          value={query}
        />
        {query.length === 0 ? null : (
          <Pressable
            id="notes.search.clear"
            label="Clear note search"
            onPress={(): void => {
              setQuery("");
            }}
            role="button"
            style={{ align: "center", minHeight: 30, padding: 6 }}
          >
            <Text
              id="notes.search.clear.label"
              style={{ color: colors.textMuted, fontSize: 16 }}
              text="×"
            />
          </Pressable>
        )}
      </View>

      {renderFilterRows()}

      <View
        id="notes.library.result-heading"
        style={{ direction: "row", justify: "space-between", align: "center" }}
      >
        <Text
          id="notes.library.result-label"
          style={{ color: colors.textSecondary, fontSize: 11, fontWeight: 700 }}
          text={query.trim().length === 0 ? "YOUR LIBRARY" : "SEARCH RESULTS"}
        />
        <Text
          id="notes.library.result-count"
          style={{ color: colors.textMuted, fontSize: 11 }}
          text={String(visibleNotes.length)}
        />
      </View>

      <ScrollView
        id="notes.list"
        label="Notes list"
        role="list"
        showsVerticalScrollIndicator
        style={{ flexGrow: 1, gap: 7, overflow: "scroll" }}
      >
        {visibleNotes.length === 0 ? (
          <View
            id="notes.list.empty"
            style={{
              align: "center",
              backgroundColor: colors.material,
              borderColor: colors.border,
              borderWidth: 1,
              gap: 7,
              marginTop: 8,
              padding: 22,
              radius: sevynTokens.radius.sm,
            }}
          >
            <Text
              id="notes.list.empty.title"
              style={{ color: colors.text, fontSize: 14, fontWeight: 700 }}
              text={document.notes.length === 0 ? "A clear page" : "No matching notes"}
            />
            <Text
              id="notes.list.empty.message"
              style={{ color: colors.textMuted, fontSize: 12, textAlign: "center" }}
              text={
                document.notes.length === 0
                  ? "Create your first note when inspiration arrives."
                  : "Try another search or choose a different collection."
              }
            />
            {document.notes.length === 0
              ? actionButton("notes.list.empty.new", "Create note", handleCreate, colors)
              : query.length > 0
                ? actionButton(
                    "notes.list.empty.clear",
                    "Clear search",
                    () => {
                      setQuery("");
                    },
                    colors,
                  )
                : null}
          </View>
        ) : (
          visibleNotes.map((note) => {
            const selected = note.id === activeNote?.id;
            return (
              <Pressable
                description={`${note.folder}, updated ${formatUpdatedAt(note.updatedAt)}`}
                id={`notes.item.${note.id}`}
                key={note.id}
                label={displayNoteTitle(note)}
                onPress={(): void => {
                  handleSelect(note.id);
                }}
                role="listitem"
                selected={selected}
                style={{
                  backgroundColor: selected ? colors.materialStrong : colors.material,
                  borderColor: selected ? colors.accent : colors.separator,
                  borderWidth: 1,
                  gap: 5,
                  padding: 11,
                  radius: sevynTokens.radius.sm,
                }}
              >
                <View
                  id={`notes.item.${note.id}.heading`}
                  style={{ direction: "row", justify: "space-between", gap: 8 }}
                >
                  <Text
                    id={`notes.item.${note.id}.title`}
                    style={{
                      color: selected ? colors.accent : colors.text,
                      flexGrow: 1,
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                    text={displayNoteTitle(note)}
                  />
                  {note.pinned ? (
                    <Text
                      id={`notes.item.${note.id}.pinned`}
                      label="Pinned"
                      style={{ color: colors.accent, fontSize: 11, fontWeight: 700 }}
                      text="PIN"
                    />
                  ) : null}
                </View>
                <Text
                  id={`notes.item.${note.id}.preview`}
                  style={{ color: colors.textSecondary, fontSize: 11 }}
                  text={notePreview(note)}
                />
                <Text
                  id={`notes.item.${note.id}.meta`}
                  style={{ color: colors.textMuted, fontSize: 10 }}
                  text={`${note.folder} · ${formatUpdatedAt(note.updatedAt)}`}
                />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  const renderEditor = (): ReactElement => (
    <KeyboardAvoidingView
      behavior="padding"
      id="notes.editor"
      style={{
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.border,
        borderWidth: compact ? 0 : 1,
        flexGrow: 1,
        gap: sevynTokens.spacing.sm,
        padding: compact ? sevynTokens.spacing.md : sevynTokens.spacing.lg,
        radius: compact ? 0 : sevynTokens.radius.md,
      }}
    >
      {activeNote === undefined ? (
        <View
          id="notes.editor.empty"
          style={{
            align: "center",
            flexGrow: 1,
            justify: "center",
            gap: 10,
            padding: 24,
          }}
        >
          <View
            id="notes.editor.empty.mark"
            style={{
              backgroundColor: colors.materialStrong,
              borderColor: colors.border,
              borderWidth: 1,
              height: 52,
              radius: 18,
              width: 52,
            }}
          />
          <Text
            id="notes.editor.empty.title"
            role="heading"
            style={{ color: colors.text, fontSize: 18, fontWeight: 700 }}
            text="Ready for a thought"
          />
          <Text
            id="notes.editor.empty.message"
            style={{ color: colors.textMuted, fontSize: 13, textAlign: "center" }}
            text="Choose a note from your library or create a new one."
          />
          {actionButton("notes.editor.empty.new", "Create note", handleCreate, colors)}
        </View>
      ) : (
        <>
          <View
            id="notes.editor.topbar"
            style={{
              direction: "row",
              align: "center",
              justify: "space-between",
              gap: 10,
            }}
          >
            <View id="notes.editor.topbar.leading" style={{ direction: "row", gap: 8 }}>
              {compact
                ? actionButton(
                    "notes.editor.back",
                    "← Library",
                    () => {
                      setCompactPane("library");
                    },
                    colors,
                  )
                : null}
              {actionButton(
                "notes.editor.pin",
                activeNote.pinned ? "Pinned" : "Pin",
                () => {
                  dispatch({
                    type: "toggle-pin",
                    noteId: activeNote.id,
                    now: Date.now(),
                  });
                },
                colors,
                { selected: activeNote.pinned },
              )}
            </View>
            <View id="notes.save-state" style={{ align: "end", gap: 2 }}>
              <Text
                id="notes.save-state.label"
                label={`Storage status: ${statusLabel(saveStatus)}`}
                style={{
                  color: statusColor(saveStatus, colors),
                  fontSize: 11,
                  fontWeight: 600,
                }}
                text={statusLabel(saveStatus)}
              />
              <Pressable
                disabled={saveStatus === "loading"}
                id="notes.save-now"
                label="Save this library now"
                onPress={handleSaveNow}
                role="button"
                style={{ padding: 2 }}
              >
                <Text
                  id="notes.save-now.label"
                  style={{ color: colors.accent, fontSize: 10, fontWeight: 700 }}
                  text="SAVE NOW"
                />
              </Pressable>
            </View>
          </View>

          <TextInput
            id="notes.title"
            label="Note title"
            maxLength={MAX_NOTE_TITLE_LENGTH}
            onChangeText={(title): void => {
              dispatch({
                type: "update",
                noteId: activeNote.id,
                now: Date.now(),
                changes: { title },
              });
            }}
            placeholder="Untitled note"
            role="textbox"
            style={{
              backgroundColor: "transparent",
              borderColor: colors.separator,
              borderWidth: 1,
              color: colors.text,
              fontSize: compact ? 22 : 27,
              fontWeight: 700,
              minHeight: 50,
              paddingHorizontal: 12,
              paddingVertical: 9,
              radius: sevynTokens.radius.sm,
            }}
            value={activeNote.title}
          />

          <View id="notes.folder-picker" style={{ gap: 6 }}>
            <Text
              id="notes.folder-picker.label"
              style={{ color: colors.textMuted, fontSize: 10, fontWeight: 700 }}
              text="COLLECTION"
            />
            <View id="notes.folder-picker.options" style={{ direction: "row", gap: 6 }}>
              {NOTE_FOLDERS.map((folder) => {
                const selected = folder === activeNote.folder;
                return (
                  <Pressable
                    id={`notes.folder.${filterId(folder)}`}
                    key={folder}
                    label={`Move note to ${folder}`}
                    onPress={(): void => {
                      dispatch({
                        type: "update",
                        noteId: activeNote.id,
                        now: Date.now(),
                        changes: { folder },
                      });
                    }}
                    role="button"
                    selected={selected}
                    style={{
                      align: "center",
                      backgroundColor: selected ? colors.accent : colors.material,
                      borderColor: selected ? colors.accent : colors.border,
                      borderWidth: 1,
                      flexGrow: 1,
                      minHeight: 31,
                      paddingHorizontal: 5,
                      paddingVertical: 6,
                      radius: sevynTokens.radius.xs,
                    }}
                  >
                    <Text
                      id={`notes.folder.${filterId(folder)}.label`}
                      style={{
                        color: selected ? colors.accentText : colors.textSecondary,
                        fontSize: compact ? 9 : 10,
                        fontWeight: 700,
                        textAlign: "center",
                      }}
                      text={folder}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>

          <TextInput
            id="notes.body"
            label="Note body"
            maxLength={MAX_NOTE_BODY_LENGTH}
            multiline
            onChangeText={(body): void => {
              dispatch({
                type: "update",
                noteId: activeNote.id,
                now: Date.now(),
                changes: { body },
              });
            }}
            placeholder="Start writing…"
            role="textbox"
            style={{
              backgroundColor: sdk.theme.appearance === "dark" ? "#15161B" : "#FCFCFD",
              borderColor: colors.separator,
              borderWidth: 1,
              color: colors.text,
              flexGrow: 1,
              fontSize: 15,
              minHeight: compact ? 250 : 320,
              padding: 16,
              radius: sevynTokens.radius.md,
            }}
            value={activeNote.body}
          />

          <View
            id="notes.editor.footer"
            style={{
              direction: "row",
              align: "center",
              justify: "space-between",
              gap: 10,
            }}
          >
            <Text
              id="notes.editor.stats"
              style={{ color: colors.textMuted, fontSize: 10 }}
              text={`${String(wordCount(activeNote.body))} words · ${String(activeNote.body.length)} characters · ${formatUpdatedAt(activeNote.updatedAt)}`}
            />
            <View id="notes.editor.actions" style={{ direction: "row", gap: 7 }}>
              {pendingDeleteId === activeNote.id
                ? actionButton(
                    "notes.delete.cancel",
                    "Cancel",
                    () => {
                      setPendingDeleteId(undefined);
                    },
                    colors,
                  )
                : null}
              {actionButton("notes.duplicate", "Duplicate", handleDuplicate, colors, {
                disabled: document.notes.length >= MAX_NOTE_COUNT,
              })}
              {actionButton(
                "notes.delete",
                pendingDeleteId === activeNote.id ? "Confirm delete" : "Delete",
                handleDelete,
                colors,
                { destructive: true },
              )}
            </View>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );

  if (!hydrated) return <NotesLoadingView colors={colors} />;

  return (
    <SafeAreaView
      id="notes.app"
      label="Notes"
      role="application"
      style={{ backgroundColor: colors.canvas, flexGrow: 1 }}
    >
      {banner === undefined ? null : (
        <View
          id="notes.banner"
          label={banner.message}
          style={{
            backgroundColor: colors.surfaceRaised,
            borderColor: banner.tone === "danger" ? colors.danger : colors.warning,
            borderWidth: 1,
            direction: "row",
            align: "center",
            justify: "space-between",
            gap: 12,
            marginHorizontal: compact ? 12 : 16,
            marginTop: 12,
            padding: 10,
            radius: sevynTokens.radius.sm,
          }}
        >
          <Text
            id="notes.banner.message"
            style={{ color: colors.textSecondary, flexGrow: 1, fontSize: 11 }}
            text={banner.message}
          />
          <Pressable
            id="notes.banner.dismiss"
            label="Dismiss message"
            onPress={(): void => {
              setBanner(undefined);
            }}
            role="button"
            style={{ padding: 6 }}
          >
            <Text
              id="notes.banner.dismiss.label"
              style={{ color: colors.textMuted, fontSize: 14 }}
              text="×"
            />
          </Pressable>
        </View>
      )}
      <View
        id="notes.workspace"
        style={{
          direction: compact ? "column" : "row",
          flexGrow: 1,
          gap: compact ? 0 : sevynTokens.spacing.sm,
          padding: compact ? 0 : sevynTokens.spacing.sm,
        }}
      >
        {compact
          ? compactPane === "library"
            ? renderLibrary()
            : renderEditor()
          : renderLibrary()}
        {compact ? null : renderEditor()}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  providerRoot: { flexGrow: 1 },
});

export function createNotesApplicationElement(sdk: SevynApplicationSdk): ReactElement {
  return createElement(
    SevynApplicationSdkProvider,
    { sdk },
    createElement(View, { style: styles.providerRoot }, createElement(NotesApplication)),
  ) as ReactElement;
}
