# SevynOS Release Process

How SevynOS versions, builds, and ships releases — and how to roll one back.

## Versioning policy

SevynOS uses semantic versioning: `MAJOR.MINOR.PATCH`.

| Bump  | When                                                                                      |
| ----- | ----------------------------------------------------------------------------------------- |
| Major | Breaking changes: on-disk format changes, dropped hardware support, incompatible app APIs |
| Minor | New features, new system apps, new hardware enablement — backwards compatible             |
| Patch | Bug fixes and security fixes only — no new features                                       |

The version is stamped into the image at `/etc/sevynos-release` and into
`updates.json` at build time (see `tools/qemu/build.mjs`).

- **Stable releases** come from git tags named `vX.Y.Z` (e.g. `v1.0.0`). The
  tag is the single source of truth: `tools/qemu/release-version.mjs`
  resolves the OS version from `SEVYN_RELEASE_TAG` (preferred) or
  `GITHUB_REF_NAME`, stripping the leading `v`. Tags must be strict
  `vMAJOR.MINOR.PATCH` — anything else falls back to a nightly build.
- **Nightly builds** are automatic snapshots from `main` and look like
  `0.1.0-nightly.20261007.abc1234` (`<package.json version>-nightly.YYYYMMDD.<shortsha>`).
  A nightly sorts **newer** than the bare release with the same base version
  (see `services/update/src/version.ts`) — the nightly channel is always
  ahead of the release it was cut from.

## Channels

| Channel   | Feed                                                                                | Updated by                       |
| --------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| `stable`  | `https://github.com/realkevonporter/sevynos/releases/latest/download/updates.json`  | Tag push → `stable-release.yml`  |
| `nightly` | `https://github.com/realkevonporter/sevynos/releases/download/nightly/updates.json` | `main` push → `public-build.yml` |

- Installed systems default to the **stable** channel. Users can switch to
  nightly in Settings → Software Update → Release channel; the choice is
  persisted on-device and survives reboots.
- The stable feed URL uses GitHub's `releases/latest` redirect, which always
  resolves to the newest **non-prerelease** release — so it tracks the latest
  stable release with no floating tag to maintain. Nightly prereleases never
  affect it.
- `updates.json` carries a `"channel"` field (`"stable"` or `"nightly"`);
  feeds written before channels existed parse as `"nightly"`.
- Update signature verification is Phase 3 (Worker B); today the feed's
  `sha256` is an integrity check against corrupt downloads only.

## Cutting a stable release

Prerequisites: all CI checks green on `main` at the commit you want to
release, and a boot smoke test of the image (see the Phase 3 QEMU smoke
runbook).

1. **Decide the version** per the policy above. Check the previous tag:
   `git tag --sort=-v:refname | head`.
2. **Tag and push** (pushing the tag is what starts the release):
   ```sh
   git tag -a v1.2.0 -m "SevynOS v1.2.0"
   git push origin v1.2.0
   ```
   Do not push tags casually — every `v*.*.*` tag triggers a full image
   build and a public release.
3. **CI builds and publishes** (`.github/workflows/stable-release.yml`):
   checks out the tag, runs `pnpm qemu:build` with `SEVYN_RELEASE_TAG` set,
   then publishes a GitHub **release** (not a prerelease, marked latest)
   named `SevynOS v1.2.0` with `sevynos-live.iso`, `SHA256SUMS`,
   `rootfs.squashfs`, and `updates.json`. The feed's artifact URLs point at
   this tag's release assets.
4. **Verify**:
   - The release page shows all four assets and `makeLatest` took effect
     (`releases/latest` redirects to the new tag).
   - Download `updates.json` from the stable feed URL and confirm
     `"version": "1.2.0"` and `"channel": "stable"`.
   - `sha256sum -c SHA256SUMS` on the downloaded ISO.
   - On a test install on the stable channel, Settings → Software Update
     offers the new version; download + stage it and confirm the pending
     update record.
   - This publish path cannot be fully tested without pushing a tag — the
     first real release is the live test. Watch the workflow run.
5. **Write the changelog**: edit the release body on GitHub — summarize
   user-facing changes since the previous stable tag (the workflow leaves a
   placeholder section for this).
6. **Announce** (checklist):
   - [ ] GitHub release notes finalized (changelog section filled in).
   - [ ] Post in the community channels listed in `docs/community.md`.
   - [ ] Update any download links that point at "latest stable".

## Nightly builds

Every merge to `main` triggers `public-build.yml`, which rebuilds the image
and updates the floating `nightly` prerelease. Nightly behavior is unchanged
by the stable pipeline — the two never share a tag or a feed.

## Rolling back a bad release

Stable releases are immutable artifacts; "rollback" means pointing users at
the previous good release:

1. **Stop the bleeding**: on the bad release's GitHub page, uncheck
   "Set as the latest release" (or delete the release if nothing should
   ever install it). `releases/latest` — and therefore the stable feed —
   immediately resolves to the previous stable release again.
2. **Replace the release** (only if the tag itself was wrong, e.g. built
   from the wrong commit): delete the release _and_ the tag, fix, re-tag,
   re-push. Never move a tag that users may already have installed —
   prefer a new patch version (`v1.2.1`) instead.
3. **Tell users**: post a correction in the same channels as the
   announcement. Users who already downloaded the bad rootfs will be
   offered the rollback as a normal update (version comparison handles it:
   the previous stable version is older, so… — careful: if the bad release
   has a _higher_ version number, clients won't "update" to the older one.
   In that case ship a new patch release with the fix instead of asking
   users to downgrade.)
4. **Post-mortem**: record what went wrong so the release checklist covers
   it next time.

Note: there is no downgrade path in the updater — `isUpdateAvailable`
only moves forward. A bad stable release is fixed by a newer release, not
by reinstalling the old one over it.
