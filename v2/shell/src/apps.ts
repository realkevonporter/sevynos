// SevynOS v2 M3 — the shell app registry.
//
// The dock renders from appd (Sevyn.listApps(), via the renderer's
// app store): the installed stock apps, each a .sevyn bundle in
// pristine. These 12 are the FALLBACK when appd's list is empty
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
}

export const APPS: ShellApp[] = [
  { id: "files", name: "Files", color: "#3b82f6", glyph: "F" },
  { id: "terminal", name: "Terminal", color: "#111827", glyph: ">" },
  { id: "browser", name: "Browser", color: "#0ea5e9", glyph: "B" },
  { id: "settings", name: "Settings", color: "#6b7280", glyph: "S" },
  { id: "music", name: "Music", color: "#ec4899", glyph: "M" },
  { id: "photos", name: "Photos", color: "#f59e0b", glyph: "P" },
  { id: "calendar", name: "Calendar", color: "#ef4444", glyph: "C" },
  { id: "notes", name: "Notes", color: "#eab308", glyph: "N" },
  { id: "calculator", name: "Calculator", color: "#8b5cf6", glyph: "=" },
  { id: "camera", name: "Camera", color: "#14b8a6", glyph: "O" },
  { id: "messages", name: "Messages", color: "#22c55e", glyph: "M" },
  { id: "store", name: "Store", color: "#f97316", glyph: "S" },
];
