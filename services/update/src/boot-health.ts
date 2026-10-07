import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Boot-health on-disk layout, shared with tools/qemu/sevyn-boot-health.sh
 * and the applier's snapshot_previous (the shell scripts are the
 * authority at boot; this module is the session-side writer/reader used
 * by Genesis and the Software Update UI).
 *
 * The pre-update snapshot is the single rollback slot, shared with the
 * manual recovery environment (tools/qemu/recovery/.../rollback.sh):
 * <stateDirectory>/updates/previous/{rootfs.squashfs,version.json}.
 * The tamper-evident pin lives under <stateDirectory>/update-trust/
 * (root-only).
 */
export const UPDATES_DIR_NAME = "updates";
export const SNAPSHOT_DIR_NAME = "previous";
export const SNAPSHOT_FILE_NAME = "rootfs.squashfs";
export const SNAPSHOT_META_FILE_NAME = "version.json";
export const TRUST_DIR_NAME = "update-trust";
export const PIN_FILE_NAME = "previous.sha256";
export const BOOT_ATTEMPTS_FILE_NAME = "boot-attempts";
export const SESSION_READY_FILE_NAME = "session-ready";
export const ROLLBACK_HISTORY_FILE_NAME = "rollback-history.jsonl";

export type RollbackEventKind =
  "rollback" | "rollback-aborted" | "rollback-unavailable" | "rollback-failed";

export interface RollbackRecord {
  readonly ts: string;
  readonly event: RollbackEventKind;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reason: string;
}

export function updatesDir(stateDirectory: string): string {
  return join(stateDirectory, UPDATES_DIR_NAME);
}

export function snapshotDir(stateDirectory: string): string {
  return join(updatesDir(stateDirectory), SNAPSHOT_DIR_NAME);
}

function isRollbackEventKind(value: unknown): value is RollbackEventKind {
  return (
    value === "rollback" ||
    value === "rollback-aborted" ||
    value === "rollback-unavailable" ||
    value === "rollback-failed"
  );
}

function isRollbackRecord(value: unknown): value is RollbackRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["ts"] === "string" &&
    isRollbackEventKind(record["event"]) &&
    typeof record["fromVersion"] === "string" &&
    typeof record["toVersion"] === "string" &&
    typeof record["reason"] === "string"
  );
}

/**
 * Marks the boot as healthy: writes the session-ready marker (consumed by
 * the next boot's init) and resets the boot-attempt counter. Called once
 * per session, when the desktop first presents a frame. Best-effort by
 * contract — callers must never let a failure here break the session.
 */
export async function markSessionReady(stateDirectory: string): Promise<void> {
  const dir = updatesDir(stateDirectory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, SESSION_READY_FILE_NAME),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
  await writeFile(join(dir, BOOT_ATTEMPTS_FILE_NAME), "0\n", "utf8");
}

/**
 * Reads the rollback history log written by the boot-health shell layer.
 * Malformed lines are skipped defensively; a missing log reads as empty.
 */
export async function readRollbackHistory(
  stateDirectory: string,
): Promise<RollbackRecord[]> {
  let raw: string;
  try {
    raw = await readFile(
      join(updatesDir(stateDirectory), ROLLBACK_HISTORY_FILE_NAME),
      "utf8",
    );
  } catch {
    return [];
  }
  const records: RollbackRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRollbackRecord(parsed)) records.push(parsed);
    } catch {
      // Skip malformed lines; the log is append-only and must stay readable.
    }
  }
  return records;
}

/** The most recent rollback event, if any. */
export async function lastRollback(
  stateDirectory: string,
): Promise<RollbackRecord | undefined> {
  const history = await readRollbackHistory(stateDirectory);
  return history.length === 0 ? undefined : history[history.length - 1];
}
