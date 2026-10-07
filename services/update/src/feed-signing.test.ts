import { generateKeyPairSync } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalFeedBody,
  loadTrustedUpdateKeys,
  parseTrustedUpdateKeys,
  signFeedManifest,
  verifyUpdateFeed,
  type TrustedUpdateKey,
} from "./feed-signing.js";
import { parseUpdateFeed, type UpdateFeedManifest } from "./update-feed.js";
// Byte-parity pin: the JS signing tooling and this TS verifier must agree
// on the canonical form exactly, or signatures will never verify.
import { canonicalFeedBody as canonicalFeedBodyMjs } from "../../../tools/update-signing/canonical.mjs";

const SHA = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): UpdateFeedManifest {
  return parseUpdateFeed(
    JSON.stringify({
      version: "0.1.0-nightly.20261007.abc1234",
      publishedAt: "2026-10-07T10:00:00.000Z",
      releaseNotes: "Nightly build.",
      artifacts: [
        {
          kind: "rootfs-squashfs",
          url: "https://example.com/rootfs.squashfs",
          sha256: SHA,
          sizeBytes: 123456,
        },
      ],
      ...overrides,
    }),
  );
}

function keypair(keyId: string): {
  trusted: TrustedUpdateKey;
  privateJwk: Record<string, unknown>;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    trusted: {
      keyId,
      publicKeyJwk: publicKey.export({ format: "jwk" }),
    },
    privateJwk: privateKey.export({ format: "jwk" }),
  };
}

describe("verifyUpdateFeed", () => {
  it("verifies a sign→verify round-trip", () => {
    const { trusted, privateJwk } = keypair("nightly");
    const signed = signFeedManifest(manifest(), "nightly", privateJwk);
    expect(verifyUpdateFeed(signed, [trusted])).toEqual({ keyId: "nightly" });
    // Re-parsing the serialized feed (the real client path) also verifies.
    expect(verifyUpdateFeed(parseUpdateFeed(JSON.stringify(signed)), [trusted])).toEqual({
      keyId: "nightly",
    });
  });

  it("rejects a tampered feed", () => {
    const { trusted, privateJwk } = keypair("nightly");
    const signed = signFeedManifest(manifest(), "nightly", privateJwk);
    const tampered = parseUpdateFeed(
      JSON.stringify({ ...signed, releaseNotes: "Evil release notes." }),
    );
    expect(() => verifyUpdateFeed(tampered, [trusted])).toThrow("tampered");
  });

  it("rejects a tampered artifact hash", () => {
    const { trusted, privateJwk } = keypair("nightly");
    const signed = signFeedManifest(manifest(), "nightly", privateJwk);
    const tamperedArtifacts = signed.artifacts.map((artifact) => ({
      ...artifact,
      sha256: "f".repeat(64),
    }));
    const tampered = parseUpdateFeed(
      JSON.stringify({ ...signed, artifacts: tamperedArtifacts }),
    );
    // The signature covers the artifact hashes, so swapping a hash breaks it.
    expect(() => verifyUpdateFeed(tampered, [trusted])).toThrow();
  });

  it("rejects a feed signed by an unknown keyId", () => {
    const { trusted } = keypair("nightly");
    const rogue = keypair("rogue");
    const signed = signFeedManifest(manifest(), "rogue", rogue.privateJwk);
    expect(() => verifyUpdateFeed(signed, [trusted])).toThrow(
      "no signature from a trusted key",
    );
  });

  it("rejects a feed with no signature", () => {
    const { trusted } = keypair("nightly");
    expect(() => verifyUpdateFeed(manifest(), [trusted])).toThrow("not signed");
  });

  it("fails closed with no trusted keys configured", () => {
    const { privateJwk } = keypair("nightly");
    const signed = signFeedManifest(manifest(), "nightly", privateJwk);
    expect(() => verifyUpdateFeed(signed, [])).toThrow("no trusted update keys");
  });

  it("accepts when any one of several trusted keys signed", () => {
    const first = keypair("nightly");
    const second = keypair("release");
    let signed = signFeedManifest(manifest(), "nightly", first.privateJwk);
    signed = signFeedManifest(signed, "release", second.privateJwk);
    // Either trust anchor alone is enough (rotation overlap window).
    expect(verifyUpdateFeed(signed, [first.trusted])).toEqual({ keyId: "nightly" });
    expect(verifyUpdateFeed(signed, [second.trusted])).toEqual({ keyId: "release" });
  });

  it("ignores unknown keyIds when a trusted signature is present", () => {
    const { trusted, privateJwk } = keypair("nightly");
    const rogue = keypair("rogue");
    let signed = signFeedManifest(manifest(), "rogue", rogue.privateJwk);
    signed = signFeedManifest(signed, "nightly", privateJwk);
    expect(verifyUpdateFeed(signed, [trusted])).toEqual({ keyId: "nightly" });
  });
});

describe("canonicalFeedBody", () => {
  it("is byte-identical to the JS signing tooling", () => {
    const bodies: object[] = [
      manifest(),
      signFeedManifest(manifest(), "nightly", keypair("nightly").privateJwk),
      manifest({ channel: "nightly", extra: { z: 1, a: [3, 2, 1] } }),
    ];
    for (const body of bodies) {
      expect(canonicalFeedBody(body)).toBe(canonicalFeedBodyMjs(body));
    }
  });

  it("excludes signatures and sorts keys with no whitespace", () => {
    const signed = signFeedManifest(manifest(), "nightly", keypair("nightly").privateJwk);
    const canonical = canonicalFeedBody(signed);
    expect(canonical).not.toContain("signatures");
    // Compact: re-serializing the parsed body with default JSON.stringify
    // (no whitespace) must be a fixed point.
    expect(JSON.stringify(JSON.parse(canonical))).toBe(canonical);
    // Sorted keys: artifacts < publishedAt < releaseNotes < version.
    expect(canonical.indexOf('"artifacts"')).toBeLessThan(
      canonical.indexOf('"publishedAt"'),
    );
  });
});

describe("parseTrustedUpdateKeys", () => {
  it("parses a trusted-keys document", () => {
    const { trusted } = keypair("nightly");
    const parsed = parseTrustedUpdateKeys(JSON.stringify({ keys: [trusted] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.keyId).toBe("nightly");
  });

  it("rejects malformed documents", () => {
    expect(() => parseTrustedUpdateKeys("nope")).toThrow("not valid JSON");
    expect(() => parseTrustedUpdateKeys("{}")).toThrow('"keys"');
    expect(() => parseTrustedUpdateKeys(JSON.stringify({ keys: [{}] }))).toThrow("keyId");
  });

  it("loadTrustedUpdateKeys reads a file", async () => {
    const { trusted } = keypair("nightly");
    const path = join(tmpdir(), `trusted-keys-test-${String(Date.now())}.json`);
    await writeFile(path, JSON.stringify({ keys: [trusted] }));
    try {
      const loaded = await loadTrustedUpdateKeys(path);
      expect(loaded[0]?.keyId).toBe("nightly");
    } finally {
      await rm(path, { force: true });
    }
  });
});
