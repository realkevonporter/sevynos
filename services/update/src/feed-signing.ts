/**
 * Signed update feeds (Phase 3).
 *
 * Trust model:
 * - The release pipeline signs updates.json with an Ed25519 private key
 *   (see tools/update-signing/). The feed carries
 *   `signatures: { "<keyId>": "<base64 signature>" }`.
 * - Devices ship a trust anchor at /etc/sevynos/trusted-update-keys.json
 *   (public keys only), baked into the image by tools/qemu/build.mjs.
 * - OsUpdateService verifies the feed BEFORE trusting any artifact URL or
 *   sha256, and refuses to download/apply when verification fails. The
 *   failure surfaces as an "error" check result shown in the Software
 *   Update UI.
 *
 * Trust argument for payloads: the signature covers the canonical feed
 * body, which includes every artifact's sha256. The client verifies the
 * downloaded payload against that authenticated hash (and the boot-time
 * applier re-checks it), so payload authenticity reduces to feed
 * authenticity, which reduces to the private signing key never leaking.
 *
 * Crypto: Node's built-in `crypto` Ed25519 only. No home-rolled crypto.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import type { UpdateFeedManifest } from "./update-feed.js";

/** A public key the device trusts to sign update feeds. */
export interface TrustedUpdateKey {
  /** Identifier matching a key in the feed's `signatures` record. */
  readonly keyId: string;
  /** Ed25519 public key as a JWK: { kty: "OKP", crv: "Ed25519", x: "…" }. */
  readonly publicKeyJwk: Record<string, unknown>;
}

export interface FeedSignatureVerification {
  /** The trusted keyId whose signature verified. */
  readonly keyId: string;
}

function fail(reason: string): never {
  throw new Error(`Update feed signature verification failed: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Canonical feed body: the manifest with the top-level "signatures" field
 * removed, all object keys sorted recursively (UTF-16 code-unit order),
 * serialized as compact JSON with no whitespace.
 *
 * This MUST stay byte-identical to tools/update-signing/canonical.mjs —
 * feed-signing.test.ts pins the two implementations against each other.
 * Because the whole manifest is canonicalized, every field (version,
 * releaseNotes, artifact URLs/hashes/sizes, and future fields such as the
 * release channel) is covered by the signature.
 */
export function canonicalFeedBody(manifest: object): string {
  const body = { ...(manifest as Record<string, unknown>) };
  delete body["signatures"];
  return JSON.stringify(sortKeysDeep(body));
}

function publicKeyFromJwk(keyId: string, jwk: Record<string, unknown>) {
  if (jwk["kty"] !== "OKP" || jwk["crv"] !== "Ed25519" || typeof jwk["x"] !== "string")
    fail(`trusted key "${keyId}" is not an Ed25519 public JWK`);
  try {
    return createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
  } catch {
    fail(`trusted key "${keyId}" has an unreadable public key`);
  }
}

/**
 * Verifies the feed's signatures against the trusted keys. Succeeds when at
 * least one signature from a trusted keyId verifies over the canonical
 * body. Throws a descriptive error otherwise:
 * - no trusted keys configured → fail closed;
 * - feed unsigned → rejected;
 * - only unknown keyIds → rejected (unknown keys never confer trust);
 * - a trusted key's signature does not verify → rejected (tampered feed).
 */
export function verifyUpdateFeed(
  manifest: UpdateFeedManifest,
  trustedKeys: readonly TrustedUpdateKey[],
): FeedSignatureVerification {
  if (trustedKeys.length === 0)
    fail(
      "no trusted update keys are configured on this device — refusing to trust the feed",
    );
  const signatures = manifest.signatures;
  if (signatures === undefined || Object.keys(signatures).length === 0)
    fail('the feed is not signed (missing "signatures") — refusing to trust it');
  const body = Buffer.from(canonicalFeedBody(manifest), "utf8");
  let sawTrustedKeyId = false;
  for (const trusted of trustedKeys) {
    const encoded = signatures[trusted.keyId];
    if (encoded === undefined) continue;
    sawTrustedKeyId = true;
    const publicKey = publicKeyFromJwk(trusted.keyId, trusted.publicKeyJwk);
    let signature: Buffer;
    try {
      signature = Buffer.from(encoded, "base64");
    } catch {
      fail(`signature for key "${trusted.keyId}" is not valid base64`);
    }
    // Ed25519: the algorithm parameter must be null.
    if (verify(null, body, publicKey, signature)) return { keyId: trusted.keyId };
  }
  if (!sawTrustedKeyId) {
    const signedBy = Object.keys(signatures).join(", ");
    const trusted = trustedKeys.map((key) => key.keyId).join(", ");
    fail(
      `the feed carries no signature from a trusted key (signed by: ${signedBy}; trusted: ${trusted})`,
    );
  }
  fail(
    "a trusted signature is present but does not verify — the feed may have been tampered with",
  );
}

/**
 * Signs a manifest with an Ed25519 private JWK. Test/tooling helper —
 * production signing happens in tools/update-signing/sign-feed.mjs.
 */
export function signFeedManifest(
  manifest: UpdateFeedManifest,
  keyId: string,
  privateKeyJwk: Record<string, unknown>,
): UpdateFeedManifest {
  const privateKey = createPrivateKey({
    key: privateKeyJwk as unknown as JsonWebKey,
    format: "jwk",
  });
  const body = Buffer.from(canonicalFeedBody(manifest), "utf8");
  const signature = sign(null, body, privateKey).toString("base64");
  return {
    ...manifest,
    signatures: { ...(manifest.signatures ?? {}), [keyId]: signature },
  };
}

/**
 * Parses a trusted-update-keys.json document:
 * `{ "keys": [ { "keyId": "…", "publicKeyJwk": {…} } ] }`.
 * Throws a descriptive error on malformed input.
 */
export function parseTrustedUpdateKeys(text: string): TrustedUpdateKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid trusted update keys: not valid JSON.");
  }
  if (!isRecord(parsed))
    throw new Error("Invalid trusted update keys: top level must be an object.");
  const keys = parsed["keys"];
  if (!Array.isArray(keys))
    throw new Error('Invalid trusted update keys: "keys" must be an array.');
  return keys.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(
        `Invalid trusted update keys: keys[${String(index)}] must be an object.`,
      );
    const keyId = entry["keyId"];
    if (typeof keyId !== "string" || keyId.length === 0)
      throw new Error(
        `Invalid trusted update keys: keys[${String(index)}].keyId must be a non-empty string.`,
      );
    const publicKeyJwk = entry["publicKeyJwk"];
    if (!isRecord(publicKeyJwk))
      throw new Error(
        `Invalid trusted update keys: keys[${String(index)}].publicKeyJwk must be an object.`,
      );
    return { keyId, publicKeyJwk };
  });
}

/**
 * Loads the device trust anchor. Defaults to the well-known image path
 * /etc/sevynos/trusted-update-keys.json (written by tools/qemu/build.mjs
 * from SEVYN_UPDATE_TRUSTED_KEYS). Callers should fail closed when this
 * throws or returns an empty list.
 */
export async function loadTrustedUpdateKeys(
  path = "/etc/sevynos/trusted-update-keys.json",
): Promise<TrustedUpdateKey[]> {
  const text = await readFile(path, "utf8");
  return parseTrustedUpdateKeys(text);
}
