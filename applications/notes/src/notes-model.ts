export const NOTES_STORAGE_KEY = "notes";
export const NOTES_SCHEMA_VERSION = 2 as const;
export const MAX_NOTE_TITLE_LENGTH = 160;
export const MAX_NOTE_BODY_LENGTH = 100_000;
export const MAX_NOTE_COUNT = 250;

export const NOTE_FOLDERS = Object.freeze([
  "Quick Notes",
  "Work",
  "Ideas",
  "Personal",
] as const);

export type NoteFolder = (typeof NOTE_FOLDERS)[number];
export type NotesFilter = "all" | "pinned" | NoteFolder;

export interface NoteRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly folder: NoteFolder;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NotesDocument {
  readonly schemaVersion: typeof NOTES_SCHEMA_VERSION;
  readonly selectedNoteId?: string;
  readonly notes: readonly NoteRecord[];
}

export interface DecodedNotesDocument {
  readonly document: NotesDocument;
  readonly source: "current" | "legacy";
  readonly recovered: boolean;
}

export type NotesAction =
  | { readonly type: "replace"; readonly document: NotesDocument }
  | { readonly type: "select"; readonly noteId: string }
  | { readonly type: "create"; readonly note: NoteRecord }
  | {
      readonly type: "update";
      readonly noteId: string;
      readonly now: number;
      readonly changes: Readonly<Partial<Pick<NoteRecord, "title" | "body" | "folder">>>;
    }
  | { readonly type: "toggle-pin"; readonly noteId: string; readonly now: number }
  | { readonly type: "duplicate"; readonly sourceId: string; readonly note: NoteRecord }
  | { readonly type: "delete"; readonly noteId: string };

const DEFAULT_WELCOME_BODY =
  "Welcome to Notes. Your writing stays in this app's private SevynOS storage.\n\n" +
  "Create a note, choose a folder, pin the important ones, and search every title and body from one place.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFolder = (value: unknown): value is NoteFolder =>
  typeof value === "string" && NOTE_FOLDERS.some((folder) => folder === value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const normalizedTitle = (value: string): string => value.slice(0, MAX_NOTE_TITLE_LENGTH);

const normalizedBody = (value: string): string => value.slice(0, MAX_NOTE_BODY_LENGTH);

function parseCurrentNote(value: unknown): NoteRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    value["id"].trim().length === 0 ||
    value["id"].length > 128 ||
    typeof value["title"] !== "string" ||
    typeof value["body"] !== "string" ||
    !isFolder(value["folder"]) ||
    typeof value["pinned"] !== "boolean" ||
    !isTimestamp(value["createdAt"]) ||
    !isTimestamp(value["updatedAt"])
  )
    return undefined;

  return Object.freeze({
    id: value["id"],
    title: normalizedTitle(value["title"]),
    body: normalizedBody(value["body"]),
    folder: value["folder"],
    pinned: value["pinned"],
    createdAt: value["createdAt"],
    updatedAt: Math.max(value["createdAt"], value["updatedAt"]),
  });
}

function parseLegacyNote(
  value: unknown,
  fallbackTimestamp: number,
): NoteRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    value["id"].trim().length === 0 ||
    value["id"].length > 128 ||
    typeof value["title"] !== "string" ||
    typeof value["body"] !== "string"
  )
    return undefined;

  return Object.freeze({
    id: value["id"],
    title: normalizedTitle(value["title"]),
    body: normalizedBody(value["body"]),
    folder: isFolder(value["folder"]) ? value["folder"] : "Quick Notes",
    pinned: typeof value["pinned"] === "boolean" ? value["pinned"] : false,
    createdAt: isTimestamp(value["createdAt"]) ? value["createdAt"] : fallbackTimestamp,
    updatedAt: isTimestamp(value["updatedAt"]) ? value["updatedAt"] : fallbackTimestamp,
  });
}

function recoverNotes(
  values: readonly unknown[],
  parse: (value: unknown, index: number) => NoteRecord | undefined,
): { readonly notes: readonly NoteRecord[]; readonly recovered: boolean } {
  const notes: NoteRecord[] = [];
  const ids = new Set<string>();
  let recovered = values.length > MAX_NOTE_COUNT;

  for (const [index, value] of values.slice(0, MAX_NOTE_COUNT).entries()) {
    const note = parse(value, index);
    if (note === undefined || ids.has(note.id)) {
      recovered = true;
      continue;
    }
    ids.add(note.id);
    notes.push(note);
  }

  return { notes: Object.freeze(notes), recovered };
}

export function createDefaultNotesDocument(now = Date.now()): NotesDocument {
  const welcome = Object.freeze({
    id: "welcome",
    title: "Welcome to Notes",
    body: DEFAULT_WELCOME_BODY,
    folder: "Quick Notes" as const,
    pinned: true,
    createdAt: now,
    updatedAt: now,
  });
  return Object.freeze({
    schemaVersion: NOTES_SCHEMA_VERSION,
    selectedNoteId: welcome.id,
    notes: Object.freeze([welcome]),
  });
}

export function decodeNotesDocument(
  serialized: string,
  now = Date.now(),
): DecodedNotesDocument | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }

  if (Array.isArray(value)) {
    const result = recoverNotes(value, (candidate, index) =>
      parseLegacyNote(candidate, Math.max(0, now - index)),
    );
    if (value.length > 0 && result.notes.length === 0) return undefined;
    return Object.freeze({
      source: "legacy" as const,
      recovered: result.recovered,
      document: Object.freeze({
        schemaVersion: NOTES_SCHEMA_VERSION,
        ...(result.notes[0] === undefined ? {} : { selectedNoteId: result.notes[0].id }),
        notes: result.notes,
      }),
    });
  }

  if (
    !isRecord(value) ||
    value["schemaVersion"] !== NOTES_SCHEMA_VERSION ||
    !Array.isArray(value["notes"])
  )
    return undefined;

  const result = recoverNotes(value["notes"], (candidate) => parseCurrentNote(candidate));
  if (value["notes"].length > 0 && result.notes.length === 0) return undefined;
  const requestedSelection = value["selectedNoteId"];
  const selectedNoteId =
    typeof requestedSelection === "string" &&
    result.notes.some((note) => note.id === requestedSelection)
      ? requestedSelection
      : result.notes[0]?.id;
  const recovered =
    result.recovered ||
    (requestedSelection !== undefined && requestedSelection !== selectedNoteId);

  return Object.freeze({
    source: "current" as const,
    recovered,
    document: Object.freeze({
      schemaVersion: NOTES_SCHEMA_VERSION,
      ...(selectedNoteId === undefined ? {} : { selectedNoteId }),
      notes: result.notes,
    }),
  });
}

export function encodeNotesDocument(document: NotesDocument): string {
  return JSON.stringify(document);
}

export function nextNoteId(notes: readonly NoteRecord[], now = Date.now()): string {
  const base = `note-${String(Math.max(0, Math.floor(now)))}`;
  const used = new Set(notes.map((note) => note.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${String(suffix)}`)) suffix += 1;
  return `${base}-${String(suffix)}`;
}

export function createBlankNote(
  notes: readonly NoteRecord[],
  folder: NoteFolder,
  now = Date.now(),
): NoteRecord {
  return Object.freeze({
    id: nextNoteId(notes, now),
    title: "",
    body: "",
    folder,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  });
}

export function displayNoteTitle(note: Pick<NoteRecord, "title" | "body">): string {
  const explicit = note.title.trim();
  if (explicit.length > 0) return explicit;
  const firstBodyLine = note.body.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim();
  return firstBodyLine === undefined || firstBodyLine.length === 0
    ? "Untitled note"
    : firstBodyLine.slice(0, 60);
}

export function notePreview(note: Pick<NoteRecord, "body">): string {
  const preview = note.body.replace(/\s+/g, " ").trim();
  return preview.length === 0 ? "No additional text" : preview.slice(0, 96);
}

export function filterNotes(
  notes: readonly NoteRecord[],
  filter: NotesFilter,
  query: string,
): readonly NoteRecord[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return Object.freeze(
    notes
      .filter((note) => {
        const matchesFilter =
          filter === "all" ||
          (filter === "pinned" ? note.pinned : note.folder === filter);
        if (!matchesFilter) return false;
        if (normalizedQuery.length === 0) return true;
        return `${note.title}\n${note.body}\n${note.folder}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.updatedAt - left.updatedAt ||
          left.id.localeCompare(right.id),
      ),
  );
}

export function notesReducer(
  document: NotesDocument,
  action: NotesAction,
): NotesDocument {
  if (action.type === "replace") return action.document;

  if (action.type === "select") {
    if (
      action.noteId === document.selectedNoteId ||
      !document.notes.some((note) => note.id === action.noteId)
    )
      return document;
    return Object.freeze({ ...document, selectedNoteId: action.noteId });
  }

  if (action.type === "create") {
    if (
      document.notes.length >= MAX_NOTE_COUNT ||
      document.notes.some((note) => note.id === action.note.id)
    )
      return document;
    return Object.freeze({
      ...document,
      selectedNoteId: action.note.id,
      notes: Object.freeze([action.note, ...document.notes]),
    });
  }

  if (action.type === "update") {
    const noteIndex = document.notes.findIndex((note) => note.id === action.noteId);
    if (noteIndex < 0) return document;
    const note = document.notes[noteIndex];
    if (note === undefined) return document;
    const title = normalizedTitle(action.changes.title ?? note.title);
    const body =
      action.changes.body === undefined ? note.body : normalizedBody(action.changes.body);
    const folder = action.changes.folder ?? note.folder;
    if (title === note.title && body === note.body && folder === note.folder)
      return document;
    const notes = [...document.notes];
    notes[noteIndex] = Object.freeze({
      ...note,
      title,
      body,
      folder,
      updatedAt: Math.max(note.updatedAt, action.now),
    });
    return Object.freeze({ ...document, notes: Object.freeze(notes) });
  }

  if (action.type === "toggle-pin") {
    const noteIndex = document.notes.findIndex((note) => note.id === action.noteId);
    if (noteIndex < 0) return document;
    const notes = document.notes.map((note) => {
      if (note.id !== action.noteId) return note;
      return Object.freeze({
        ...note,
        pinned: !note.pinned,
        updatedAt: Math.max(note.updatedAt, action.now),
      });
    });
    return Object.freeze({ ...document, notes: Object.freeze(notes) });
  }

  if (action.type === "duplicate") {
    if (
      document.notes.length >= MAX_NOTE_COUNT ||
      document.notes.some((note) => note.id === action.note.id) ||
      !document.notes.some((note) => note.id === action.sourceId)
    )
      return document;
    return Object.freeze({
      ...document,
      selectedNoteId: action.note.id,
      notes: Object.freeze([action.note, ...document.notes]),
    });
  }

  const removedIndex = document.notes.findIndex((note) => note.id === action.noteId);
  if (removedIndex < 0) return document;
  const notes = document.notes.filter((note) => note.id !== action.noteId);
  const selectedNoteId =
    document.selectedNoteId === action.noteId
      ? notes[Math.min(removedIndex, notes.length - 1)]?.id
      : document.selectedNoteId;
  return Object.freeze({
    ...(selectedNoteId === undefined
      ? (() => {
          const documentWithoutSelection = Object.fromEntries(
            Object.entries(document).filter(([key]) => key !== "selectedNoteId"),
          ) as Omit<NotesDocument, "selectedNoteId">;
          return documentWithoutSelection;
        })()
      : { ...document, selectedNoteId }),
    notes: Object.freeze(notes),
  });
}

export function duplicateNote(
  source: NoteRecord,
  notes: readonly NoteRecord[],
  now = Date.now(),
): NoteRecord {
  return Object.freeze({
    ...source,
    id: nextNoteId(notes, now),
    title: `${displayNoteTitle(source)} copy`.slice(0, MAX_NOTE_TITLE_LENGTH),
    pinned: false,
    createdAt: now,
    updatedAt: now,
  });
}
