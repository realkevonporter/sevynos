#!/usr/bin/env node
/**
 * Signs an update feed (updates.json) with an Ed25519 signing key.
 *
 * Usage:
 *   node tools/update-signing/sign-feed.mjs --feed <updates.json> --key-file <signing-key.json>
 *
 * Reads the feed, computes the canonical body (see canonical.mjs), signs it,
 * and writes the feed back with a top-level "signatures" field:
 *
 *   "signatures": { "<keyId>": "<base64 Ed25519 signature>" }
 *
 * Existing signatures from other keyIds are preserved, so a feed can carry
 * both nightly and release signatures during a rotation.
 *
 * build.mjs calls signFeedFile() directly when SEVYN_UPDATE_SIGNING_KEY is
 * set; this CLI exists for manual/CI signing outside the image build.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalFeedBody } from "./canonical.mjs";

function fail(message) {
  console.error(`sign-feed: ${message}`);
  process.exit(1);
}

/**
 * Signs the feed file at `feedPath` with the private key in `keyMaterial`
 * ({ keyId, privateKeyJwk }) and rewrites the file with the signature added.
 * Returns the keyId the feed was signed with.
 */
export async function signFeedFile(feedPath, keyMaterial) {
  const keyId = keyMaterial?.keyId;
  const privateJwk = keyMaterial?.privateKeyJwk;
  if (typeof keyId !== "string" || keyId.length === 0)
    throw new Error("signing key material must include a non-empty keyId");
  if (
    privateJwk?.kty !== "OKP" ||
    privateJwk?.crv !== "Ed25519" ||
    typeof privateJwk?.d !== "string"
  )
    throw new Error("signing key material must include an Ed25519 privateKeyJwk");

  let feed;
  try {
    feed = JSON.parse(await readFile(feedPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read feed ${feedPath}: ${error.message}`);
  }

  const body = canonicalFeedBody(feed);
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  // Ed25519: the algorithm parameter must be null.
  const signature = sign(null, Buffer.from(body, "utf8"), privateKey);
  const signatures =
    typeof feed.signatures === "object" && feed.signatures !== null
      ? { ...feed.signatures }
      : {};
  signatures[keyId] = signature.toString("base64");

  await writeFile(feedPath, `${JSON.stringify({ ...feed, signatures }, null, 2)}\n`);
  return keyId;
}

/** Parses SEVYN_UPDATE_SIGNING_KEY: either the key JSON itself or a path to the key file. */
export async function parseSigningKeyEnv(raw) {
  const trimmed = raw.trim();
  const text = trimmed.startsWith("{") ? trimmed : await readFile(trimmed, "utf8");
  return JSON.parse(text);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const feedPath = args[args.indexOf("--feed") + 1];
  const keyFile = args[args.indexOf("--key-file") + 1];
  if (!feedPath || !keyFile || feedPath.startsWith("--") || keyFile.startsWith("--")) {
    fail("usage: sign-feed.mjs --feed <updates.json> --key-file <signing-key.json>");
  }
  let keyMaterial;
  try {
    keyMaterial = JSON.parse(await readFile(keyFile, "utf8"));
  } catch (error) {
    fail(`cannot read key file: ${error.message}`);
  }
  try {
    const keyId = await signFeedFile(feedPath, keyMaterial);
    console.log(`Signed ${feedPath} with key "${keyId}".`);
  } catch (error) {
    fail(error.message);
  }
}
