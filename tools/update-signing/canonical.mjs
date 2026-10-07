/**
 * Canonical feed serialization for update-feed signatures (Phase 3).
 *
 * This is the single source of truth for the byte layout that gets signed.
 * services/update/src/feed-signing.ts re-implements this exact algorithm in
 * TypeScript for the on-device verifier; its test suite imports this module
 * and asserts byte-identical output on fixtures so the two can never drift.
 *
 * Canonical form definition:
 *   1. Start from the parsed feed manifest object.
 *   2. Remove the top-level "signatures" field (signatures sign the body,
 *      never themselves).
 *   3. Recursively sort every object's keys by UTF-16 code-unit order
 *      (Array order is preserved; JSON has no other ordering).
 *   4. Serialize with JSON.stringify using default separators (no
 *      whitespace, no trailing newline).
 *
 * The signature therefore covers the whole manifest — version, release
 * notes, and every artifact's URL, sha256 and size — including any future
 * fields such as the release channel. Adding a field to the feed
 * automatically puts it under the signature.
 */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Returns the canonical byte string of a feed manifest. `manifest` is the
 * parsed updates.json object (signatures included or not — they are
 * stripped before serializing).
 */
export function canonicalFeedBody(manifest) {
  if (!isRecord(manifest))
    throw new Error("canonicalFeedBody: manifest must be an object");
  const { signatures: _ignored, ...body } = manifest;
  return JSON.stringify(sortKeysDeep(body));
}
