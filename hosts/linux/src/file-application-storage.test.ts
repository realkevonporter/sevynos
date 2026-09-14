import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileLinuxApplicationStorage,
  FileLinuxPersistenceAdapter,
} from "./wayland-bridge.js";

describe("persistent Linux application storage", () => {
  it("restores isolated application data across host instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sevyn-linux-storage-"));
    try {
      const persistence = new FileLinuxPersistenceAdapter(directory);
      const first = await FileLinuxApplicationStorage.create(persistence);
      await first.set("org.sevynos.notes", "notes", "persistent note");
      const second = await FileLinuxApplicationStorage.create(persistence);
      await expect(second.get("org.sevynos.notes", "notes")).resolves.toBe(
        "persistent note",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("repairs malformed stored values and enforces quotas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sevyn-linux-storage-"));
    try {
      const persistence = new FileLinuxPersistenceAdapter(directory);
      await persistence.save("application-storage", {
        "org.sevynos.notes:valid": "note",
        "org.sevynos.notes:invalid": 42,
      });
      const storage = await FileLinuxApplicationStorage.create(persistence);
      await expect(storage.get("org.sevynos.notes", "valid")).resolves.toBe("note");
      await expect(storage.get("org.sevynos.notes", "invalid")).resolves.toBeUndefined();
      await expect(
        storage.set("org.sevynos.notes", "oversized", "x".repeat(1024 * 1024 + 1)),
      ).rejects.toThrow("quota");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
