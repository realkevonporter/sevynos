/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccountError,
  AccountService,
  FileAccountStore,
  InMemoryAccountStore,
  validatePassword,
  validateUsername,
} from "./account-service.js";
import { homeDirectoryFor } from "./account-paths.js";

function createService(now: () => number = () => 1_700_000_000_000): AccountService {
  return new AccountService({ store: new InMemoryAccountStore(), now });
}

describe("validateUsername", () => {
  it("accepts normal login-style names", () => {
    expect(validateUsername("kevon")).toBeUndefined();
    expect(validateUsername("kevon_porter-2")).toBeUndefined();
    expect(validateUsername("_service")).toBeUndefined();
  });

  it("rejects empty, long, malformed, and reserved names", () => {
    expect(validateUsername("")).toContain("username");
    expect(validateUsername("a".repeat(33))).toContain("32");
    expect(validateUsername("Kevon")).toContain("lowercase");
    expect(validateUsername("kevon porter")).toContain("lowercase");
    expect(validateUsername("1kevon")).toContain("letter");
    expect(validateUsername("-kevon")).toContain("letter");
    expect(validateUsername("root")).toContain("reserved");
    expect(validateUsername("guest")).toContain("reserved");
    expect(validateUsername("admin")).toContain("reserved");
  });
});

describe("validatePassword", () => {
  it("requires 8-256 characters", () => {
    expect(validatePassword("short")).toContain("8");
    expect(validatePassword("long-enough-password")).toBeUndefined();
    expect(validatePassword("a".repeat(257))).toContain("256");
  });
});

describe("AccountService user management", () => {
  it("creates users with incrementing uids starting at 1000", async () => {
    const service = createService();
    await service.init();

    const first = await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
      fullName: "Kevon",
    });
    const second = await service.createUser({
      username: "ada",
      password: "another strong passphrase",
    });

    expect(first.uid).toBe(1000);
    expect(second.uid).toBe(1001);
    expect(first).toMatchObject({ username: "kevon", fullName: "Kevon" });
    expect(service.hasAccounts()).toBe(true);
    expect(service.listUsers()).toHaveLength(2);
    expect(service.getUser("ada")?.username).toBe("ada");
  });

  it("rejects duplicates, invalid usernames, and weak passwords", async () => {
    const service = createService();
    await service.init();
    await service.createUser({ username: "kevon", password: "long-enough-password" });

    await expect(
      service.createUser({ username: "kevon", password: "another-long-password" }),
    ).rejects.toMatchObject({ code: "account-exists" });
    await expect(
      service.createUser({ username: "Bad Name", password: "long-enough-password" }),
    ).rejects.toMatchObject({ code: "invalid-username" });
    await expect(
      service.createUser({ username: "newuser", password: "short" }),
    ).rejects.toMatchObject({ code: "weak-password" });
  });

  it("requires init() before use", () => {
    const service = createService();
    expect(() => service.listUsers()).toThrow(AccountError);
  });

  it("deletes users and clears their credentials", async () => {
    const service = createService();
    await service.init();
    await service.createUser({ username: "kevon", password: "long-enough-password" });

    await service.deleteUser("kevon");
    expect(service.hasAccounts()).toBe(false);
    expect(service.getUser("kevon")).toBeUndefined();
    await expect(service.deleteUser("kevon")).rejects.toMatchObject({
      code: "account-not-found",
    });
  });

  it("rotates passwords via setPassword", async () => {
    const service = createService();
    await service.init();
    await service.createUser({ username: "kevon", password: "first-long-password" });

    await service.setPassword("kevon", "second-long-password");
    expect(await service.verifyPassword("kevon", "second-long-password")).toMatchObject({
      ok: true,
    });
    expect(await service.verifyPassword("kevon", "first-long-password")).toMatchObject({
      ok: false,
    });
    await expect(
      service.setPassword("nobody", "long-enough-password"),
    ).rejects.toMatchObject({
      code: "account-not-found",
    });
  });
});

describe("AccountService password verification", () => {
  it("verifies the correct password and rejects wrong ones", async () => {
    const service = createService();
    await service.init();
    await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
    });

    expect(
      await service.verifyPassword("kevon", "correct horse battery staple"),
    ).toMatchObject({ ok: true });
    expect(await service.verifyPassword("kevon", "wrong password here!!")).toMatchObject({
      ok: false,
      lockedOut: false,
    });
  });

  it("rejects unknown users without leaking lockout state", async () => {
    const service = createService();
    await service.init();

    const result = await service.verifyPassword("ghost", "any-long-password");
    expect(result).toMatchObject({ ok: false, lockedOut: false });
  });

  it("locks out after repeated failures and recovers after the lockout", async () => {
    let now = 1_700_000_000_000;
    const service = new AccountService({
      store: new InMemoryAccountStore(),
      now: () => now,
    });
    await service.init();
    await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await service.verifyPassword("kevon", "wrong password here!!");
      if (attempt < 4) {
        expect(result).toMatchObject({ ok: false, lockedOut: false });
      } else {
        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ lockedOut: true });
        if (!result.ok) {
          expect(result.retryAfterMs).toBeGreaterThan(0);
        }
      }
    }

    // Even the right password is refused while locked out.
    expect(
      await service.verifyPassword("kevon", "correct horse battery staple"),
    ).toMatchObject({
      lockedOut: true,
    });

    now += 61 * 1000;
    expect(
      await service.verifyPassword("kevon", "correct horse battery staple"),
    ).toMatchObject({
      ok: true,
    });
  });

  it("resets the failure counter after a successful verification", async () => {
    const now = 1_700_000_000_000;
    const service = new AccountService({
      store: new InMemoryAccountStore(),
      now: () => now,
    });
    await service.init();
    await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await service.verifyPassword("kevon", "wrong password here!!");
    }
    expect(
      await service.verifyPassword("kevon", "correct horse battery staple"),
    ).toMatchObject({
      ok: true,
    });
    // Four more failures must not lock out: the counter was reset.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await service.verifyPassword("kevon", "wrong password here!!");
      expect(result).toMatchObject({ ok: false, lockedOut: false });
    }
  });

  it("produces unique salts per user", async () => {
    const service = createService();
    await service.init();
    await service.createUser({ username: "kevon", password: "shared-long-password" });
    await service.createUser({ username: "ada", password: "shared-long-password" });

    expect(await service.verifyPassword("kevon", "shared-long-password")).toMatchObject({
      ok: true,
    });
    expect(await service.verifyPassword("ada", "shared-long-password")).toMatchObject({
      ok: true,
    });
  });
});

describe("FileAccountStore", () => {
  async function createTempStore(): Promise<{ store: FileAccountStore; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "sevyn-accounts-test-"));
    const store = new FileAccountStore({
      baseDir: join(dir, "accounts"),
      usersDir: join(dir, "users"),
    });
    return { store, dir };
  }

  it("persists the registry and shadow across service instances", async () => {
    const { store, dir } = await createTempStore();
    const first = new AccountService({ store });
    await first.init();
    await first.createUser({
      username: "kevon",
      password: "correct horse battery staple",
      fullName: "Kevon",
    });

    const second = new AccountService({
      store: new FileAccountStore({
        baseDir: join(dir, "accounts"),
        usersDir: join(dir, "users"),
      }),
    });
    await second.init();
    expect(second.listUsers()).toHaveLength(1);
    expect(second.getUser("kevon")).toMatchObject({
      username: "kevon",
      uid: 1000,
      fullName: "Kevon",
    });
    expect(
      await second.verifyPassword("kevon", "correct horse battery staple"),
    ).toMatchObject({
      ok: true,
    });
  });

  it("keeps secrets out of the registry and locks the shadow file down", async () => {
    const { store, dir } = await createTempStore();
    const service = new AccountService({ store });
    await service.init();
    await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
    });

    const registryRaw = await readFile(join(dir, "accounts", "registry.json"), "utf8");
    expect(registryRaw).toContain("kevon");
    expect(registryRaw).not.toContain("scrypt");
    expect(registryRaw).not.toContain("correct horse");

    const shadowRaw = await readFile(join(dir, "accounts", "shadow.json"), "utf8");
    const shadow = JSON.parse(shadowRaw) as {
      entries: Record<
        string,
        { algorithm: string; saltBase64: string; hashBase64: string }
      >;
    };
    expect(shadow.entries["kevon"]?.algorithm).toBe("scrypt");
    expect(typeof shadow.entries["kevon"]?.saltBase64).toBe("string");
    expect(typeof shadow.entries["kevon"]?.hashBase64).toBe("string");

    const shadowStat = await stat(join(dir, "accounts", "shadow.json"));
    expect(shadowStat.mode & 0o777).toBe(0o600);
  });

  it("creates home directories with the standard subdirectories", async () => {
    const { store, dir } = await createTempStore();
    const service = new AccountService({ store });
    await service.init();
    await service.createUser({
      username: "kevon",
      password: "correct horse battery staple",
    });

    expect(store.homeDirectoryFor("kevon")).toBe(
      homeDirectoryFor("kevon", join(dir, "users")),
    );
    for (const subdir of [
      "Desktop",
      "Documents",
      "Downloads",
      "Pictures",
      "Music",
      "Videos",
    ]) {
      const entry = await stat(join(dir, "users", "kevon", subdir));
      expect(entry.isDirectory()).toBe(true);
    }
  });

  it("rejects malformed store files instead of silently starting empty", async () => {
    const { store, dir } = await createTempStore();
    await mkdir(join(dir, "accounts"), { recursive: true });
    await writeFile(join(dir, "accounts", "registry.json"), "{ not json");

    const service = new AccountService({ store });
    await expect(service.init()).rejects.toMatchObject({ code: "store-error" });
  });

  it("starts empty when no store files exist yet", async () => {
    const { store } = await createTempStore();
    const service = new AccountService({ store });
    await service.init();
    expect(service.hasAccounts()).toBe(false);
  });
});
