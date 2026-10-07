/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Canonical on-disk locations for SevynOS user accounts.
 *
 * This is the persistent store contract shared with the installer workstream
 * (which creates the initial user): the layout below is the source of truth
 * and must not change without coordinating with the installer.
 *
 * - `<baseDir>/registry.json` — the user list. Public fields only:
 *   username, uid, fullName, createdAt. NEVER secrets.
 * - `<baseDir>/shadow.json` — mode 0600. Maps username -> password hash
 *   record (algorithm, KDF params, salt, hash).
 *
 * Defaults: baseDir `/var/lib/sevyn/accounts`, usersDir `/var/lib/sevyn/users`.
 * Both are overridable via `SEVYN_ACCOUNTS_DIR` / `SEVYN_USERS_DIR` (used by
 * tests and by the desktop runtime, which points the service at the host
 * user-data root so account homes and the app filesystem agree).
 */

import { join } from "node:path";

export const DEFAULT_ACCOUNTS_BASE_DIR = "/var/lib/sevyn/accounts";
export const DEFAULT_USERS_BASE_DIR = "/var/lib/sevyn/users";

export const REGISTRY_FILENAME = "registry.json";
export const SHADOW_FILENAME = "shadow.json";

export function accountsBaseDir(override?: string): string {
  return override ?? process.env["SEVYN_ACCOUNTS_DIR"] ?? DEFAULT_ACCOUNTS_BASE_DIR;
}

export function usersBaseDir(override?: string): string {
  return override ?? process.env["SEVYN_USERS_DIR"] ?? DEFAULT_USERS_BASE_DIR;
}

export function registryFilePath(baseDir?: string): string {
  return join(accountsBaseDir(baseDir), REGISTRY_FILENAME);
}

export function shadowFilePath(baseDir?: string): string {
  return join(accountsBaseDir(baseDir), SHADOW_FILENAME);
}

/**
 * Canonical home directory for a user. The accounts service provisions this
 * directory (with the standard Desktop/Documents/Downloads/Pictures/Music/
 * Videos subdirectories) when a user is created.
 */
export function homeDirectoryFor(username: string, baseDir?: string): string {
  return join(usersBaseDir(baseDir), username);
}
