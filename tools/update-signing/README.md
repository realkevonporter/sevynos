# SevynOS update signing

Phase 3 trust story for OS updates. Every `updates.json` feed published for
SevynOS devices is signed with Ed25519 (Node's built-in `crypto` — no
third-party crypto anywhere in this flow). Devices carry the public keys as
their trust anchor at `/etc/sevynos/trusted-update-keys.json` (baked into the
image by `tools/qemu/build.mjs`); the OS update service verifies the feed
signature **before** trusting any artifact URL or hash, and refuses to
download or apply anything when verification fails.

## The trust argument

The feed signature does not sign the multi-hundred-megabyte payloads — it
signs the feed manifest, and the manifest carries each artifact's `sha256`.
The client:

1. verifies the feed signature against a baked-in trusted public key, then
2. downloads the payload and checks its sha256 against the now-authenticated
   manifest value (streaming, in `os-update-service.ts`), and
3. the boot-time applier (`tools/qemu/sevyn-apply-update.sh`) re-checks the
   sha256 of the staged payload before extracting it.

So payload authenticity reduces to feed authenticity, and feed authenticity
reduces to "the private key never leaks". Everything below exists to protect
that one invariant.

## Custody ceremony

**Who holds the private key:** Kevon, and the GitHub Actions secret
`SEVYN_UPDATE_SIGNING_KEY` (contents = the private-key JSON file produced by
`generate-key.mjs`). Nobody else. It is never committed to the repo, never
baked into an image, never printed to logs — `generate-key.mjs` writes it
with mode `0600` and never prints private material to stdout.

**Nightly vs release keys:** use separate keypairs.

| Key     | keyId     | Signs                         | Trusted keys shipped                        |
| ------- | --------- | ----------------------------- | ------------------------------------------- |
| nightly | `nightly` | nightly `updates.json`        | nightly images (and dev images that opt in) |
| release | `release` | stable release `updates.json` | release images                              |

Separate keys mean a compromised nightly key cannot forge a stable release,
and the nightly key can be rotated aggressively without touching the release
trust anchor. A device trusts exactly the keys baked into its image — a
nightly device does not trust `release` signatures and vice versa, unless
both public keys are present in its `trusted-update-keys.json`.

**Generating a keypair:**

```sh
node tools/update-signing/generate-key.mjs --key-id nightly --out /secure/nightly-signing-key.json
# → prints the PUBLIC fragment; store the private file offline + as the
#   SEVYN_UPDATE_SIGNING_KEY Actions secret
```

**Wiring the trust anchor:** set `SEVYN_UPDATE_TRUSTED_KEYS` to the public
fragment JSON when building the image (`tools/qemu/build.mjs` validates it
and bakes it into `/etc/sevynos/trusted-update-keys.json`). Without it the
build prints a loud warning and ships an empty trust store — the on-device
updater then fails closed ("no trusted update keys") rather than silently
trusting unsigned feeds.

## Rotation procedure

1. Generate the replacement keypair (`generate-key.mjs --key-id <id>-<n>`).
2. During the overlap window, sign feeds with **both** keys (`sign-feed.mjs`
   preserves existing signatures; or set the CI secret to sign twice). Ship
   images whose `trusted-update-keys.json` contains **both** public keys.
3. Once every supported image in the field trusts the new key, retire the
   old key: stop signing with it and drop its public key from new images.
4. If a key is **compromised** (not routine rotation): generate a new
   keypair immediately, publish a feed signed only by the new key, ship an
   out-of-band image (or installer) carrying only the new trust anchor, and
   treat any feed signed solely by the compromised key as hostile. There is
   no remote revocation channel by design — the trust anchor lives on the
   device, so revocation happens through the next trusted image.

## Signature format

`updates.json` gains a top-level field:

```json
"signatures": { "<keyId>": "<base64 Ed25519 signature>" }
```

The signature is computed over the **canonical feed body**: the manifest
with `signatures` removed, all object keys sorted recursively (UTF-16
code-unit order), serialized as compact JSON (no whitespace). See
`canonical.mjs` — the single source of truth — and the byte-parity test in
`services/update/src/feed-signing.test.ts` that pins the TypeScript
verifier to it.

Verification (`verifyUpdateFeed` in `services/update/src/feed-signing.ts`)
succeeds when **at least one** signature verifies against a trusted keyId.
Unknown keyIds are ignored for trust (they must not cause acceptance), and
a feed with no trusted signature — missing, unknown-key-only, or tampered —
is rejected.
