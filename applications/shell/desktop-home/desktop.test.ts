/* eslint-disable no-restricted-imports */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SevynApplicationRuntime } from "@sevynos/react-native/internal";
import { DesktopWorkspace, desktopTileForEntry } from "./desktop.js";

const DISPLAY = { x: 0, y: 0, width: 1280, height: 800 };

const ENTRIES = [
  { name: "Photos", path: "/Desktop/Photos", kind: "directory" as const },
  { name: "Report.txt", path: "/Desktop/Report.txt", kind: "file" as const },
  { name: "song.mp3", path: "/Desktop/song.mp3", kind: "file" as const },
];

function mountWorkspace(props: Record<string, unknown> = {}) {
  const runtime = new SevynApplicationRuntime({
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
  });
  runtime.mount(
    createElement(DesktopWorkspace, {
      display: DISPLAY,
      entries: ENTRIES,
      order: 0.5,
      ...props,
    }),
  );
  return runtime;
}

function textContent(runtime: SevynApplicationRuntime): string {
  return runtime.snapshot.commands
    .filter((cmd) => cmd.kind === "text")
    .map((cmd) => ("text" in cmd && typeof cmd.text === "string" ? cmd.text : ""))
    .join("\n");
}

function pressText(runtime: SevynApplicationRuntime, needle: string): void {
  const target = runtime.snapshot.commands.find((cmd) => {
    if (cmd.kind !== "text" || !("text" in cmd)) return false;
    return typeof cmd.text === "string" && cmd.text.includes(needle);
  });
  if (target === undefined) throw new Error(`No text "${needle}" rendered.`);
  const cx = target.bounds.x + target.bounds.width / 2;
  const cy = target.bounds.y + target.bounds.height / 2;
  runtime.dispatchPointer("down", { x: cx, y: cy, pointerId: 1, button: 0 });
  runtime.dispatchPointer("up", { x: cx, y: cy, pointerId: 1, button: 0 });
}

// The runtime applies press-driven re-renders asynchronously; poll for the
// menu text instead of asserting it synchronously after the right-click.
async function waitForText(
  runtime: SevynApplicationRuntime,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = textContent(runtime);
  while (!text.includes(needle) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    text = textContent(runtime);
  }
  return text;
}

describe("desktopTileForEntry", () => {
  it("maps folders and file types to direction-C tiles", () => {
    expect(desktopTileForEntry("Photos", "directory")).toEqual({
      icon: "folder",
      tileColor: "#F5A623",
      kind: "folder",
    });
    expect(desktopTileForEntry("photo.png", "file")).toEqual({
      icon: "image",
      tileColor: "#E0448C",
      kind: "image",
    });
    expect(desktopTileForEntry("Report.txt", "file")).toEqual({
      icon: "file-text",
      tileColor: "#3B82F6",
      kind: "document",
    });
    expect(desktopTileForEntry("song.mp3", "file")).toEqual({
      icon: "music-note",
      tileColor: "#10B981",
      kind: "audio",
    });
    expect(desktopTileForEntry("movie.mp4", "file")).toEqual({
      icon: "film",
      tileColor: "#8B5CF6",
      kind: "video",
    });
    expect(desktopTileForEntry("notes.md", "file")).toMatchObject({
      kind: "document",
    });
    expect(desktopTileForEntry("archive.zip", "file")).toEqual({
      icon: "file-text",
      tileColor: "#E8930C",
      kind: "archive",
    });
    expect(desktopTileForEntry("mystery.xyz", "file")).toEqual({
      icon: "file-text",
      tileColor: "#64748B",
      kind: "file",
    });
  });
});

describe("DesktopWorkspace", () => {
  it("renders direction-C tiles with white glyphs for every entry", () => {
    const runtime = mountWorkspace();
    const icons = runtime.snapshot.commands.filter((cmd) => cmd.kind === "icon");
    expect(icons).toContainEqual(
      expect.objectContaining({ icon: "folder", color: "#FFFFFF" }),
    );
    expect(icons).toContainEqual(
      expect.objectContaining({ icon: "file-text", color: "#FFFFFF" }),
    );
    expect(icons).toContainEqual(
      expect.objectContaining({ icon: "music-note", color: "#FFFFFF" }),
    );
    const materials = runtime.snapshot.commands.filter((cmd) => cmd.kind === "material");
    const colors = materials.map((cmd) => ("color" in cmd ? cmd.color : ""));
    expect(colors).toContain("#F5A623");
    expect(colors).toContain("#3B82F6");
    expect(colors).toContain("#10B981");
    expect(textContent(runtime)).toContain("Photos");
    expect(textContent(runtime)).toContain("Report.txt");
    expect(textContent(runtime)).toContain("song.mp3");
  });

  it("opens an entry on a left-click", () => {
    const onOpenEntry = vi.fn();
    const runtime = mountWorkspace({ onOpenEntry });
    // First icon: x 24, y 122 (action row at 70 + 52), 104x92.
    runtime.dispatchPointer("down", { x: 76, y: 168, pointerId: 1, button: 0 });
    runtime.dispatchPointer("up", { x: 76, y: 168, pointerId: 1, button: 0 });
    expect(onOpenEntry).toHaveBeenCalledWith("/Desktop/Photos");
  });

  it("opens the icon context menu on right-click and deletes from it", async () => {
    const onDeleteEntry = vi.fn();
    const runtime = mountWorkspace({ onDeleteEntry });
    expect(textContent(runtime)).not.toContain("Delete");
    runtime.dispatchPointer("down", { x: 76, y: 168, pointerId: 1, button: 2 });
    const menuText = await waitForText(runtime, "Open");
    expect(menuText).toContain("Open");
    expect(menuText).toContain("Cut");
    expect(menuText).toContain("Copy");
    expect(menuText).toContain("Rename");
    expect(menuText).toContain("Delete");
    pressText(runtime, "Delete");
    expect(onDeleteEntry).toHaveBeenCalledWith("/Desktop/Photos");
  });

  it("opens the background menu on right-click and changes wallpaper from it", async () => {
    const onChangeWallpaper = vi.fn();
    const runtime = mountWorkspace({ onChangeWallpaper });
    runtime.dispatchPointer("down", { x: 600, y: 400, pointerId: 1, button: 2 });
    const menuText = await waitForText(runtime, "Change wallpaper");
    expect(menuText).toContain("Change wallpaper");
    pressText(runtime, "Change wallpaper");
    expect(onChangeWallpaper).toHaveBeenCalled();
  });

  it("opens the rename dialog from the icon menu", async () => {
    const runtime = mountWorkspace({});
    runtime.dispatchPointer("down", { x: 76, y: 168, pointerId: 1, button: 2 });
    await waitForText(runtime, "Rename");
    pressText(runtime, "Rename");
    const dialogText = await waitForText(runtime, "Rename “Photos”");
    expect(dialogText).toContain("Rename “Photos”");
  });
});
