/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it, vi } from "vitest";
import { AccountService, InMemoryAccountStore } from "@sevynos/accounts";
import {
  DesktopSessionManager,
  GUEST_USERNAME,
  type DesktopSessionCallbacks,
} from "./desktop-session.js";

function createCallbacks(): DesktopSessionCallbacks & {
  lock: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  closeAllWindows: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  return {
    lock: vi.fn(),
    unlock: vi.fn(),
    closeAllWindows: vi.fn(() => Promise.resolve(undefined)),
    notify: vi.fn(),
  };
}

async function createServiceWithUser(
  username = "kevon",
  password = "correct horse battery staple",
): Promise<AccountService> {
  const service = new AccountService({ store: new InMemoryAccountStore() });
  await service.init();
  await service.createUser({ username, password, fullName: "Kevon" });
  return service;
}

describe("DesktopSessionManager without accounts", () => {
  it("behaves like the legacy single-user live session", async () => {
    const service = new AccountService({ store: new InMemoryAccountStore() });
    const callbacks = createCallbacks();
    const session = new DesktopSessionManager(service, callbacks);
    await session.init();

    expect(session.sessionActive).toBe(true);
    expect(session.loginRequired).toBe(false);
    expect(session.currentUser).toBeUndefined();
    expect(session.loginUsers()).toHaveLength(0);
    // Unlocking never requires a password when no accounts exist.
    await expect(session.verifyUnlock("anything")).resolves.toMatchObject({ ok: true });
    expect(callbacks.lock).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the account store is broken", async () => {
    const broken = {
      loadRegistry: () => Promise.reject(new Error("disk on fire")),
      loadShadow: () => Promise.resolve({ version: 1 as const, entries: {} }),
      saveRegistry: () => Promise.resolve(undefined),
      saveShadow: () => Promise.resolve(undefined),
      homeDirectoryFor: (username: string) => `/tmp/${username}`,
      ensureHomeDirectory: () => Promise.resolve(undefined),
      removeHomeDirectory: () => Promise.resolve(undefined),
    };
    const service = new AccountService({ store: broken });
    const session = new DesktopSessionManager(service, createCallbacks());
    await session.init();

    expect(session.accountsError).toContain("disk on fire");
    expect(session.loginRequired).toBe(false);
    await expect(session.verifyUnlock("anything")).resolves.toMatchObject({ ok: true });
  });
});

describe("DesktopSessionManager login flow", () => {
  it("logs in with the right password and rejects the wrong one", async () => {
    const service = await createServiceWithUser();
    const callbacks = createCallbacks();
    const session = new DesktopSessionManager(service, callbacks);
    await session.init();

    expect(session.loginRequired).toBe(true);
    expect(session.loginUsers()).toMatchObject([
      { username: "kevon", fullName: "Kevon" },
    ]);

    await expect(session.login("kevon", "wrong password here!!")).resolves.toMatchObject({
      ok: false,
      reason: "invalid-credentials",
    });
    expect(session.sessionActive).toBe(false);

    await expect(
      session.login("kevon", "correct horse battery staple"),
    ).resolves.toMatchObject({ ok: true });
    expect(session.sessionActive).toBe(true);
    expect(session.currentUser).toMatchObject({ username: "kevon", guest: false });
    expect(session.loginRequired).toBe(false);
    expect(callbacks.unlock).toHaveBeenCalled();
  });

  it("verifies the unlock password for the active session, rate-limited", async () => {
    const service = await createServiceWithUser();
    const callbacks = createCallbacks();
    const session = new DesktopSessionManager(service, callbacks);
    await session.init();
    await session.login("kevon", "correct horse battery staple");

    await expect(
      session.verifyUnlock("correct horse battery staple"),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(session.verifyUnlock("wrong password here!!")).resolves.toMatchObject({
      ok: false,
      reason: "invalid-credentials",
    });
    // Five consecutive failures trip the backend lockout.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await session.verifyUnlock("wrong password here!!");
    }
    await expect(session.verifyUnlock("wrong password here!!")).resolves.toMatchObject({
      ok: false,
      reason: "locked-out",
    });
  });

  it("refuses verifyUnlock in login mode (no active session)", async () => {
    const service = await createServiceWithUser();
    const session = new DesktopSessionManager(service, createCallbacks());
    await session.init();

    await expect(
      session.verifyUnlock("correct horse battery staple"),
    ).resolves.toMatchObject({ ok: false, reason: "invalid-credentials" });
  });
});

describe("DesktopSessionManager switch-user and logout", () => {
  it("switchUser closes windows and returns to the login screen", async () => {
    const service = await createServiceWithUser();
    const callbacks = createCallbacks();
    const session = new DesktopSessionManager(service, callbacks);
    await session.init();
    await session.login("kevon", "correct horse battery staple");

    await session.switchUser();
    expect(callbacks.closeAllWindows).toHaveBeenCalledTimes(1);
    expect(callbacks.lock).toHaveBeenCalled();
    expect(session.sessionActive).toBe(false);
    expect(session.currentUser).toBeUndefined();
    expect(session.loginRequired).toBe(true);
  });

  it("supports back-to-back logins for different users", async () => {
    const service = new AccountService({ store: new InMemoryAccountStore() });
    await service.init();
    await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
    });
    await service.createUser({ username: "ada", password: "another strong passphrase" });
    const session = new DesktopSessionManager(service, createCallbacks());
    await session.init();

    await session.login("kevon", "correct horse battery staple");
    expect(session.currentUser?.username).toBe("kevon");
    await session.switchUser();
    await session.login("ada", "another strong passphrase");
    expect(session.currentUser?.username).toBe("ada");
    expect(session.loginRequired).toBe(false);
  });
});

describe("DesktopSessionManager guest sessions", () => {
  it("starts an ephemeral guest session and wipes it on logout", async () => {
    const service = await createServiceWithUser();
    const callbacks = createCallbacks();
    const session = new DesktopSessionManager(service, callbacks);
    await session.init();

    await session.startGuestSession();
    expect(session.isGuestSession).toBe(true);
    expect(session.currentUser).toMatchObject({ username: GUEST_USERNAME, guest: true });
    expect(session.sessionActive).toBe(true);
    expect(callbacks.unlock).toHaveBeenCalled();
    // The guest is never persisted to the account registry.
    expect(service.getUser(GUEST_USERNAME)).toBeUndefined();

    await session.logout();
    expect(callbacks.closeAllWindows).toHaveBeenCalled();
    expect(callbacks.lock).toHaveBeenCalled();
    expect(session.loginRequired).toBe(true);
    expect(session.isGuestSession).toBe(false);
  });

  it("unlocks a locked guest session without a password", async () => {
    const service = await createServiceWithUser();
    const session = new DesktopSessionManager(service, createCallbacks());
    await session.init();

    await session.startGuestSession();
    await expect(session.verifyUnlock("anything")).resolves.toMatchObject({ ok: true });
  });
});
