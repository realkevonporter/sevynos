# SevynOS Update Rollback (Phase 3 B2)

Automatic recovery when an OS update leaves the system unable to reach a
healthy desktop. If the desktop never comes up for 3 consecutive boots,
the next boot's init restores the pre-update snapshot — using only the
snapshot, the boot-attempt counter, and busybox tooling. The new
(possibly broken) rootfs is never executed or trusted on the restore
path.

The snapshot slot is shared with the manual recovery environment's
"Roll Back Update" menu entry (`tools/qemu/recovery/.../rollback.sh`,
Phase 3 C1): one slot, two ways to trigger a restore (automatic on
boot-health failure, manual from recovery).

## How it works

**Pre-update snapshot.** The applier's `snapshot_previous`
(`tools/qemu/sevyn-apply-update.sh`), after the staged payload passes
sha256 verification and _before_ extracting it over `/`, captures the
running rootfs into `/var/lib/sevynos/updates/previous/` (`version.json`

- `rootfs.squashfs`, zstd). Exactly one generation is kept: each update
  replaces it. Best-effort: if the snapshot cannot be taken (too little
  free space, missing tooling), the update still proceeds and rollback
  reports that no snapshot is available for it.

**Trust.** The snapshot holds the previously-VERIFIED rootfs: the
running system was Ed25519 feed-signature-verified (Phase 3 B1) and
sha256-verified (download + the applier's pre-extraction gate) at the
moment it was applied. Two integrity layers guard the slot itself:
`version.json` records the snapshot's sha256 (verified by both the
recovery menu and the automatic path), and a tamper-evident pin at
`/var/lib/sevynos/update-trust/previous.sha256` (root-only 0700)
additionally guards the automatic path — the updates dir is
session-writable (the update service stages `pending.json` there;
Genesis writes `session-ready`), so a pin the session user cannot touch
is what stops a compromised session from planting an unverified payload
for init to restore. Rollback verifies before extracting and aborts —
fail closed — on mismatch. It never restores an unverified payload.

**Boot health.** `tools/qemu/sevyn-installed-init` (PID 1) sources
`tools/qemu/sevyn-boot-health.sh` and runs `sevyn_boot_health_check`
before anything else:

- counter at `/var/lib/sevynos/updates/boot-attempts`, incremented each
  boot and followed by `sync` (fsync-equivalent durability — a power cut
  right after boot must not lose the increment);
- if `session-ready` exists (written by Genesis on the first presented
  compositor frame, which also resets the counter), the marker is
  consumed and the counter reset;
- at `SEVYN_MAX_FAILED_BOOTS` (3) consecutive marker-less boots, init
  execs the applier in `rollback` mode.

3 is deliberate: it tolerates up to two transient bad boots in a row (a
flaky driver failing to probe, a hard power cut mid-boot, an interrupted
apply) without discarding a good update, while a genuinely broken update
still recovers within a few reboot cycles instead of leaving the machine
bricked. The check runs before the pending-update applier so a
boot-failure spiral rolls back instead of applying yet another untested
payload on top.

**Automatic rollback.** The applier's `rollback` mode: verifies the
snapshot (version.json sha256, plus the pin when present), moves a stale
`pending.json` aside (so the broken update is not re-applied in a
loop), preserves machine state, `unsquashfs -f -d /` the snapshot,
restores machine state, resets the counter, appends the event to
`rollback-history.jsonl`, and execs init. The snapshot is intentionally
NOT consumed: it stays in place for the manual recovery menu, which
shares the slot. If extraction fails, the counter is deliberately _not_
reset so the next boot retries the restore.

**History.** `/var/lib/sevynos/updates/rollback-history.jsonl`, one JSON
object per line: `{ts, event, fromVersion, toVersion, reason}`. Events:
`rollback`, `rollback-aborted` (verification failed — never restore an
unverified payload), `rollback-unavailable` (no snapshot),
`rollback-failed` (extraction failed; retried next boot). Rotated to the
most recent 20 entries. The Software Update UI (Settings → Software
Update) shows the last event: version / reason / date, via
`OsUpdateService.lastRollback()`.

## Serial markers (for QEMU logs)

- `SEVYN_BOOT_ATTEMPT count=N` — every boot without a prior marker
- `SEVYN_UPDATE_SNAPSHOT: …` / `SEVYN_UPDATE_SNAPSHOT_DONE version=…` /
  `SEVYN_UPDATE_NO_ROLLBACK: …` (applier snapshot, Phase 3 C1)
- `SEVYN_ROLLBACK_TRIGGERED attempts=3`
- `SEVYN_ROLLBACK_RESTORING from=… to=…` /
  `SEVYN_ROLLBACK_COMPLETE from=… to=…`
- `SEVYN_ROLLBACK_ABORTED reason=snapshot-verification-failed`
- `SEVYN_ROLLBACK_UNAVAILABLE reason=no-verified-snapshot`
- `SEVYN_ROLLBACK_FAILED reason=extraction-failed`
- `SEVYN_ROLLBACK_FAILED reason=kernel-flip-failed` — the rootfs was
  restored but the kernel pair could not flip back (Phase 3 B3 pairing);
  the counter is NOT reset, so the next boot retries the rollback
- `SEVYN_ROLLBACK_CLEARED_PENDING_UPDATE`
- `SEVYN_KERNEL_ROLLBACK_SKIP` / `SEVYN_KERNEL_ROLLBACK_FLIP` /
  `SEVYN_KERNEL_ROLLBACK_DONE` — kernel pair flip progress (Phase 3 B3;
  SKIP when the update was rootfs-only)

## Kernel pairing (Phase 3 B3)

The snapshot excludes `boot/*`, so restoring the rootfs alone would leave
the NEW kernel booting against the OLD modules — a bricked combination.
The applier therefore records the pre-update kernel pair in
`previous/kernels.json` before extracting, and `sevyn_rollback_restore`
flips the kernel back together with the rootfs
(`tools/qemu/kernel-lifecycle-lib.sh` → `sevyn_kernel_rollback_flip`):
grub.cfg is regenerated with the previous pair as the default entry (the
failed kernel becomes the "previous kernel" fallback), the ESP staging
and the `/boot` recovery image are refreshed from the previous pair, and
`updates/kernels.json` swaps current/previous. Full design:
`docs/kernel-lifecycle.md`.

## Manual QEMU verification (acceptance run)

Prerequisites: build the image on the VPS (`pnpm qemu:build` — the
Dockerfile picks up the new `tools/qemu/sevyn-boot-health.sh`), install
to a VM disk with the guided installer, boot the installed system.

### A. Healthy-boot bookkeeping

1. Boot the installed system; wait for the desktop.
2. In the guest (or via the serial log): after the first boot,
   `/var/lib/sevynos/updates/session-ready` exists and `boot-attempts`
   contains `0` (Genesis wrote the marker on the first presented frame).
3. Reboot. Early in the next boot the init consumes the marker:
   `session-ready` is gone, `boot-attempts` is still `0`.
4. Serial log shows `SEVYN_BOOT_ATTEMPT` only on boots where the marker
   was absent.

### B. Failed update → automatic rollback

1. On the healthy installed system, apply a _good_ update once (any
   update through Settings → Software Update, or stage one manually).
   After it applies, verify the snapshot:
   `ls -la /var/lib/sevynos/updates/previous/`,
   `cat /var/lib/sevynos/updates/previous/version.json`, and
   `(cd /var/lib/sevynos/update-trust && sha256sum -c previous.sha256)`.
   Note the current version: `cat /etc/sevynos-release`.
2. Build a _bad_ rootfs: copy the installed rootfs, break desktop
   startup deterministically (e.g. rename
   `/opt/sevynos/genesis-wayland.mjs` so `start-genesis` can never
   launch Genesis), `mksquashfs` it, compute its sha256, and write
   `/var/lib/sevynos/updates/pending.json`:
   `{"version":"9.9.9-bad","payloadPath":"/var/lib/sevynos/updates/9.9.9-bad/rootfs.squashfs","sha256":"<hex>","sizeBytes":<n>,"stagedAt":"…"}`.
3. Reboot. The applier verifies the payload, snapshots the good system
   (`SEVYN_UPDATE_SNAPSHOT_DONE`), extracts the bad rootfs. The desktop
   never comes up → no `session-ready` → `boot-attempts` becomes `1`.
4. Power-cycle the VM twice more (hard reset is fine — it also proves
   the counter survives unclean shutdowns). After the 2nd cycle the
   counter is `2`; on the 3rd boot the serial log shows
   `SEVYN_ROLLBACK_TRIGGERED attempts=3`, then
   `SEVYN_ROLLBACK_RESTORING from=9.9.9-bad to=<good version>` and
   `SEVYN_ROLLBACK_COMPLETE`.
5. The VM now boots the _good_ system: desktop comes up, `session-ready`
   is written, counter resets to `0`.
6. Verify the history:
   `cat /var/lib/sevynos/updates/rollback-history.jsonl` — one
   `rollback` event with `fromVersion`, `toVersion`, `reason`, `ts`.
   The snapshot stays in place for the manual recovery menu.
7. Open Settings → Software Update: the "Last rollback" card shows the
   restored version, the reason, and the date.
8. Confirm no re-apply loop: the bad `pending.json` was moved to
   `failed-<timestamp>.json`; the system does not try to apply it again.

### C. Tamper-evidence (pin mismatch)

1. On a healthy system with a snapshot, corrupt one byte of
   `/var/lib/sevynos/updates/previous/rootfs.squashfs`
   (e.g. `printf 'X' | dd of=… bs=1 seek=100 conv=notrunc`).
2. Force the counter to the threshold: `echo 2 >
/var/lib/sevynos/updates/boot-attempts`, remove any `session-ready`,
   reboot.
3. The serial log shows `SEVYN_ROLLBACK_ABORTED
reason=snapshot-verification-failed`; the system boots best-effort
   (no extraction attempted), and the history gains a
   `rollback-aborted` event. The tampered snapshot is left in place for
   forensics — it is never restored.

### D. No snapshot → no rollback, no brick

1. On a system with no snapshot (`rm -rf
/var/lib/sevynos/updates/previous`), set the counter to `2`, reboot.
2. Serial shows `SEVYN_ROLLBACK_UNAVAILABLE reason=no-verified-snapshot`;
   history gains `rollback-unavailable`; the counter resets to `0` and
   boot proceeds normally.
