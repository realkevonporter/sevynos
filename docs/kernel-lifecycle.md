# SevynOS Kernel Lifecycle (Phase 3 B3)

How OS updates ship a new kernel+initramfs, and how the kernel, the
recovery environment, Secure Boot signing, and rollback stay consistent.

## Feed artifacts

`services/update/src/update-feed.ts` defines two kernel artifact kinds —
`"vmlinuz"` and `"initramfs"` — next to `"rootfs-squashfs"`. A release
carries a kernel update by publishing both; `selectKernelArtifacts()`
throws on a half pair (fail loud). The artifacts ride the B1 feed
signature with no format change: the canonical feed body covers the whole
`artifacts` array, so their hashes are signature-covered.

`tools/qemu/build.mjs` adds both artifacts to `updates.json` when
`vmlinuz` and `initramfs.cpio.gz` are present in the build output (same
release-assets URL scheme as the rootfs).

The OS update service (`services/update/src/os-update-service.ts`)
downloads the pair into `<updates>/<version>/` (`vmlinuz`,
`initramfs.cpio.gz`) with the same streaming sha256/size verification as
the rootfs, and stages them for the boot-time applier. `pending.json`
carries them as FLAT fields (`kernelPath`, `kernelSha256`,
`kernelSizeBytes`, `initramfsPath`, `initramfsSha256`,
`initramfsSizeBytes`) — the applier parses pending.json with sed, and
nested objects would break its patterns.

## /boot layout

Kernel updates install VERSIONED files and never overwrite the running
pair in place:

| Path                                                                           | Contents                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `/boot/vmlinuz-<kver>`                                                         | versioned kernel                                                                      |
| `/boot/initramfs-<kver>.cpio.gz`                                               | versioned main initramfs                                                              |
| `/boot/recovery-initramfs-<kver>.cpio.gz`                                      | versioned recovery image (modules for `<kver>`)                                       |
| `/boot/vmlinuz`, `/boot/initramfs.cpio.gz`, `/boot/recovery-initramfs.cpio.gz` | install-time unversioned names — owned by the installer, never written by the updater |

Pairing state lives at `/var/lib/sevynos/updates/kernels.json`:

```json
{
  "current":  {"version": "<kver>", "kernel": "/boot/vmlinuz-<kver>", ...},
  "previous": {"version": "<kver>", "kernel": "/boot/vmlinuz-<kver>", ...} | null
}
```

Only the current + previous versioned pairs are kept;
`sevyn_prune_old_kernels` removes superseded versioned files after a
successful update. The unversioned install-time names are never pruned.

## Applier flow (tools/qemu/sevyn-apply-update.sh)

Shared helpers live in `tools/qemu/kernel-lifecycle-lib.sh` (installed to
`/usr/local/lib/sevyn-kernel-lifecycle-lib.sh`; also shipped inside the
recovery image for the manual rollback path).

**Phase A — pre-extraction.** Every step aborts with no partial state
(`SEVYN_UPDATE_ABORT`, pending.json moved to `failed-<ts>.json`):

1. sha256-verify the staged kernel + initramfs.
2. Detect the new kernel's version from its `Linux version` banner; skip
   the whole kernel flow when it equals the running kernel.
3. **Module assertion** (`sevyn_assert_kernel_modules_match`): the new
   kernel's version must appear among the `/lib/modules/<ver>` trees
   inside the staged rootfs (they are built together). Mismatch aborts.
4. **Secure Boot** (docs/secure-boot.md §7): when a machine MOK exists
   (`/var/lib/sevyn/secureboot/MOK.priv`), the staged kernel is signed
   with it (`sevyn_sign_boot_artifacts`, sbsign to a temp file then
   rename — atomic) BEFORE it lands in /boot, then checked with
   `sbverify` when available. Abort (fail closed) on: `state.json`
   `signedWith` ≠ current MOK fingerprint (key mismatch — signing with
   the wrong key ships an unbootable kernel), missing sbsign, signing
   failure, or sbverify rejection. Without a MOK the kernel installs
   unsigned. C2's `sevyn-secure-boot.sh sign` is also invoked when
   present (it covers the unversioned install-time paths).
5. **Recovery rebuild** (C1 contract): the new kernel's modules and the
   new recovery tree are extracted from the staged payload and
   `build-sevyn-recovery-image` rebuilds the recovery initramfs against
   them (`SEVYN_MODULES_DIR` override) with `SEVYN_OS_VERSION` set to the
   update version. Any failure aborts — a kernel update that leaves a
   stale recovery image is refused.

**Snapshot.** The existing `snapshot_previous` runs, then
`record_previous_kernels` writes `previous/kernels.json` into the B2
snapshot slot (the pre-update pair: version + the three /boot paths +
`newKernelVersion`).

**Phase B — post-extraction.** The rootfs is extracted, then:

1. The (signed, when applicable) versioned pair is copied into /boot;
   the rebuilt recovery image lands at both versioned and stable
   (`/boot/recovery-initramfs.cpio.gz`) names.
2. **ESP staging** (UEFI only): the ESP is mounted by UUID (parsed from
   the current grub.cfg) and `EFI/SevynOS/vmlinuz` +
   `EFI/SevynOS/recovery-initramfs.cpio.gz` are refreshed from the new
   pair. A UEFI system whose ESP cannot be mounted fails the kernel
   update (fail closed).
3. `grub.cfg` is regenerated via the shared `grub-cfg-lib.sh`: the new
   kernel is the default entry, the previous pair is an explicit
   **"SevynOS (previous kernel)"** fallback entry, and C1's
   **"SevynOS Recovery"** entry is preserved (ESP names for UEFI; the
   versioned /boot pair for legacy BIOS so its modules match its
   kernel).
4. `kernels.json` is updated, `state.json` records the signing
   (`signed`/`signedAt`/`signedWith`), old versioned pairs are pruned,
   and the machine reboots into the new kernel.

Phase B failures use `fail_applied`: loud log, best-effort removal of the
new /boot files + grub.cfg restore from backup, then the boot-health
rollback safety net (the pre-update snapshot + previous kernel pair are
intact).

## Rollback pairing (B2 composition)

A new rootfs with an old kernel (or vice versa) is a bricked
combination — both must flip together. The pairing record is
`previous/kernels.json`; both rollback paths flip through
`sevyn_kernel_rollback_flip`:

- **Automatic** (`sevyn_rollback_restore` in
  `tools/qemu/sevyn-boot-health.sh`): after the snapshot is restored,
  the flip regenerates grub.cfg with the previous pair as default (the
  failed kernel becomes the fallback), refreshes the ESP staging and the
  stable /boot recovery name, and swaps current/previous in
  `kernels.json`. A failed flip does NOT reset the boot-attempt counter —
  the next boot retries the rollback. When the update was rootfs-only
  (no `previous/kernels.json`) the flip is a no-op.
- **Manual** (recovery `rollback.sh`): after `restore_image_over_root`
  succeeds, the same flip runs using the library shipped inside the
  recovery image. Recovery images predating the kernel updater lack the
  library and skip the flip (their updates were rootfs-only anyway); on
  flip failure the user is told not to reboot yet.

Because the snapshot excludes `boot/*` and recovery's restore preserves
the `boot` prefix, the versioned pairs always survive both restore
paths — the flip only rewrites pointers (grub.cfg, ESP staging, stable
names), never the pairs themselves.

## Cross-workstream contracts

- **C1 (recovery, docs/recovery.md):** the recovery image is rebuilt
  against the new kernel's modules on every kernel update, before the
  update commits; the ESP-staged recovery kernel is refreshed from the
  new (signed, when applicable) kernel; the legacy-BIOS recovery GRUB
  entry follows the versioned pair so its modules match its kernel.
- **C2 (secure boot, docs/secure-boot.md §7):** every kernel update
  re-signs with the machine MOK before the new kernel lands in /boot,
  including the ESP-staged recovery kernel; `state.json` key mismatch
  aborts the update. Note: the merged C2 PR did not add a Dockerfile
  `COPY` for `sevyn-secure-boot.sh` although the installer expects it at
  `/usr/local/lib/sevyn-secure-boot.sh` — this branch adds that COPY so
  the install-time MOK setup and the update-time `sign` hook both work.

## Tests

- `services/update/src/update-feed.test.ts` — new artifact kinds parse;
  `selectKernelArtifacts` returns the pair and throws on a half pair.
- `services/update/src/os-update-service.test.ts` — the service
  downloads the kernel pair when the feed ships one; `pending.json`
  carries the flat fields; `pendingUpdate()` re-nests them.
- `tools/qemu/kernel-lifecycle.test.mjs` (19 tests) — kernel version
  detection, module-tree listing, the match assertion (accept/mismatch/
  no-modules), grub.cfg UUID parsing (ESP/legacy/none), GRUB generation
  (default + fallback + recovery, ESP and legacy), versioned-pair
  pruning, the rollback flip (success/skip/missing-pair), MOK signing
  atomicity + failure modes, state.json round-trip, and two applier-level
  tests (half pair aborts; kernel/modules mismatch aborts pre-extraction
  with no partial state).

## Manual QEMU acceptance (coordinator run)

On the VPS build box (`45.63.94.145`), in `/root/sevynos` at this
branch's head:

1. Build the image and boot media, then craft a feed that carries a
   kernel pair: `node tools/qemu/build.mjs` writes `updates.json` —
   confirm the `artifacts` array contains `vmlinuz` and `initramfs`
   entries with sha256/sizeBytes (requires `vmlinuz` +
   `initramfs.cpio.gz` in `tools/qemu/build/`).
2. Install to a disk image (UEFI, unattended) per
   docs/recovery.md §"Manual QEMU verification" step 2.
3. Stage an update: serve the build output over HTTP on the VM host,
   point the installed system's feed at it (or hand-place `pending.json`
   - `<version>/` payloads under `/var/lib/sevynos/updates/` with real
     sha256 values), then reboot and watch the serial log:
   * `SEVYN_KERNEL_UPDATE_VERIFYING`, `SEVYN_KERNEL_UPDATE: <old> -> <new>`
   * `SEVYN_KERNEL_UPDATE: recovery initramfs rebuilt for <new>`
   * `SEVYN_UPDATE_SNAPSHOT_DONE`, `SEVYN_KERNEL_UPDATE_APPLIED`
4. After boot: `/boot/vmlinuz-<new>` exists, the old pair is untouched,
   `grub.cfg` has 5 entries (default=new kernel, "previous kernel"
   fallback, recovery), `EFI/SevynOS/vmlinuz` matches the new kernel
   bytes, and `/var/lib/sevynos/updates/kernels.json` names both pairs.
5. Negative: stage a feed whose kernel version does not match the
   rootfs's `/lib/modules` — expect `SEVYN_UPDATE_ABORT` and no
   `/boot/vmlinuz-<new>`.
6. Rollback: from the GRUB menu pick "previous kernel" (boots), or
   trigger the boot-health path / recovery rollback and confirm
   `grub.cfg` flips the default back and the ESP staging follows.
7. Secure Boot (no real SB in QEMU): with a MOK present and a stub
   `sbsign` on PATH, confirm the staged kernel is signed before
   `SEVYN_KERNEL_UPDATE_APPLIED`; with a MOK present and no `sbsign`,
   expect the update to refuse (`refusing to install an unsigned
kernel`).

Unit level (no VM): `node --test tools/qemu/kernel-lifecycle.test.mjs`
and the `services/update` vitest suites above.
