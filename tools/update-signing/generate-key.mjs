#!/usr/bin/env node
/**
 * Generates an Ed25519 keypair for signing SevynOS update feeds.
 *
 * Usage:
 *   node tools/update-signing/generate-key.mjs --key-id nightly --out /secure/path/nightly-signing-key.json
 *
 * Output:
 *   - <out>: the PRIVATE signing key as JSON. Written with mode 0600.
 *     This file (or its contents as the SEVYN_UPDATE_SIGNING_KEY CI secret)
 *     is the crown jewel: whoever holds it can ship OS updates to every
 *     SevynOS device. It must NEVER be committed, baked into an image, or
 *     printed to logs. See README.md for the custody ceremony.
 *   - stdout: the PUBLIC key as a trusted-update-keys.json fragment, safe
 *     to paste into SEVYN_UPDATE_TRUSTED_KEYS so build.mjs bakes it into
 *     /etc/sevynos/trusted-update-keys.json on the image.
 *
 * Private material is never written to stdout.
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";

function usage() {
  console.error(
    "Usage: generate-key.mjs --key-id <id> --out <private-key-file>\n" +
      "  --key-id  short identifier baked into feed signatures, e.g. 'nightly' or 'release'\n" +
      "  --out     path for the PRIVATE key JSON (created with mode 0600)",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const keyId = args[args.indexOf("--key-id") + 1];
const out = args[args.indexOf("--out") + 1];
if (!keyId || !out || keyId.startsWith("--") || out.startsWith("--")) usage();

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicJwk = publicKey.export({ format: "jwk" });
const privateJwk = privateKey.export({ format: "jwk" });

const privateFile = {
  keyId,
  createdAt: new Date().toISOString(),
  algorithm: "Ed25519",
  privateKeyJwk: privateJwk,
};
await writeFile(out, `${JSON.stringify(privateFile, null, 2)}\n`, { mode: 0o600 });

const trustedFragment = {
  keys: [{ keyId, publicKeyJwk: publicJwk }],
};
console.log(JSON.stringify(trustedFragment, null, 2));
console.error(
  `\nPrivate key written to ${out} (mode 0600). Guard it per tools/update-signing/README.md.\n` +
    `Public fragment above is safe to publish via SEVYN_UPDATE_TRUSTED_KEYS.`,
);
