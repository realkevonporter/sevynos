/**
 * SevynOS installer — account file creation.
 *
 * Writes the two files that form the SevynOS accounts contract, owned by the
 * accounts workstream (services/accounts). This module MUST match that
 * contract exactly:
 *   /var/lib/sevyn/accounts/registry.json — { version: 1, users: [
 *     { username, uid, fullName, createdAt } ] }. No secrets, ever. Mode 0644.
 *   /var/lib/sevyn/accounts/shadow.json — { version: 1, entries: {
 *     username: { algorithm, n, r, p, saltBase64, hashBase64, updatedAt } } }.
 *     Mode 0600.
 *   Home directories live at /var/lib/sevyn/users/<username>.
 *
 * Password hashing: scrypt N=16384, r=8, p=1, 64-byte key, 16-byte salt —
 * the exact parameters services/accounts uses, so the lock screen can verify
 * installer-created passwords with no migration step.
 *
 * Pure functions are unit-tested; the tiny CLI at the bottom is what the
 * shell installer calls inside the chroot.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PASSWORD_ALGORITHM = "scrypt";
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_HASH_BYTES = 64;

export const REGISTRY_VERSION = 1;
export const SHADOW_VERSION = 1;

/** Reserved login names — mirrors services/accounts validateUsername. */
export const RESERVED_USERNAMES = Object.freeze([
  "root",
  "admin",
  "administrator",
  "guest",
  "system",
  "sevyn",
  "daemon",
  "bin",
  "sys",
  "nobody",
  "operator",
  "superuser",
]);

export const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Validate a username with the same rules as the accounts service.
 * @param {string} username
 * @returns {string|undefined} human-readable error, or undefined when valid
 */
export function validateAccountUsername(username) {
  const value = String(username ?? "");
  if (value.length === 0) return "Enter a username.";
  if (value.length > 32) return "Usernames are at most 32 characters.";
  if (!USERNAME_PATTERN.test(value)) {
    return "Use lowercase letters, digits, _ or -, starting with a letter or _.";
  }
  if (RESERVED_USERNAMES.includes(value)) {
    return `"${value}" is reserved — pick another username.`;
  }
  return undefined;
}

/**
 * Validate a password with the same rules as the accounts service.
 * @param {string} password
 * @returns {string|undefined} human-readable error, or undefined when valid
 */
export function validateAccountPassword(password) {
  const value = String(password ?? "");
  if (value.length < 8) return "Passwords need at least 8 characters.";
  if (value.length > 256) return "Passwords are at most 256 characters.";
  return undefined;
}

/**
 * @param {string} password
 * @param {string} [saltB64] base64 salt (generated when omitted)
 * @returns {{algorithm: string, n: number, r: number, p: number,
 *            saltBase64: string, hashBase64: string, updatedAt: number}}
 */
export function hashPassword(password, saltB64) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string.");
  }
  const salt = saltB64
    ? Buffer.from(saltB64, "base64")
    : randomBytes(PASSWORD_SALT_BYTES);
  if (salt.length < PASSWORD_SALT_BYTES) {
    throw new Error("Salt must be at least 16 bytes.");
  }
  const derived = scryptSync(password, salt, PASSWORD_HASH_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return {
    algorithm: PASSWORD_ALGORITHM,
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    saltBase64: salt.toString("base64"),
    hashBase64: derived.toString("base64"),
    updatedAt: Date.now(),
  };
}

/**
 * Constant-time password verification against a shadow record.
 * @param {string} password
 * @param {{algorithm?: string, n?: number, r?: number, p?: number,
 *          saltBase64?: string, hashBase64?: string}} record
 */
export function verifyPassword(password, record) {
  if (
    !record ||
    record.algorithm !== PASSWORD_ALGORITHM ||
    typeof record.saltBase64 !== "string" ||
    typeof record.hashBase64 !== "string"
  ) {
    return false;
  }
  const salt = Buffer.from(record.saltBase64, "base64");
  const expected = Buffer.from(record.hashBase64, "base64");
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: typeof record.n === "number" ? record.n : SCRYPT_N,
      r: typeof record.r === "number" ? record.r : SCRYPT_R,
      p: typeof record.p === "number" ? record.p : SCRYPT_P,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * @param {{username: string, uid: number, fullName?: string, createdAt?: number}} user
 */
export function buildUserRecord({ username, uid, fullName, createdAt }) {
  const usernameError = validateAccountUsername(username);
  if (usernameError) throw new Error(`Invalid username: ${usernameError}`);
  if (!Number.isInteger(uid) || uid < 1000)
    throw new Error("uid must be an integer >= 1000.");
  return {
    username,
    uid,
    fullName: typeof fullName === "string" ? fullName : "",
    createdAt:
      typeof createdAt === "number" && Number.isFinite(createdAt)
        ? Math.floor(createdAt)
        : Date.now(),
  };
}

/**
 * @param {Array<{username: string, uid: number, fullName?: string, createdAt?: number}>} users
 */
export function buildRegistry(users) {
  const seen = new Set();
  const records = users.map((user) => {
    const record = buildUserRecord(user);
    if (seen.has(record.username))
      throw new Error(`Duplicate user in registry: ${record.username}`);
    seen.add(record.username);
    return record;
  });
  return JSON.stringify({ version: REGISTRY_VERSION, users: records }, null, 2) + "\n";
}

/**
 * @param {Array<{username: string, password: string}>} entries
 */
export function buildShadow(entries) {
  const records = {};
  for (const { username, password } of entries) {
    const usernameError = validateAccountUsername(username);
    if (usernameError) throw new Error(`Invalid username: ${usernameError}`);
    if (records[username] !== undefined)
      throw new Error(`Duplicate user in shadow: ${username}`);
    const passwordError = validateAccountPassword(password);
    if (passwordError) throw new Error(`Invalid password: ${passwordError}`);
    records[username] = hashPassword(password);
  }
  return JSON.stringify({ version: SHADOW_VERSION, entries: records }, null, 2) + "\n";
}

/**
 * Write registry.json (0644) and shadow.json (0600) for one new user.
 * Password is read from stdin so it never appears in the process list.
 */
function makeUser({ username, uid, fullName, createdAt, registryPath, shadowPath }) {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const password = chunks.join("").replace(/[\r\n]+$/, "");
    try {
      const registry = buildRegistry([{ username, uid, fullName, createdAt }]);
      const shadow = buildShadow([{ username, password }]);
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o755 });
      writeFileSync(registryPath, registry, { mode: 0o644 });
      writeFileSync(shadowPath, shadow, { mode: 0o600 });
    } catch (error) {
      process.stderr.write(
        `Failed to write account files: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`created user ${username} (uid ${uid})\n`);
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === "make-user") {
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const username = get("--username");
  const uid = Number(get("--uid") ?? "1000");
  if (!username) {
    process.stderr.write("make-user requires --username\n");
    process.exit(2);
  }
  const createdRaw = get("--created-at");
  makeUser({
    username,
    uid,
    fullName: get("--full-name") ?? "",
    createdAt: createdRaw !== undefined ? Number(createdRaw) : undefined,
    registryPath: get("--registry") ?? "/var/lib/sevyn/accounts/registry.json",
    shadowPath: get("--shadow") ?? "/var/lib/sevyn/accounts/shadow.json",
  });
} else if (command !== undefined) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(2);
}
