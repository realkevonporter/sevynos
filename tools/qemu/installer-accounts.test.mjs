import assert from "node:assert/strict";
import test from "node:test";
import {
  PASSWORD_ALGORITHM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  buildRegistry,
  buildShadow,
  buildUserRecord,
  hashPassword,
  validateAccountPassword,
  validateAccountUsername,
  verifyPassword,
} from "./installer-accounts.mjs";

test("password round-trips through hash and verify", () => {
  const record = hashPassword("correct horse battery staple");
  assert.equal(record.algorithm, PASSWORD_ALGORITHM);
  assert.equal(record.algorithm, "scrypt");
  assert.equal(record.n, SCRYPT_N);
  assert.equal(record.r, SCRYPT_R);
  assert.equal(record.p, SCRYPT_P);
  assert.ok(record.saltBase64.length > 0);
  assert.ok(record.hashBase64.length > 0);
  // 64-byte key, 16-byte salt
  assert.equal(Buffer.from(record.hashBase64, "base64").length, 64);
  assert.equal(Buffer.from(record.saltBase64, "base64").length, 16);
  assert.ok(verifyPassword("correct horse battery staple", record));
});

test("wrong passwords fail verification", () => {
  const record = hashPassword("the-real-password");
  assert.equal(verifyPassword("the-wrong-password", record), false);
  assert.equal(verifyPassword("", record), false);
});

test("salts are random: same password hashes differently", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a.saltBase64, b.saltBase64);
  assert.notEqual(a.hashBase64, b.hashBase64);
  assert.ok(verifyPassword("same-password", a));
  assert.ok(verifyPassword("same-password", b));
});

test("tampered records fail closed", () => {
  const record = hashPassword("password");
  assert.equal(verifyPassword("password", null), false);
  assert.equal(verifyPassword("password", {}), false);
  assert.equal(verifyPassword("password", { ...record, algorithm: "md5" }), false);
  assert.equal(
    verifyPassword("password", { ...record, hashBase64: record.saltBase64 }),
    false,
  );
});

test("username validation mirrors the accounts service", () => {
  assert.equal(validateAccountUsername("kevon"), undefined);
  assert.equal(validateAccountUsername("sevyn_user-1"), undefined);
  assert.ok(validateAccountUsername("") !== undefined);
  assert.ok(validateAccountUsername("Root") !== undefined); // case
  assert.ok(validateAccountUsername("1abc") !== undefined); // leading digit
  assert.ok(validateAccountUsername("has space") !== undefined);
  for (const reserved of ["root", "admin", "sevyn", "nobody", "system"]) {
    assert.ok(
      validateAccountUsername(reserved) !== undefined,
      `${reserved} should be reserved`,
    );
  }
});

test("password validation mirrors the accounts service", () => {
  assert.equal(validateAccountPassword("12345678"), undefined);
  assert.ok(validateAccountPassword("short") !== undefined);
  assert.ok(validateAccountPassword("") !== undefined);
  assert.ok(validateAccountPassword("x".repeat(257)) !== undefined);
});

test("registry entry carries the contract fields and no secrets", () => {
  const entry = buildUserRecord({
    username: "kevon",
    uid: 1000,
    fullName: "Kevon Porter",
    createdAt: 1790000000000,
  });
  assert.deepEqual(entry, {
    username: "kevon",
    uid: 1000,
    fullName: "Kevon Porter",
    createdAt: 1790000000000,
  });
  assert.ok(!("password" in entry) && !("hash" in entry));
});

test("registry is { version: 1, users: [...] }", () => {
  const json = buildRegistry([
    { username: "kevon", uid: 1000, fullName: "Kevon", createdAt: 1790000000000 },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.users));
  assert.equal(parsed.users[0].username, "kevon");
  assert.equal(parsed.users[0].createdAt, 1790000000000);
});

test("registry rejects invalid uids, bad usernames and duplicates", () => {
  assert.throws(() => buildUserRecord({ username: "x", uid: 0 }));
  assert.throws(() => buildUserRecord({ username: "x", uid: 999 }));
  assert.throws(() => buildUserRecord({ username: "root", uid: 1000 }));
  assert.throws(() =>
    buildRegistry([
      { username: "kevon", uid: 1000 },
      { username: "kevon", uid: 1001 },
    ]),
  );
});

test("shadow is { version: 1, entries: { user: record } } without plaintext", () => {
  const json = buildShadow([{ username: "kevon", password: "s3cret-password" }]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.entries), ["kevon"]);
  const record = parsed.entries.kevon;
  assert.equal(record.algorithm, "scrypt");
  assert.ok(!JSON.stringify(record).includes("s3cret-password"));
  assert.ok(verifyPassword("s3cret-password", record));
  assert.equal(verifyPassword("nope", record), false);
});

test("shadow rejects duplicates and weak passwords", () => {
  assert.throws(() =>
    buildShadow([
      { username: "kevon", password: "long-enough-1" },
      { username: "kevon", password: "long-enough-2" },
    ]),
  );
  assert.throws(() => buildShadow([{ username: "kevon", password: "" }]));
  assert.throws(() => buildShadow([{ username: "kevon", password: "short" }]));
  assert.throws(() => buildShadow([{ username: "root", password: "long-enough" }]));
});
