import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCoreSystemApplication,
  SevynApplicationRuntime,
  SystemNotificationService,
  type AccessibilityNode,
} from "@sevynos/react-native/internal";
import { LinuxFileSystem } from "./linux-file-system.js";

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for the Files UI to update.");
};
const flatten = (nodes: readonly AccessibilityNode[]): readonly AccessibilityNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children)]);

describe("Files UI with native user storage", () => {
  let root: string;
  let filesystem: LinuxFileSystem;
  let runtime: SevynApplicationRuntime;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sevyn-files-ui-"));
    filesystem = new LinuxFileSystem({ rootDirectory: root, defaultFiles: false });
    await filesystem.write("/Documents/report.txt", "original");
    await filesystem.moveToTrash("/Documents/report.txt");
    runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 1600, height: 900 },
    });
    runtime.mount(
      createCoreSystemApplication({
        kind: "files",
        filesystem,
        notifications: new SystemNotificationService(),
      }),
    );
    await settle();
  });
  afterEach(async () => {
    runtime.unmount();
    await rm(root, { recursive: true, force: true });
  });
  const click = async (id: string): Promise<void> => {
    await waitFor(() =>
      flatten(runtime.snapshot.accessibility).some((item) => item.id === id),
    );
    const node = flatten(runtime.snapshot.accessibility).find((item) => item.id === id);
    expect(node, `Missing UI target ${id}`).toBeDefined();
    if (!node) return;
    const point = {
      x: node.bounds.x + node.bounds.width / 2,
      y: node.bounds.y + node.bounds.height / 2,
      pointerId: 1,
      button: 0,
    };
    runtime.dispatchPointer("down", point);
    runtime.dispatchPointer("up", point);
    await settle();
  };
  it("lists and restores real Trash payloads through pointer input", async () => {
    await click("files.loc.trash");
    await click("file.trash://report.txt");
    await click("files.restore");
    expect(await filesystem.read("/Documents/report.txt")).toBe("original");
    expect(await filesystem.listTrash()).toEqual([]);
  });
  it("requires confirmation before permanently emptying real Trash", async () => {
    await click("files.loc.trash");
    await click("files.empty_trash");
    expect(await filesystem.listTrash()).toHaveLength(1);
    await click("files.cancel_empty");
    expect(await filesystem.listTrash()).toHaveLength(1);
    await click("files.empty_trash");
    await click("files.empty_trash");
    expect(await filesystem.listTrash()).toEqual([]);
  });
  it("shows restore conflicts without losing either file", async () => {
    await filesystem.write("/Documents/report.txt", "new");
    await click("files.loc.trash");
    await click("file.trash://report.txt");
    await click("files.restore");
    expect(
      runtime.snapshot.commands.some(
        (command) =>
          command.kind === "text" && command.text.includes("Destination already exists"),
      ),
    ).toBe(true);
    expect(await filesystem.read("/Documents/report.txt")).toBe("new");
    expect(await filesystem.listTrash()).toHaveLength(1);
  });
});
