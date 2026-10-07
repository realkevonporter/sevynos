import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lastRollback,
  markSessionReady,
  readRollbackHistory,
  updatesDir,
  type RollbackRecord,
} from "./boot-health.js";
import { OsUpdateService } from "./os-update-service.js";

let stateDir: string | undefined;

afterEach(async () => {
  if (stateDir !== undefined) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

async function makeStateDir(): Promise<string> {
  stateDir = await mkdtemp(join(tmpdir(), "sevyn-boot-health-"));
  return stateDir;
}

function record(overrides: Partial<RollbackRecord> = {}): RollbackRecord {
  return {
    ts: "2026-10-07T15:30:00.000Z",
    event: "rollback",
    fromVersion: "1.2.4",
    toVersion: "1.2.3",
    reason: "3 consecutive boots without a healthy desktop",
    ...overrides,
  };
}

describe("markSessionReady", () => {
  it("writes the session-ready marker and resets the boot-attempt counter", async () => {
    const dir = await makeStateDir();
    const updates = updatesDir(dir);
    await mkdir(updates, { recursive: true });
    await writeFile(join(updates, "boot-attempts"), "2\n", "utf8");

    await markSessionReady(dir);

    const { readFile } = await import("node:fs/promises");
    const markerContent = await readFile(join(updates, "session-ready"), "utf8");
    expect(new Date(markerContent.trim()).toISOString()).toBe(markerContent.trim());
    const attempts = await readFile(join(updates, "boot-attempts"), "utf8");
    expect(attempts).toBe("0\n");
    // The marker is not rollback history.
    expect(await readRollbackHistory(dir)).toEqual([]);
  });

  it("creates the updates directory when missing", async () => {
    const dir = await makeStateDir();
    await markSessionReady(dir);
    const { readFile } = await import("node:fs/promises");
    const attempts = await readFile(join(updatesDir(dir), "boot-attempts"), "utf8");
    expect(attempts).toBe("0\n");
  });
});

describe("readRollbackHistory", () => {
  it("returns an empty list when the log is missing", async () => {
    const dir = await makeStateDir();
    expect(await readRollbackHistory(dir)).toEqual([]);
  });

  it("parses JSONL events and skips malformed lines", async () => {
    const dir = await makeStateDir();
    const updates = updatesDir(dir);
    await mkdir(updates, { recursive: true });
    const first = record();
    const second = record({
      event: "rollback-unavailable",
      fromVersion: "1.2.4",
      toVersion: "",
      reason: "no verified backup slot",
    });
    await writeFile(
      join(updates, "rollback-history.jsonl"),
      [
        JSON.stringify(first),
        "not-json{",
        "",
        JSON.stringify({ ts: "x" }),
        JSON.stringify(second),
      ].join("\n"),
      "utf8",
    );

    const history = await readRollbackHistory(dir);
    expect(history).toEqual([first, second]);
  });
});

describe("lastRollback", () => {
  it("returns undefined when there is no history", async () => {
    const dir = await makeStateDir();
    expect(await lastRollback(dir)).toBeUndefined();
  });

  it("returns the most recent event", async () => {
    const dir = await makeStateDir();
    const updates = updatesDir(dir);
    await mkdir(updates, { recursive: true });
    const first = record();
    const second = record({ event: "rollback-failed", reason: "unsquashfs failed" });
    await writeFile(
      join(updates, "rollback-history.jsonl"),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      "utf8",
    );
    expect(await lastRollback(dir)).toEqual(second);
  });
});

describe("OsUpdateService.lastRollback", () => {
  it("reads the rollback history from its state directory", async () => {
    const dir = await makeStateDir();
    const updates = updatesDir(dir);
    await mkdir(updates, { recursive: true });
    const expected = record();
    await writeFile(
      join(updates, "rollback-history.jsonl"),
      `${JSON.stringify(expected)}\n`,
      "utf8",
    );
    const service = new OsUpdateService({
      currentVersion: "1.2.4",
      feedUrl: "https://example.com/updates.json",
      stateDirectory: dir,
    });
    try {
      expect(await service.lastRollback()).toEqual(expected);
    } finally {
      service.dispose();
    }
  });

  it("returns undefined when no rollback ever happened", async () => {
    const dir = await makeStateDir();
    const service = new OsUpdateService({
      currentVersion: "1.2.4",
      feedUrl: "https://example.com/updates.json",
      stateDirectory: dir,
    });
    try {
      expect(await service.lastRollback()).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
});
