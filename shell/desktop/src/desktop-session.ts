/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Desktop session lifecycle: login, lock/unlock verification, switch-user,
 * logout, and ephemeral guest sessions, backed by the @sevynos/accounts
 * AccountService.
 *
 * Session states:
 * - No accounts configured: the legacy single-user live session. The session
 *   is always "active" with no current user, and unlocking never requires a
 *   password — exactly today's behavior.
 * - Accounts configured, no active session: the login screen. `loginRequired`
 *   is true and the shell renders the lock screen in login mode (account
 *   picker + guest entry).
 * - Accounts configured, session active: normal locked/unlocked operation.
 *   Unlocking verifies the current user's password (rate-limited by the
 *   accounts service); switching users or logging out closes all windows and
 *   returns to the login screen.
 *
 * Guest sessions are ephemeral: the "guest" account is never written to the
 * registry, and its home directory is wiped on logout.
 */

import { rm } from "node:fs/promises";
import {
  AccountService,
  type PasswordVerification,
  type UserAccount,
} from "@sevynos/accounts";

export interface SessionUser {
  readonly username: string;
  readonly fullName: string;
  readonly uid: number | undefined;
  readonly guest: boolean;
}

export type UnlockFailureReason = "invalid-credentials" | "locked-out";

export interface UnlockAttemptResult {
  readonly ok: boolean;
  readonly reason?: UnlockFailureReason | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface DesktopSessionCallbacks {
  readonly lock: () => void;
  readonly unlock: () => void;
  readonly closeAllWindows: () => Promise<void>;
  readonly notify: () => void;
}

export const GUEST_USERNAME = "guest";

function toUnlockResult(verification: PasswordVerification): UnlockAttemptResult {
  if (verification.ok) return Object.freeze({ ok: true as const });
  if (verification.lockedOut) {
    return Object.freeze({
      ok: false as const,
      reason: "locked-out" as const,
      retryAfterMs: verification.retryAfterMs,
    });
  }
  return Object.freeze({ ok: false as const, reason: "invalid-credentials" as const });
}

function sessionUserFromAccount(account: UserAccount): SessionUser {
  return Object.freeze({
    username: account.username,
    fullName: account.fullName,
    uid: account.uid,
    guest: false,
  });
}

export class DesktopSessionManager {
  readonly #accounts: AccountService;
  readonly #callbacks: DesktopSessionCallbacks;
  #currentUser: SessionUser | undefined;
  #sessionActive = false;
  #accountsError: string | undefined;

  public constructor(accounts: AccountService, callbacks: DesktopSessionCallbacks) {
    this.#accounts = accounts;
    this.#callbacks = callbacks;
  }

  /** Loads the account store. Never throws: a broken store degrades to "no accounts". */
  public async init(): Promise<void> {
    try {
      await this.#accounts.init();
    } catch (error) {
      this.#accountsError = error instanceof Error ? error.message : String(error);
      console.error(`[session] account store unavailable: ${this.#accountsError}`);
    }
    if (!this.hasAccounts()) {
      // Legacy single-user live session: active immediately, no login.
      this.#sessionActive = true;
    }
  }

  public get accounts(): AccountService {
    return this.#accounts;
  }

  public get accountsError(): string | undefined {
    return this.#accountsError;
  }

  public get currentUser(): SessionUser | undefined {
    return this.#currentUser;
  }

  public get sessionActive(): boolean {
    return this.#sessionActive;
  }

  public get isGuestSession(): boolean {
    return this.#currentUser?.guest === true;
  }

  public hasAccounts(): boolean {
    if (this.#accountsError !== undefined) return false;
    try {
      return this.#accounts.hasAccounts();
    } catch {
      return false;
    }
  }

  /** True when accounts exist but nobody is logged in: show the login screen. */
  public get loginRequired(): boolean {
    return this.hasAccounts() && !this.#sessionActive;
  }

  /** Account summaries for the login screen picker. Empty when no login is required. */
  public loginUsers(): readonly { username: string; fullName: string }[] {
    if (!this.loginRequired) return Object.freeze([]);
    try {
      return Object.freeze(
        this.#accounts
          .listUsers()
          .map((user) =>
            Object.freeze({ username: user.username, fullName: user.fullName }),
          ),
      );
    } catch {
      return Object.freeze([]);
    }
  }

  /**
   * Verifies a password to unlock the current session. With no accounts
   * configured this always succeeds (legacy live-session behavior). In login
   * mode (accounts exist, no session) it always fails — use login() instead.
   */
  public async verifyUnlock(password: string): Promise<UnlockAttemptResult> {
    if (!this.hasAccounts()) {
      return Object.freeze({ ok: true as const });
    }
    const user = this.#currentUser;
    if (!this.#sessionActive || user === undefined) {
      return Object.freeze({
        ok: false as const,
        reason: "invalid-credentials" as const,
      });
    }
    if (user.guest) {
      // Guest sessions have no password; unlocking one is always allowed.
      return Object.freeze({ ok: true as const });
    }
    const verification = await this.#accounts.verifyPassword(user.username, password);
    return toUnlockResult(verification);
  }

  /**
   * Authenticates a user from the login screen and starts their session.
   * Rate-limited by the accounts service.
   */
  public async login(username: string, password: string): Promise<UnlockAttemptResult> {
    const verification = await this.#accounts.verifyPassword(username, password);
    const result = toUnlockResult(verification);
    if (!result.ok) return result;
    const account = this.#accounts.getUser(username);
    if (account === undefined) {
      return Object.freeze({
        ok: false as const,
        reason: "invalid-credentials" as const,
      });
    }
    this.#currentUser = sessionUserFromAccount(account);
    this.#sessionActive = true;
    await this.#accounts.ensureHomeDirectory(username);
    this.#callbacks.unlock();
    this.#callbacks.notify();
    return result;
  }

  /** Ends the current session (if any) and returns to the login screen. */
  public beginLogin(): void {
    this.#currentUser = undefined;
    this.#sessionActive = false;
    this.#callbacks.lock();
    this.#callbacks.notify();
  }

  /**
   * Temporarily unlocks for first-run setup (the setup wizard runs as a
   * normal window and cannot work behind the lock screen). Callers must
   * return to the login screen via beginLogin() afterwards when appropriate.
   */
  public unlockForSetup(): void {
    if (this.loginRequired) {
      this.#callbacks.unlock();
      this.#callbacks.notify();
    }
  }

  /** Switch-user flow: closes every window, then returns to the login screen. */
  public async switchUser(): Promise<void> {
    await this.#callbacks.closeAllWindows();
    this.beginLogin();
  }

  /**
   * Logout: like switch-user, but also wipes the ephemeral guest home
   * directory when the current session is a guest session.
   */
  public async logout(): Promise<void> {
    if (this.#currentUser?.guest === true) {
      await this.#wipeGuestData();
    }
    await this.switchUser();
  }

  /** Starts an ephemeral guest session (never persisted to the registry). */
  public async startGuestSession(): Promise<void> {
    this.#currentUser = Object.freeze({
      username: GUEST_USERNAME,
      fullName: "Guest",
      uid: undefined,
      guest: true,
    });
    this.#sessionActive = true;
    await this.#accounts.ensureHomeDirectory(GUEST_USERNAME);
    this.#callbacks.unlock();
    this.#callbacks.notify();
  }

  async #wipeGuestData(): Promise<void> {
    try {
      await rm(this.#accounts.homeDirectoryFor(GUEST_USERNAME), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.error(
        `[session] failed to wipe guest data: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
