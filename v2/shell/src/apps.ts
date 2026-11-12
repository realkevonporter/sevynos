// SevynOS v2 M3 — the shell app registry.
//
// The dock renders from appd (Sevyn.listApps(), via the renderer's
// app store): the installed stock apps, each a .sevyn bundle in
// pristine. These 15 are the FALLBACK when appd's list is empty
// (appd down at first mount) — they match the pristine manifests, so
// the dock looks identical either way. Icons are coloured tiles with
// an initial (M3 has no staged image assets yet); real app icons land
// with a later app-bundle pass.

export interface ShellApp {
  id: string;
  name: string;
  // Tile background colour.
  color: string;
  // Initial letter drawn on the tile.
  glyph: string;
  // Per-app single-instance flag (default true): a dock click on a
  // running single-instance app focuses it; a running multi-instance
  // app opens a new window instead. Files, Terminal, Notes and
  // Browser are multi-instance (Kevon, 2026-11-10).
  singleInstance: boolean;
}

export const APPS: ShellApp[] = [
  { id: "files", name: "Files", color: "#3b82f6", glyph: "F", singleInstance: false },
  {
    id: "terminal",
    name: "Terminal",
    color: "#111827",
    glyph: ">",
    singleInstance: false,
  },
  { id: "browser", name: "Browser", color: "#0ea5e9", glyph: "B", singleInstance: false },
  {
    id: "settings",
    name: "Settings",
    color: "#6b7280",
    glyph: "S",
    singleInstance: true,
  },
  { id: "music", name: "Music", color: "#ec4899", glyph: "M", singleInstance: true },
  { id: "photos", name: "Photos", color: "#f59e0b", glyph: "P", singleInstance: true },
  {
    id: "calendar",
    name: "Calendar",
    color: "#ef4444",
    glyph: "C",
    singleInstance: true,
  },
  { id: "notes", name: "Notes", color: "#eab308", glyph: "N", singleInstance: false },
  {
    id: "calculator",
    name: "Calculator",
    color: "#8b5cf6",
    glyph: "=",
    singleInstance: true,
  },
  { id: "camera", name: "Camera", color: "#14b8a6", glyph: "O", singleInstance: true },
  {
    id: "messages",
    name: "Messages",
    color: "#22c55e",
    glyph: "M",
    singleInstance: true,
  },
  // M10 working titles — Kevon picks the final names later.
  {
    id: "video-calls",
    name: "Video Calls",
    color: "#7c3aed",
    glyph: "V",
    singleInstance: true,
  },
  {
    id: "voice-calls",
    name: "Voice Calls",
    color: "#0d9488",
    glyph: "V",
    singleInstance: true,
  },
  { id: "store", name: "Store", color: "#f97316", glyph: "S", singleInstance: true },
  {
    id: "installer",
    name: "Installer",
    color: "#2563eb",
    glyph: "↓",
    singleInstance: true,
  },
];
