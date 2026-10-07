/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SevynOS user account service: user CRUD, scrypt password hashing, and
 * rate-limited password verification backed by the on-disk store contract
 * documented in ./account-paths.ts.
 *
 * Design notes:
 * - The service is pure TypeScript over an `AccountStore` interface, so unit
 *   tests run against `InMemoryAccountStore` with zero filesystem access.
 * - `FileAccountStore` is the production store: registry.json (public user
 *   list, never secrets) and shadow.json (mode 0600, username -> hash).
 * - Passwords are hashed with scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte
 *   salt) and compared with `timingSafeEqual`. Unknown usernames still cost a
 *   full KDF evaluation so verification timing does not leak account existence.
 * - Verification is rate-limited per username: 5 failures inside a 10-minute
 *   window locks the account name out for 60 seconds, doubling on each
 *   subsequent lockout (capped at 10 minutes). Successful verification resets
 *   the counter. This is the backend enforcement behind the lock screen;
 *   any client-side attempt counting is UX only and must not be trusted.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  accountsBaseDir,
  homeDirectoryFor,
  registryFilePath,
  shadowFilePath,
  usersBaseDir,
} from "./account-paths.js";

/** Public user record. Stored in registry.json — never carries secrets. */
export interface UserAccount {
  readonly username: string;
  readonly uid: number;
  readonly fullName: string;
  readonly createdAt: number;
}

export interface CreateUserInput {
  readonly username: string;
  readonly password: string;
  readonly fullName?: string | undefined;
}

export interface PasswordHashRecord {
  readonly algorithm: "scrypt";
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly saltBase64: string;
  readonly hashBase64: string;
  readonly updatedAt: number;
}

export interface RegistryFile {
  readonly version: 1;
  readonly users: readonly UserAccount[];
}

export interface ShadowFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, PasswordHashRecord>>;
}

export type PasswordVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly lockedOut: boolean;
      readonly retryAfterMs?: number | undefined;
    };

export type AccountErrorCode =
  | "account-exists"
  | "account-not-found"
  | "invalid-username"
  | "weak-password"
  | "store-error";

export class AccountError extends Error {
  public readonly code: AccountErrorCode;
  public constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

/**
 * Storage backend for the account registry and shadow files, plus home
 * directory provisioning. Implementations must keep secrets out of the
 * registry and restrict the shadow file to owner-only access.
 */
export interface AccountStore {
  loadRegistry(): Promise<RegistryFile>;
  saveRegistry(registry: RegistryFile): Promise<void>;
  loadShadow(): Promise<ShadowFile>;
  saveShadow(shadow: ShadowFile): Promise<void>;
  homeDirectoryFor(username: string): string;
  ensureHomeDirectory(username: string): Promise<void>;
  removeHomeDirectory(username: string): Promise<void>;
}

export interface FileAccountStoreOptions {
  readonly baseDir?: string | undefined;
  readonly usersDir?: string | undefined;
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

const STANDARD_HOME_SUBDIRS: readonly string[] = Object.freeze([
  "Desktop",
  "Documents",
  "Downloads",
  "Pictures",
  "Music",
  "Videos",
]);

/** Production store: JSON files under /var/lib/sevyn/accounts (see contract). */
export class FileAccountStore implements AccountStore {
  readonly #baseDir: string;
  readonly #usersDir: string;

  public constructor(options: FileAccountStoreOptions = {}) {
    this.#baseDir = accountsBaseDir(options.baseDir);
    this.#usersDir = usersBaseDir(options.usersDir);
  }

  public get baseDir(): string {
    return this.#baseDir;
  }

  public get usersDir(): string {
    return this.#usersDir;
  }

  public async loadRegistry(): Promise<RegistryFile> {
    try {
      const raw = await readFile(registryFilePath(this.#baseDir), "utf8");
      return parseRegistryFile(raw);
    } catch (error) {
      if (isCode(error, "ENOENT")) return { version: 1, users: [] };
      throw new AccountError(
        "store-error",
        `Failed to read the account registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async saveRegistry(registry: RegistryFile): Promise<void> {
    try {
      await mkdir(this.#baseDir, { recursive: true });
      await writeFile(
        registryFilePath(this.#baseDir),
        JSON.stringify(registry, null, 2),
        {
          mode: 0o644,
        },
      );
    } catch (error) {
      throw new AccountError(
        "store-error",
        `Failed to write the account registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async loadShadow(): Promise<ShadowFile> {
    try {
      const raw = await readFile(shadowFilePath(this.#baseDir), "utf8");
      return parseShadowFile(raw);
    } catch (error) {
      if (isCode(error, "ENOENT")) return { version: 1, entries: {} };
      throw new AccountError(
        "store-error",
        `Failed to read the account shadow file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async saveShadow(shadow: ShadowFile): Promise<void> {
    const path = shadowFilePath(this.#baseDir);
    try {
      await mkdir(this.#baseDir, { recursive: true });
      await writeFile(path, JSON.stringify(shadow, null, 2), { mode: 0o600 });
      // writeFile only applies `mode` when creating the file; enforce 0600
      // on every save so a pre-existing shadow file can never stay world-readable.
      await chmod(path, 0o600);
    } catch (error) {
      throw new AccountError(
        "store-error",
        `Failed to write the account shadow file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public homeDirectoryFor(username: string): string {
    return homeDirectoryFor(username, this.#usersDir);
  }

  public async ensureHomeDirectory(username: string): Promise<void> {
    const home = this.homeDirectoryFor(username);
    await mkdir(home, { recursive: true });
    for (const subdir of STANDARD_HOME_SUBDIRS) {
      await mkdir(join(home, subdir), { recursive: true });
    }
  }

  public async removeHomeDirectory(username: string): Promise<void> {
    await rm(this.homeDirectoryFor(username), { recursive: true, force: true });
  }
}

/** In-memory store for unit tests (and other workstreams' tests). */
export class InMemoryAccountStore implements AccountStore {
  #registry: RegistryFile = { version: 1, users: [] };
  #shadow: ShadowFile = { version: 1, entries: {} };
  readonly #usersDir: string;

  public constructor(usersDir = "/tmp/sevynos-test-users") {
    this.#usersDir = usersDir;
  }

  public loadRegistry(): Promise<RegistryFile> {
    return Promise.resolve(this.#registry);
  }

  public saveRegistry(registry: RegistryFile): Promise<void> {
    this.#registry = registry;
    return Promise.resolve();
  }

  public loadShadow(): Promise<ShadowFile> {
    return Promise.resolve(this.#shadow);
  }

  public saveShadow(shadow: ShadowFile): Promise<void> {
    this.#shadow = shadow;
    return Promise.resolve();
  }

  public homeDirectoryFor(username: string): string {
    return homeDirectoryFor(username, this.#usersDir);
  }

  public ensureHomeDirectory(): Promise<void> {
    // No-op: in-memory store has no home directories.
    return Promise.resolve();
  }

  public removeHomeDirectory(): Promise<void> {
    // No-op: in-memory store has no home directories.
    return Promise.resolve();
  }
}

function parseRegistryFile(raw: string): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AccountError("store-error", "The account registry is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { users?: unknown }).users)
  ) {
    throw new AccountError(
      "store-error",
      "The account registry has an unexpected shape.",
    );
  }
  const users = (parsed as { users: unknown[] }).users.map((entry) => {
    const record = entry as Partial<UserAccount>;
    if (typeof record.username !== "string" || typeof record.uid !== "number") {
      throw new AccountError(
        "store-error",
        "The account registry contains a malformed user entry.",
      );
    }
    return Object.freeze({
      username: record.username,
      uid: record.uid,
      fullName: typeof record.fullName === "string" ? record.fullName : "",
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    });
  });
  return Object.freeze({ version: 1 as const, users: Object.freeze(users) });
}

function parseShadowFile(raw: string): ShadowFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AccountError("store-error", "The account shadow file is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { entries?: unknown }).entries !== "object" ||
    (parsed as { entries?: unknown }).entries === null
  ) {
    throw new AccountError(
      "store-error",
      "The account shadow file has an unexpected shape.",
    );
  }
  const entries: Record<string, PasswordHashRecord> = {};
  for (const [username, value] of Object.entries(
    (parsed as { entries: Record<string, unknown> }).entries,
  )) {
    const record = value as Partial<PasswordHashRecord>;
    if (
      record.algorithm !== "scrypt" ||
      typeof record.saltBase64 !== "string" ||
      typeof record.hashBase64 !== "string"
    ) {
      throw new AccountError(
        "store-error",
        `The shadow entry for "${username}" is malformed.`,
      );
    }
    entries[username] = Object.freeze({
      algorithm: "scrypt" as const,
      n: typeof record.n === "number" ? record.n : SCRYPT_N,
      r: typeof record.r === "number" ? record.r : SCRYPT_R,
      p: typeof record.p === "number" ? record.p : SCRYPT_P,
      saltBase64: record.saltBase64,
      hashBase64: record.hashBase64,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    });
  }
  return Object.freeze({ version: 1 as const, entries: Object.freeze(entries) });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
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

/**
 * Returns a human-readable validation error for a username, or undefined when
 * the username is acceptable. Rules mirror POSIX login-name conventions.
 */
export function validateUsername(username: string): string | undefined {
  if (username.length === 0) return "Enter a username.";
  if (username.length > 32) return "Usernames are at most 32 characters.";
  if (!USERNAME_PATTERN.test(username)) {
    return "Use lowercase letters, digits, _ or -, starting with a letter or _.";
  }
  if (RESERVED_USERNAMES.has(username)) {
    return `"${username}" is reserved — pick another username.`;
  }
  return undefined;
}

/**
 * Returns a human-readable validation error for a password, or undefined when
 * the password is acceptable. Length is the requirement; complexity theater
 * (mandatory symbol soup) is deliberately not enforced.
 */
export function validatePassword(password: string): string | undefined {
  if (password.length < 8) return "Passwords need at least 8 characters.";
  if (password.length > 256) return "Passwords are at most 256 characters.";
  return undefined;
}

function scryptHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

async function hashPassword(
  password: string,
  now: () => number,
): Promise<PasswordHashRecord> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptHash(password, salt);
  return Object.freeze({
    algorithm: "scrypt" as const,
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    saltBase64: salt.toString("base64"),
    hashBase64: hash.toString("base64"),
    updatedAt: now(),
  });
}

async function verifyHash(
  password: string,
  record: PasswordHashRecord,
): Promise<boolean> {
  const salt = Buffer.from(record.saltBase64, "base64");
  const expected = Buffer.from(record.hashBase64, "base64");
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      expected.length,
      { N: record.n, r: record.r, p: record.p },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

interface AttemptState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  lockoutCount: number;
}

const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const BASE_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 10 * 60 * 1000;
const FIRST_UID = 1000;

export interface AccountServiceOptions {
  readonly store?: AccountStore | undefined;
  readonly now?: (() => number) | undefined;
}

export class AccountService {
  readonly #store: AccountStore;
  readonly #now: () => number;
  readonly #attempts = new Map<string, AttemptState>();
  #initialized = false;
  #users: UserAccount[] = [];
  #shadow: Record<string, PasswordHashRecord> = {};

  public constructor(options: AccountServiceOptions = {}) {
    this.#store = options.store ?? new FileAccountStore();
    this.#now = options.now ?? (() => Date.now());
  }

  /** Loads the registry and shadow files. Safe to call when no accounts exist yet. */
  public async init(): Promise<void> {
    const [registry, shadow] = await Promise.all([
      this.#store.loadRegistry(),
      this.#store.loadShadow(),
    ]);
    this.#users = [...registry.users];
    this.#shadow = { ...shadow.entries };
    this.#initialized = true;
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new AccountError("store-error", "AccountService.init() has not been called.");
    }
  }

  public listUsers(): readonly UserAccount[] {
    this.#requireInitialized();
    return Object.freeze([...this.#users]);
  }

  public getUser(username: string): UserAccount | undefined {
    this.#requireInitialized();
    return this.#users.find((user) => user.username === username);
  }

  public hasAccounts(): boolean {
    this.#requireInitialized();
    return this.#users.length > 0;
  }

  public homeDirectoryFor(username: string): string {
    return this.#store.homeDirectoryFor(username);
  }

  /**
   * Best-effort home directory provisioning, used at login for users whose
   * records were created outside this service (e.g. by the installer).
   * Never throws: a provisioning failure is logged and the login proceeds.
   */
  public async ensureHomeDirectory(username: string): Promise<void> {
    this.#requireInitialized();
    try {
      await this.#store.ensureHomeDirectory(username);
    } catch (error) {
      console.warn(
        `[accounts] failed to provision home directory for "${username}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  public async createUser(input: CreateUserInput): Promise<UserAccount> {
    this.#requireInitialized();
    const usernameError = validateUsername(input.username);
    if (usernameError !== undefined) {
      throw new AccountError("invalid-username", usernameError);
    }
    const passwordError = validatePassword(input.password);
    if (passwordError !== undefined) {
      throw new AccountError("weak-password", passwordError);
    }
    if (this.getUser(input.username) !== undefined) {
      throw new AccountError(
        "account-exists",
        `An account named "${input.username}" already exists.`,
      );
    }
    const uid =
      this.#users.reduce((max, user) => Math.max(max, user.uid), FIRST_UID - 1) + 1;
    const record: UserAccount = Object.freeze({
      username: input.username,
      uid,
      fullName: input.fullName?.trim() ?? "",
      createdAt: this.#now(),
    });
    const hash = await hashPassword(input.password, this.#now);
    this.#users.push(record);
    this.#shadow[input.username] = hash;
    await this.#persist();
    await this.#store.ensureHomeDirectory(input.username);
    return record;
  }

  public async deleteUser(username: string): Promise<void> {
    this.#requireInitialized();
    const index = this.#users.findIndex((user) => user.username === username);
    if (index === -1) {
      throw new AccountError("account-not-found", `No account named "${username}".`);
    }
    this.#users.splice(index, 1);
    this.#shadow = Object.fromEntries(
      Object.entries(this.#shadow).filter(([name]) => name !== username),
    );
    this.#attempts.delete(username);
    await this.#persist();
    await this.#store.removeHomeDirectory(username);
  }

  public async setPassword(username: string, newPassword: string): Promise<void> {
    this.#requireInitialized();
    if (this.getUser(username) === undefined) {
      throw new AccountError("account-not-found", `No account named "${username}".`);
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError !== undefined) {
      throw new AccountError("weak-password", passwordError);
    }
    this.#shadow[username] = await hashPassword(newPassword, this.#now);
    this.#attempts.delete(username);
    await this.#persist();
  }

  /**
   * Verifies a password with per-username rate limiting. Never throws for a
   * wrong password — that is an expected outcome. Unknown usernames cost a
   * full KDF evaluation and are rate-limited like real ones so verification
   * timing does not leak account existence.
   */
  public async verifyPassword(
    username: string,
    password: string,
  ): Promise<PasswordVerification> {
    this.#requireInitialized();
    const now = this.#now();
    const state = this.#attempts.get(username);
    if (state !== undefined && state.lockedUntil > now) {
      return Object.freeze({
        ok: false as const,
        lockedOut: true,
        retryAfterMs: state.lockedUntil - now,
      });
    }
    const record = this.#shadow[username];
    const ok =
      record !== undefined
        ? await verifyHash(password, record)
        : await verifyHash(password, DUMMY_HASH_RECORD);
    if (ok && record !== undefined) {
      this.#attempts.delete(username);
      return Object.freeze({ ok: true as const });
    }
    this.#recordFailure(username, now);
    const next = this.#attempts.get(username);
    if (next !== undefined && next.lockedUntil > now) {
      return Object.freeze({
        ok: false as const,
        lockedOut: true,
        retryAfterMs: next.lockedUntil - now,
      });
    }
    return Object.freeze({ ok: false as const, lockedOut: false });
  }

  #recordFailure(username: string, now: number): void {
    let state = this.#attempts.get(username);
    if (state === undefined || now - state.windowStart > ATTEMPT_WINDOW_MS) {
      state = { failures: 0, windowStart: now, lockedUntil: 0, lockoutCount: 0 };
    }
    state.failures += 1;
    if (state.failures >= MAX_ATTEMPTS) {
      const lockoutMs = Math.min(
        BASE_LOCKOUT_MS * 2 ** state.lockoutCount,
        MAX_LOCKOUT_MS,
      );
      state.lockedUntil = now + lockoutMs;
      state.lockoutCount += 1;
      state.failures = 0;
      state.windowStart = now;
    }
    this.#attempts.set(username, state);
  }

  async #persist(): Promise<void> {
    await this.#store.saveRegistry(
      Object.freeze({ version: 1 as const, users: Object.freeze([...this.#users]) }),
    );
    await this.#store.saveShadow(
      Object.freeze({ version: 1 as const, entries: Object.freeze({ ...this.#shadow }) }),
    );
  }
}

/**
 * Fixed dummy hash used to verify passwords for unknown usernames so the KDF
 * cost (and therefore timing) matches a real verification.
 */
const DUMMY_HASH_RECORD: PasswordHashRecord = Object.freeze({
  algorithm: "scrypt" as const,
  n: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  saltBase64: Buffer.alloc(SALT_BYTES, 0x5a).toString("base64"),
  hashBase64: Buffer.alloc(SCRYPT_KEYLEN, 0xa5).toString("base64"),
  updatedAt: 0,
});
