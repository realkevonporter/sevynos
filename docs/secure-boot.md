# SevynOS Secure Boot — assessment and design

**Status (2026-10-07): assessed, install-time tooling implemented, end-to-end NOT verified.
SevynOS does NOT claim Secure Boot support in any user-facing surface until the
full chain is verified on real hardware with Secure Boot enabled.**

Related: `tools/qemu/sevyn-secure-boot.sh` (install-time helper),
`tools/qemu/verify-secure-boot.sh` (chain verification),
installer screens in `tools/qemu/sevyn-installer.sh`.

---

## 1. Threat model

Secure Boot protects the boot chain against a specific class of attacker: someone
who can modify the bootloader, kernel, or early-boot binaries on disk (evil maid,
a bootkit written by malware with admin access, a tampered install image) but
cannot modify the machine's firmware NVRAM. It is a signature check, not
encryption: each stage verifies the next stage's signature against keys enrolled
in the firmware (the `db` key database).

The chain we want:

```
firmware db  →  shim (Microsoft-signed)  →  MOK db  →  GRUB EFI binary
→  kernel (vmlinuz)  →  recovery kernel
```

Each arrow is a signature verification. Breaking any arrow breaks the guarantee.
A signed kernel does nothing if the bootloader that loads it is unsigned and the
firmware lets it run anyway.

Out of scope for this phase: signing kernel modules, signing the initramfs,
GRUB's own module/config verification, measured boot / TPM attestation, and full
disk encryption (separate workstreams).

## 2. Why there is no Microsoft-signed shim for SevynOS (yet)

Most Linux distributions boot on Secure Boot-enabled PCs through a small first-stage
loader called **shim**, which IS signed by Microsoft's UEFI CA (a key already in
virtually every PC's firmware `db`). Shim then enforces its own policy: it boots
the distro's GRUB if GRUB is signed by a key in shim's Machine Owner Key (MOK)
database, which the machine's owner controls.

Getting our own shim signed by Microsoft is not a technical step — it is a
**signing relationship**:

1. Microsoft's UEFI signing program requires an **Extended Validation (EV) code
   signing certificate** from an approved certificate authority. EV certificates
   are issued only to legally registered organizations (company, LLC, nonprofit…)
   — **an individual cannot obtain one**.
2. The shim binary itself goes through Microsoft's **shim review process**:
   public source code, a published security contact, and weeks-to-months of review
   by the shim maintainers and Microsoft.
3. Every future shim change that affects the security boundary re-enters review.

SevynOS is currently Kevon's independent project with no legal entity and no EV
certificate, so this route is unavailable today. It is the correct long-term
route for a shipping OS (it is the only way to boot on a stock Secure Boot PC
with zero firmware changes), but it is a **business/legal decision, not an
engineering task**.

> **BLOCKED ON KEVON:** Do you want to pursue Microsoft shim signing? That
> requires forming a legal entity, obtaining an EV code signing certificate
> (~$400+/yr from an approved CA), and submitting our shim through the public
> review process. Until then, the MOK path below only works on machines where the
> owner enrolls our key themselves (see §4).

Borrowing another distro's signed shim (e.g. Ubuntu's) is not an option: a
distro's shim only trusts that distro's GRUB signing key, and re-signing their
shim would invalidate Microsoft's signature.

## 3. The realistic path: Machine Owner Key (MOK)

The MOK database is the part of the trust chain the machine's owner controls.
The realistic SevynOS design, implemented in this phase:

1. **At install time**, on the target machine, generate a dedicated SevynOS MOK:
   a 4096-bit RSA keypair with a self-signed X.509 certificate
   (`tools/qemu/sevyn-secure-boot.sh generate-mok`).
2. **Sign** the installed GRUB EFI binary, the kernel, and the ESP-staged
   recovery kernel (`/boot/efi/EFI/SevynOS/vmlinuz`, staged by C1's
   `deploy_recovery`) with `sbsign` using that key
   (`sevyn-secure-boot.sh sign`).
3. **Queue the MOK for enrollment** with `mokutil --import`. This writes the key
   to the firmware's `MOKNew` variable and schedules shim's **MOK Manager** to run
   on the next boot. Enrollment **requires physical presence at the machine and
   cannot be automated** — that is the entire security point (a remote attacker
   who compromised the OS must not be able to enroll their own key silently).
4. The user completes the one-time enrollment at the MOK Manager screen
   (exact steps in §5, shown by the installer).

After enrollment, with a Microsoft-signed shim in the boot chain: firmware
verifies shim (Microsoft CA in `db`), shim offers MOK enrollment and verifies
GRUB against the enrolled MOK, and our signed GRUB/kernel load on a
Secure Boot-enabled machine.

### 3.1. The shim prerequisite — stated plainly

`mokutil` and the MOK Manager are **part of shim**. Without a Microsoft-signed
shim in the boot path, `mokutil --import` has nothing to talk to and there is no
MOK Manager screen. The tooling in this phase implements the key generation,
signing, and enrollment-queueing machinery so it is ready the day a signed shim
exists — but until §2 is resolved, there are only two ways to boot SevynOS on a
Secure Boot machine:

- **(a)** The machine owner puts the firmware in Setup Mode and enrolls the
  SevynOS MOK certificate directly into the firmware `db` (manual firmware-setup
  steps; no shim needed), or
- **(b)** Secure Boot stays **off** (signing is then inert but harmless — the
  signatures are still produced and verifiable with `sbverify`).

The installer detects the situation and tells the user which case applies. We do
not pretend otherwise anywhere user-facing.

## 4. Key custody

- The MOK private key lives at `/var/lib/sevyn/secureboot/MOK.priv`, owned by
  root, mode `0600`. The certificate is stored alongside as `MOK.pem` (PEM) and
  `MOK.der` (DER, for `mokutil --import`).
- **Anyone holding `MOK.priv` can sign arbitrary bootloaders and kernels that
  Secure Boot will accept on this machine.** Treat it like a root password:
  anyone with read access to the installed system as root can already do worse,
  but the key must be included in the user's backup set — **if it is lost, future
  kernel updates cannot be signed** (see §7) and the machine can no longer boot
  with Secure Boot on after the next kernel update.
- The MOK enrollment password (needed once, at the MOK Manager screen) is
  generated by the installer, shown to the user on the enrollment screen, and
  stored at `/var/lib/sevyn/secureboot/mok-enrollment-password` (0600) only
  until enrollment completes; the OS-side enrollment check deletes it afterwards.
- Key-custody policy (per-machine generated keys vs. one project-wide key,
  backup/rotation procedure) is a product decision:

> **BLOCKED ON KEVON:** Confirm the key-custody model. Current implementation:
> one freshly generated MOK per installation (maximum isolation between
> machines; a leaked key compromises one machine only). Alternative: a single
> project-wide SevynOS MOK signed at build time (simpler updates, but one leak
> compromises every install — and whoever holds that master key must be a legal
> entity you trust with it, which today is just you).

## 5. What the user must do at the enrollment reboot (MOK Manager steps)

The installer shows these steps on screen after installation. They run in shim's
MOK Manager — a simple blue/grey text-mode menu that appears automatically on the
first reboot after `mokutil --import`:

1. Reboot the machine when the installer tells you to. Instead of booting
   normally, the firmware launches **MOK management** (shim's MokManager).
2. Select **"Enroll MOK"** and press Enter.
3. Select **"View key 0"** (optional but recommended) and confirm the certificate
   details match what the installer showed you — issuer `CN=SevynOS Machine
Owner Key` and the SHA256 fingerprint printed on the installer's enrollment
   screen. If they do not match, select "Back" and do NOT enroll.
4. Select **"Continue"**.
5. When asked **"Enroll the key(s)?"**, select **"Yes"** and press Enter.
6. Enter the **MOK enrollment password** the installer displayed (you will type
   it blind — there is no visual feedback; press Enter when done).
7. Select **"Reboot"**. SevynOS now boots with the enrolled key.

Notes for the user, printed on the same screen:

- You need a **physical keyboard** attached. This cannot be done over remote
  desktop / SSH — physical presence is a deliberate anti-malware property.
- If you mistype the password, MOK Manager returns to the menu; select
  "Enroll MOK" and try again. The queued key is discarded after a few failed
  attempts, in which case re-run `mokutil --import` from the installed system
  and reboot again.
- If your machine instead boots straight into SevynOS with no MOK screen, your
  firmware either has Secure Boot off (nothing to do) or no signed shim is
  installed (see §3.1) — check **Settings → System → Secure Boot** (hook point)
  or run `tools/qemu/verify-secure-boot.sh`.

## 6. What was implemented (Phase 3, Worker C2)

Automatable, no false claims:

- `tools/qemu/sevyn-secure-boot.sh` — install-time helper executed inside the
  target chroot by `sevyn-installer-chroot.sh`:
  - `generate-mok` — creates the RSA-4096 keypair + self-signed cert
    (`/var/lib/sevyn/secureboot/`), 0600 on the private key.
  - `sign` — `sbsign`s the installed GRUB EFI binaries
    (`/boot/efi/EFI/SevynOS/grubx64.efi` and the `EFI/BOOT/BOOTX64.EFI`
    fallback copy), `/boot/vmlinuz`, and the ESP-staged recovery kernel
    (`/boot/efi/EFI/SevynOS/vmlinuz`, staged by C1's `deploy_recovery`).
  - `queue-enrollment` — attempts `mokutil --import` of the DER certificate with
    the generated enrollment password; records the outcome in
    `/var/lib/sevyn/secureboot/state.json` for the OS and the verification tool:
    `enrollment` is `queued` / `manual-required` / `not-applicable`, with
    `enrollmentReason` `no-mokutil` / `no-uefi` explaining the latter two.
  - `status` — prints the state file for diagnostics.
  - Every step degrades gracefully when its tool is missing (`sbsign`,
    `mokutil`): it logs, records the state, and continues the install — a
    missing tool must never brick an installation.
- `tools/qemu/verify-secure-boot.sh` — verification tooling. Given an installed
  system root, it reports the chain status: keypair present with correct
  permissions, `sbverify` over each signed artifact against the MOK certificate,
  enrollment state from `state.json` / `mokutil --list-enrolled`, and firmware
  Secure Boot state from efivars when available.
- Installer screens (`tools/qemu/sevyn-installer.sh`): after installation, when
  UEFI was detected, a **"Secure Boot — one-time key enrollment"** screen shows
  the MOK fingerprint, the enrollment password, and the exact MOK Manager steps
  from §5. When Secure Boot tooling is absent or the firmware is in legacy/BIOS
  mode, the screen explains why enrollment does not apply.
- `tools/qemu/secure-boot.test.mjs` — tests for the helper's key-generation
  layout, permission handling, graceful degradation without `sbsign`/`mokutil`,
  and the verification script's reporting.

## 7. Kernel updates must re-sign (hook point for Worker B3)

A kernel update replaces `/boot/vmlinuz` — the signature on the old binary does
not transfer. **Every kernel update must re-run the equivalent of
`sevyn-secure-boot.sh sign` with the machine's MOK before the new kernel is
installed into `/boot`**, or the machine will fail to boot with Secure Boot
enabled after the update. The recovery kernel (`/boot/efi/EFI/SevynOS/vmlinuz`,
staged on the ESP by C1's `deploy_recovery`) has the same requirement. The signing helper is deliberately a
standalone script so the update service (B3) can call it as a post-install hook;
`state.json` records which artifacts were last signed and with which key
fingerprint so the updater can detect a key mismatch (e.g. key restored from an
old backup) and refuse to ship an unbootable update.

## 8. Honesty log — what is NOT claimed

- SevynOS does **not** support Secure Boot end to end today. The chain is
  implemented up to the firmware boundary; the Microsoft-signed shim (§2) does
  not exist and no full boot has been observed on Secure Boot-enabled hardware.
- QEMU cannot validate this: the sandbox has no KVM and TCG software emulation
  does not implement Secure Boot. Verification here is `sbverify` over the
  installed artifacts plus installer-flow correctness.
- No user-facing surface (docs, installer text, release notes, Settings UI) may
  claim Secure Boot support until the chain is verified on real hardware.

> **BLOCKED ON KEVON:** Real-hardware validation — boot an installed system on a
> physical machine with Secure Boot enabled, complete the MOK Manager enrollment
> (§5), and confirm the signed GRUB/kernel load. Only after that passes may any
> user-facing surface claim Secure Boot support.
