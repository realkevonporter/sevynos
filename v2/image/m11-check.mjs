// M11 check: prove the dual-boot installer (Kevon, 2026-11-10:
// SevynOS installs ALONGSIDE Windows 11 without wiping it) and
// the installer-v2 modes (Kevon, 2026-11-12: any disk, whole-disk
// format, portable USB install).
//
//   0. Host gate (on the CI host, before QEMU): v2/update/
//      test-install.py (host checks: probe/plan/install/status
//      against mock Windows, Linux, empty and USB disks) +
//      v2/update/test-updated.py (the updater's dual-boot changes:
//      SEVYNESP discovery, other-OS-entry preservation, PARTUUID
//      pinning). Exit 0 = pass.
//   1. Regression boot (-kernel/-initrd + a data disk): the M9
//      stack still intact (SEVYNOS_M5_READY, M4.5 ready, Terminal
//      launches) and the Installer app is registered — a headless
//      `app run installer` renders the disk picker with the
//      "No disk available to install onto." state (the boot disk
//      is the only disk here).
//   2. UEFI live boot + mock Windows disk 1 (Windows ESP + NTFS +
//      free space): `sevyn install probe/plan/install --yes`
//      in-guest; host-side proof the Windows partitions are
//      byte-identical, the new SevynOS ESP + data partitions exist,
//      grub.cfg lists SevynOS + Windows 11 with a
//      sevyn.data=PARTUUID= pin, the slot layout landed, and the
//      UEFI boot entry was created first in BootOrder. The wizard
//      auto-picks the single installable disk and renders its plan
//      ("Install SevynOS alongside Windows").
//   3. UEFI boot, target disk 1 only: the GRUB menu lists both
//      entries (rendered on serial for the harness); the default
//      boot reaches the shell with /data on the new partition via
//      sevyn.data=PARTUUID=; QMP system_reset, select the Windows
//      entry, and the mock Windows bootloader (a GRUB binary built
//      with an embedded serial config, standing in for
//      bootmgfw.efi) prints MOCK_WINDOWS_BOOTMGR_REACHED on serial
//      — the chainload path executes the Windows bootloader.
//   4. UEFI live boot + mock Windows disk 2 (Windows + OLD SevynOS,
//      no free space): probe finds the old install; plan offers
//      replace; install --target <old-part> --yes; Windows untouched,
//      old SevynOS partitions gone.
//   5. UEFI boot, target disk 2 only: menu lists both; default boot
//      reaches the shell.
//   6. Installer v2 — UEFI live boot + a mock Linux disk (Ubuntu
//      ESP + ext4 root + free space), an empty disk (no partition
//      table), and a USB stick (usb-storage): probe lists all three
//      (Linux detected, USB removable); plan beside-Linux and plan
//      whole-disk-on-empty succeed; plan on the boot disk refuses;
//      `install --target portable` on the stick succeeds; host-side
//      proof the Linux partitions and the stick's old partition are
//      byte-identical, the stick carries a SevynOS-only grub.cfg +
//      the fallback BOOTX64.EFI + the slot layout, and the wizard
//      renders the disk picker ("Choose a disk") with several
//      disks to choose from.
//   7. Installer v2 — UEFI boot from the USB stick alone (fresh
//      firmware variables, so no NVRAM entry exists): the GRUB menu
//      lists SevynOS, the default boot reaches the shell with
//      /data on the stick's data partition — the portable install
//      boots on its own.
//   8. Fallback (updater ESP discovery on a dual-boot disk): the
//      slot state on target 1 is tampered (attempts=2, active=B,
//      good=A); the daemon restores the ESP from the good slot —
//      which must be the SEVYNESP (partition 3), not the Windows
//      ESP (partition 1) — and reboots; host-side proof the
//      restored grub.cfg still lists Windows 11 with the PARTUUID
//      pin and the Windows ESP is byte-identical; a post-restore
//      boot reaches the shell clean.
//
// QEMU has no Windows: the mock disks stand in for it. The mock
// bootmgfw.efi is an unsigned GRUB binary (grub-mkimage with an
// embedded config that echoes a marker on serial); a real Windows
// bootmgfw.efi is Microsoft-signed and the chainload path is the
// same. What QEMU cannot prove — a real Windows 11 actually
// booting from the chainloader entry, and real firmware boot-order
// behaviour — is Kevon's GF65 verification after merge.
// The fixture disks are built by v2/image/make-mock-windows-disk.py
// (windows-free / windows-oldsevyn / linux-free / empty / usb-free
// layouts); the live image's grub.cfg is pinned with
// sevyn.data=PARTUUID=<live p2 uuid> for the live boots so /data
// always mounts from the live image even when the target disk
// carries its own SEVYN_DATA partition, and restored before the
// check exits. PARTUUID, not a /dev/nvmeNn1 path: the guest kernel
// enumerates the two NVMe controllers in either order across boots,
// so a device path is not stable.
//
// Usage: node v2/image/m11-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M11_TIMEOUT (seconds, default 12600 — nine boots),
//      SEVYN_V2_SYSROOT (default / — the OVMF files live under
//      $SYSROOT/usr/share/OVMF),
//      SEVYN_V2_OVMF_CODE / SEVYN_V2_OVMF_VARS (OVMF firmware paths;
//      default the secboot CODE + the Microsoft-keys VARS).
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m11-data.img");
const IMAGE = join(OUT, "sevynos.img");
const TARGET1 = join(OUT, "m11-target1.img");
const TARGET2 = join(OUT, "m11-target2.img");
// Installer v2 fixtures: a mock Linux disk, an empty disk (no
// partition table), and a USB stick (attached via usb-storage, so
// the guest sees a real removable /dev/sda).
const TARGET3 = join(OUT, "m11-target3.img");
const USBSTICK = join(OUT, "m11-usbstick.img");
const EMPTYDISK = join(OUT, "m11-empty.img");
// In-guest /dev/disk/by-id names for the target disks. The QEMU
// NVMe serials (sevynos0 / target1 / target2, set in boot()) make
// these stable across boots; the guest kernel enumerates the two
// NVMe controllers in either order (nvme0/nvme1 swap), so a
// /dev/nvmeNn1 path is NOT stable. The installer canonicalizes a
// by-id path to the real device via realpath().
const TARGET1_BYID = "/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_target1";
const TARGET2_BYID = "/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_target2";
const TARGET3_BYID = "/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_target3";
const EMPTY_BYID = "/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_empty1";
const BOOT_BYID = "/dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_sevynos0";
// The USB stick: the guest kernel names the first usb-storage
// device /dev/sda (no other sd devices are attached).
const USB_DEV = "/dev/sda";
const MOCK_EFI = join(OUT, "mock-bootmgfw.efi");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M11_TIMEOUT || 12600);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";
const SYSROOT = process.env.SEVYN_V2_SYSROOT || "/";
const OVMF_CODE =
  process.env.SEVYN_V2_OVMF_CODE ||
  join(SYSROOT, "usr/share/OVMF/OVMF_CODE_4M.secboot.fd");
const OVMF_VARS =
  process.env.SEVYN_V2_OVMF_VARS || join(SYSROOT, "usr/share/OVMF/OVMF_VARS_4M.ms.fd");
// Non-Secure-Boot firmware, used ONLY for the mock-Windows
// chainload test: the mock bootmgfw.efi is an unsigned GRUB binary
// standing in for the real (Microsoft-signed) Windows bootloader,
// and shim rejects an unsigned chainloaded binary ("bad shim
// signature") when Secure Boot is on. The chainload test proves
// the GRUB Windows entry executes the bootloader; Secure Boot
// verification of the mock is a test artifact, not a product
// issue — the real bootmgfw.efi is Microsoft-signed and passes.
// Every other boot runs under the secboot firmware above.
const OVMF_CODE_NOSECBOOT = join(SYSROOT, "usr/share/OVMF/OVMF_CODE_4M.fd");
const OVMF_VARS_NOSECBOOT = join(SYSROOT, "usr/share/OVMF/OVMF_VARS_4M.fd");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
let currentBoot = null;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function readLog(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function logLines(path) {
  // The serial console writes CRLF; strip the trailing \r so
  // end-anchored patterns (e.g. the ops JSON) match.
  return readLog(path)
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

async function waitForLog(path, pattern, timeoutMs, sinceLines = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = logLines(path).slice(sinceLines);
    const hit = lines.find((l) => pattern.test(l));
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

// --- QMP client ---
class QMP {
  constructor(path) {
    this.path = path;
    this.buf = "";
    this.waiters = [];
    this.sock = net.connect(path);
    this.sock.on("data", (d) => {
      this.buf += d.toString();
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.event) continue;
        const w = this.waiters.shift();
        if (w) w(msg);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.sock.once("connect", resolve);
      this.sock.once("error", reject);
    });
  }
  execute(cmd, args) {
    return new Promise((resolve, reject) => {
      this.waiters.push((msg) => {
        if (msg.error) reject(new Error(`${cmd}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.return);
      });
      this.sock.write(JSON.stringify({ execute: cmd, arguments: args }) + "\n");
    });
  }
  async capabilities() {
    await sleep(300);
    await this.execute("qmp_capabilities");
  }
  async input(events) {
    await this.execute("input-send-event", { events });
  }
  close() {
    this.sock.destroy();
  }
}

// --- boot ---
// mode "kernel": -kernel/-initrd + the data disk on virtio (the
// regression boot). mode "uefi": OVMF Secure Boot firmware + the
// boot image on NVMe (nvme0) + optional extra drives (nvme1, ...).
// opts.image overrides the boot image (a target disk boots alone);
// opts.extraDrives is [{ file, id }] attached as further NVMe
// devices; opts.usbDrives is [{ file, id }] attached as USB
// storage devices (the guest sees them as removable /dev/sdX).
// The live boots pass the target disk as an extra drive;
// the target-alone boots pass the target as the image.
async function boot(tag, opts = {}) {
  const mode = opts.mode || "kernel";
  const uefi = mode === "uefi";
  const image = opts.image || IMAGE;
  const logPath = join(OUT, uefi ? `m11-uefi-boot-${tag}.log` : `m11-boot-${tag}.log`);
  // Archive the previous run's log before overwriting.
  try {
    if (existsSync(logPath) && statSync(logPath).size > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(
        logPath,
        join(
          OUT,
          uefi ? `m11-uefi-boot-${tag}-${stamp}.log` : `m11-boot-${tag}-${stamp}.log`,
        ),
      );
    }
  } catch {}
  writeFileSync(logPath, "");
  // Synchronous appends, not a piped write stream: a stream buffers
  // in userspace, so readFileSync (which waitForLog polls) could not
  // see a line for minutes while the guest was idle.
  const logFd = openSync(logPath, "w");
  const appendLog = (chunk) => {
    try {
      writeSync(logFd, chunk);
    } catch {}
  };
  const ctlSock = join(OUT, `m11-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m11-${tag}-appd.sock`);
  const updSock = join(OUT, `m11-${tag}-upd.sock`);
  const aidSock = join(OUT, `m11-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m11-${tag}-qmp.sock`);
  // QEMU writes the NVRAM variables, so the UEFI boot gets a fresh
  // copy of the VARS file per run (never the shared original).
  // opts.firmware === "nosecboot" selects the non-Secure-Boot
  // firmware pair (chainload test only — see the constants above).
  const ovmfCode = opts.firmware === "nosecboot" ? OVMF_CODE_NOSECBOOT : OVMF_CODE;
  const ovmfVars = opts.firmware === "nosecboot" ? OVMF_VARS_NOSECBOOT : OVMF_VARS;
  let varsCopy = null;
  if (uefi) {
    if (!existsSync(ovmfCode)) {
      throw new Error(`OVMF code not found: ${ovmfCode}`);
    }
    if (!existsSync(ovmfVars)) {
      throw new Error(`OVMF vars not found: ${ovmfVars}`);
    }
    varsCopy = join(OUT, `m11-uefi-vars-${tag}.fd`);
    // varsFrom reuses a previous boot's NVRAM (the installer's
    // BootOrder lives there): the target-alone boots reuse the live
    // boot's vars, like real firmware keeping its variables.
    copyFileSync(opts.varsFrom || ovmfVars, varsCopy);
  }
  const args = ["-machine", `q35,accel=${ACCEL}`, "-m", "4096", "-smp", "2"];
  if (uefi) {
    args.push(
      "-drive",
      `if=pflash,format=raw,unit=0,file=${ovmfCode},readonly=on`,
      "-drive",
      `if=pflash,format=raw,unit=1,file=${varsCopy}`,
      "-drive",
      `file=${image},format=raw,if=none,id=nvme0`,
      "-device",
      "nvme,drive=nvme0,serial=sevynos0",
    );
    (opts.extraDrives || []).forEach((d, i) => {
      const n = i + 1;
      // The serial is the disk's stable by-id identity — it must
      // come from the DRIVE (d.serial), not the attachment index:
      // live1 attaches TARGET1 as the only extra drive (n=1) and
      // live2 attaches TARGET2 as the only extra drive (also n=1),
      // so an index-based serial would name BOTH disks "target1"
      // and live2's by-id ..._target2 would not exist (probe fails
      // "file does not exist"). d.serial is explicit per disk.
      args.push(
        "-drive",
        `file=${d.file},format=raw,if=none,id=nvme${n}`,
        "-device",
        `nvme,drive=nvme${n},serial=${d.serial || `target${n}`}`,
      );
    });
    // USB sticks: usb-storage on the xhci controller, which must be
    // created BEFORE any usb-storage device — QEMU resolves the usb
    // bus at device-creation time, so a later -device qemu-xhci is
    // too late ("No 'usb-bus' bus found"). removable=on: real USB
    // sticks report themselves removable, and the portable install
    // requires a removable drive; QEMU defaults removable to off.
    // The guest sees a removable SCSI disk.
    args.push("-device", "qemu-xhci");
    (opts.usbDrives || []).forEach((d, i) => {
      args.push(
        "-drive",
        `file=${d.file},format=raw,if=none,id=usb${i}`,
        "-device",
        `usb-storage,drive=usb${i},removable=on`,
      );
    });
  } else {
    args.push(
      "-kernel",
      join(OUT, "vmlinuz"),
      "-initrd",
      join(OUT, "initramfs.cpio.gz"),
      "-append",
      "console=ttyS0 sevyn.slot=A",
    );
  }
  args.push(
    "-display",
    "none",
    "-vga",
    "none",
    "-monitor",
    "none",
    "-serial",
    "stdio",
    "-chardev",
    `socket,id=ctl,path=${ctlSock},server=on,wait=off`,
    "-device",
    "isa-serial,chardev=ctl",
    "-chardev",
    `socket,id=appd,path=${appdSock},server=on,wait=off`,
    "-device",
    "isa-serial,chardev=appd",
    "-chardev",
    `socket,id=upd,path=${updSock},server=on,wait=off`,
    "-device",
    "isa-serial,chardev=upd",
    "-chardev",
    `socket,id=aid,path=${aidSock},server=on,wait=off`,
    "-device",
    "pci-serial,chardev=aid",
    "-chardev",
    `socket,id=qmp,path=${qmpSock},server=on,wait=off`,
    "-mon",
    "chardev=qmp,mode=control",
  );
  if (!uefi) {
    args.push("-drive", `file=${DISK},format=raw,if=virtio`);
  }
  args.push("-device", "virtio-gpu-pci,xres=1920,yres=1080");
  if (!uefi) {
    // UEFI boots got their xhci controller up in the drive block,
    // before the usb-storage devices; kernel boots need one here
    // for the usb-tablet.
    args.push("-device", "qemu-xhci");
  }
  args.push("-device", "usb-tablet", "-nic", "user,model=virtio-net-pci", "-no-reboot");
  const qemu = spawn(QEMU, args, { stdio: ["ignore", "pipe", "pipe"] });
  qemu.stdout.on("data", appendLog);
  qemu.stderr.on("data", appendLog);
  const b = {
    tag,
    qemu,
    logPath,
    logFd,
    ctlSock,
    appdSock,
    updSock,
    aidSock,
    qmpSock,
    varsCopy,
    exited: false,
    ctl: null,
    appd: null,
    upd: null,
    aid: null,
    qmp: null,
  };
  qemu.on("exit", () => {
    b.exited = true;
  });
  currentBoot = b;
  return b;
}

function waitForSocketFile(path, timeoutMs = 30000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await sleep(200);
    }
    return false;
  })();
}

async function connectSockets(b) {
  const qmpPath = join(OUT, `m11-${b.tag}-qmp.sock`);
  if (!(await waitForSocketFile(qmpPath))) {
    throw new Error(`QMP socket never appeared: ${qmpPath}`);
  }
  let qmp = null;
  const deadline = Date.now() + 30000;
  for (;;) {
    qmp = new QMP(qmpPath);
    try {
      await qmp.ready();
      break;
    } catch (e) {
      try {
        qmp.close();
      } catch {}
      if (Date.now() >= deadline) throw e;
      await sleep(200);
    }
  }
  await qmp.capabilities();
  b.qmp = qmp;
  const connect = async (path) => {
    if (!(await waitForSocketFile(path))) {
      throw new Error(`control socket never appeared: ${path}`);
    }
    const deadline2 = Date.now() + 10000;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const s = net.connect(path);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
      } catch (e) {
        if (Date.now() >= deadline2) throw e;
        await sleep(200);
      }
    }
  };
  b.ctl = await connect(join(OUT, `m11-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m11-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m11-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m11-${b.tag}-aid.sock`));
}

async function waitExit(b, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (b.exited) return true;
    await sleep(500);
  }
  return b.exited;
}

function closeBoot(b) {
  try {
    b.qmp?.close();
  } catch {}
  for (const s of [b.ctl, b.appd, b.upd, b.aid]) {
    try {
      s?.destroy();
    } catch {}
  }
  try {
    b.qemu.kill("SIGKILL");
  } catch {}
  try {
    if (b.logFd !== undefined) closeSync(b.logFd);
  } catch {}
}

// Drive appd over its control serial; replies arrive as APPD log
// lines on the console (the boot log).
async function appdCmd(b, cmd, pattern, timeoutMs = 15000) {
  const before = logLines(b.logPath).length;
  b.appd.write(cmd + "\n");
  return waitForLog(b.logPath, pattern, timeoutMs, before);
}

// --- Terminal input helpers (QMP input-send-event, as m5-check) ---
async function keyDown(qmp, qcode) {
  await qmp.input([
    { type: "key", data: { down: true, key: { type: "qcode", data: qcode } } },
  ]);
}
async function keyUp(qmp, qcode) {
  await qmp.input([
    { type: "key", data: { down: false, key: { type: "qcode", data: qcode } } },
  ]);
}
async function keyTap(qmp, qcode) {
  await keyDown(qmp, qcode);
  await sleep(120);
  await keyUp(qmp, qcode);
}
const QCODE_FOR = {
  " ": "spc",
  "/": "slash",
  ".": "dot",
  "-": "minus",
  ";": "semicolon",
};
const SHIFT_QCODE_FOR = {
  ":": "semicolon",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  "=": "equal",
  _: "minus",
  "+": "equal",
  "?": "slash",
};
for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") QCODE_FOR[c] = c;
async function typeText(qmp, text) {
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") {
      await keyDown(qmp, "shift");
      await keyTap(qmp, ch.toLowerCase());
      await keyUp(qmp, "shift");
    } else if (SHIFT_QCODE_FOR[ch]) {
      await keyDown(qmp, "shift");
      await keyTap(qmp, SHIFT_QCODE_FOR[ch]);
      await keyUp(qmp, "shift");
    } else if (QCODE_FOR[ch]) {
      await keyTap(qmp, QCODE_FOR[ch]);
    } else {
      throw new Error(`typeText: no qcode for ${JSON.stringify(ch)}`);
    }
    await sleep(180);
  }
}

// Type a command into the Terminal and wait for its EXEC line with
// exit 0. The command's own stdout renders to the Terminal window,
// never to the serial log — only the exit code is harness-visible.
async function termCmd(b, cmd, timeoutMs = 180000) {
  await typeText(b.qmp, cmd);
  await keyTap(b.qmp, "ret");
  const esc = cmd.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = await waitForLog(
    b.logPath,
    new RegExp(`EXEC sevyn ${esc}.* -> 0`),
    timeoutMs,
    0,
  );
  return hit;
}

// Same, but assert a specific exit code.
async function termCmdCode(b, cmd, code, timeoutMs = 180000) {
  await typeText(b.qmp, cmd);
  await keyTap(b.qmp, "ret");
  const esc = cmd.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = await waitForLog(
    b.logPath,
    new RegExp(`EXEC sevyn ${esc}.* -> ${code}`),
    timeoutMs,
    0,
  );
  return hit;
}

// The headless host logs one `HOST headless ops {json}` line per
// screen (texts + pressable rects). Return the latest one.
function latestOps(b, sinceLines = 0) {
  const lines = logLines(b.logPath).slice(sinceLines);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/HOST headless ops (\{.*\})$/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        continue;
      }
    }
  }
  return null;
}

// Wait until the latest PARSED ops snapshot contains `text`.
// The ops lines flush asynchronously and a long snapshot can land
// in the log in two chunks: a plain log grep (waitForLog) can hit
// the first chunk while latestOps still sees only the previous
// (loading-shell) snapshot, because the JSON is not complete yet.
// Polling the parsed snapshot closes that hole.
async function waitForOpsText(b, sinceLines, text, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let ops = null;
  let texts = [];
  while (Date.now() < deadline) {
    ops = latestOps(b, sinceLines);
    texts = (ops?.texts || []).map((t) => t.t);
    if (texts.includes(text)) return { ops, texts };
    await sleep(500);
  }
  return { ops, texts };
}

function textCenter(ops, text) {
  const t = (ops?.texts || []).find((t) => t.t === text);
  if (!t) return null;
  return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
}

// --- host-side disk helpers ---
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function partRange(disk, partNum) {
  const out = await execAsync("sgdisk", ["-p", disk]);
  const line = out.split("\n").find((l) => new RegExp(`^\\s*${partNum}\\s`).test(l));
  if (!line) throw new Error(`sgdisk: no partition ${partNum} in ${disk}`);
  const cols = line.trim().split(/\s+/);
  const start = Number(cols[1]);
  const end = Number(cols[2]);
  if (!start || !end || end < start) throw new Error(`sgdisk: bad range: ${line}`);
  return { startByte: start * 512, sectors: end - start + 1 };
}

// Unique GUID (PARTUUID) of a partition, via `sgdisk -i`.
async function partUuid(disk, partNum) {
  const out = await execAsync("sgdisk", ["-i", String(partNum), disk]);
  const m = out.match(/Partition unique GUID: ([0-9A-Fa-f-]{36})/);
  if (!m) throw new Error(`sgdisk -i ${partNum}: no unique GUID in ${disk}`);
  return m[1];
}

// Parse JSON defensively: a missing/empty slot-state.json (e.g.
// the install never ran) must FAIL its check, not crash the run.
function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Hash of a partition's raw bytes (the untouched proof for the
// Windows partitions: hashed before the install, re-hashed after).
async function partHash(disk, partNum) {
  const { startByte, sectors } = await partRange(disk, partNum);
  const part = join(OUT, `m11-parthash-${partNum}.img`);
  await execAsync("dd", [
    `if=${disk}`,
    `of=${part}`,
    "bs=512",
    `skip=${startByte / 512}`,
    `count=${sectors}`,
    "status=none",
  ]);
  return sha256File(part);
}

const MTOOLS_ENV = { ...process.env, MTOOLS_SKIP_CHECK: "1" };

async function espRead(disk, partNum, guestPath, outPath) {
  const { startByte } = await partRange(disk, partNum);
  await execAsync("mcopy", ["-i", `${disk}@@${startByte}`, `::${guestPath}`, outPath], {
    env: MTOOLS_ENV,
  });
  return outPath;
}

async function espWrite(disk, partNum, hostPath, guestPath) {
  const { startByte } = await partRange(disk, partNum);
  await execAsync(
    "mcopy",
    ["-o", "-i", `${disk}@@${startByte}`, hostPath, `::${guestPath}`],
    { env: MTOOLS_ENV },
  );
}

async function dataExtract(disk, partNum) {
  const { startByte, sectors } = await partRange(disk, partNum);
  const part = join(OUT, `m11-data-part-${partNum}.img`);
  await execAsync("dd", [
    `if=${disk}`,
    `of=${part}`,
    "bs=512",
    `skip=${startByte / 512}`,
    `count=${sectors}`,
    "status=none",
  ]);
  return part;
}

async function dataWriteBack(disk, partNum, part) {
  const { startByte } = await partRange(disk, partNum);
  await execAsync("dd", [
    `if=${part}`,
    `of=${disk}`,
    "bs=512",
    `seek=${startByte / 512}`,
    "conv=notrunc",
    "status=none",
  ]);
}

async function dataRead(disk, partNum, guestPath) {
  const part = await dataExtract(disk, partNum);
  return execAsync("debugfs", ["-R", `cat ${guestPath}`, part]);
}

async function dataWrite(disk, partNum, hostPath, guestPath) {
  const part = await dataExtract(disk, partNum);
  // Replay the ext4 journal before the debugfs write. debugfs edits
  // the partition image directly and bypasses the journal; the
  // guest's mount then replays the journal, which still holds the
  // OLD file content and silently reverts the debugfs change.
  // e2fsck -fy replays + clears the journal so the guest mounts a
  // clean filesystem and sees the debugfs write. e2fsck exits 1
  // when it corrected something (a journal replay), so tolerate 0/1.
  await execAsync("sh", ["-c", `e2fsck -fy ${part} || [ $? -le 1 ]`]);
  // debugfs `write` refuses to overwrite an existing file, so
  // remove it first (the rm fails when the file is absent; fine).
  await execAsync("debugfs", ["-w", "-R", `rm ${guestPath}`, part]).catch(() => {});
  await execAsync("debugfs", ["-w", "-R", `write ${hostPath} ${guestPath}`, part]);
  const want = readFileSync(hostPath, "utf8");
  const got = await execAsync("debugfs", ["-R", `cat ${guestPath}`, part]);
  if (got !== want) {
    throw new Error(
      `dataWrite: read-back mismatch for ${guestPath} (wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)})`,
    );
  }
  await dataWriteBack(disk, partNum, part);
}

// Pin sevyn.data=PARTUUID=<live p2 uuid> into the LIVE image's
// grub.cfg so the live boots always mount /data from the live
// image — never a SEVYN_DATA partition on the target disk (disk 2's
// old install carries that label). PARTUUID, not /dev/nvme0n1p2:
// the guest kernel enumerates the two NVMe controllers in either
// order across boots (nvme0/nvme1 swap), so a device path can point
// at the target disk's partition instead of the live image's.
// Returns the original text for restore.
async function pinLiveGrub() {
  const origPath = join(OUT, "m11-live-grub.cfg.orig");
  await espRead(IMAGE, 1, "/EFI/ubuntu/grub.cfg", origPath);
  const orig = readFileSync(origPath, "utf8");
  if (!orig.includes("sevyn.slot=A")) {
    throw new Error("live grub.cfg has no sevyn.slot=A linux line to pin");
  }
  const dataUuid = await partUuid(IMAGE, 2);
  const pinned = orig.replace(
    "sevyn.slot=A",
    `sevyn.slot=A sevyn.data=PARTUUID=${dataUuid}`,
  );
  const pinPath = join(OUT, "m11-live-grub.cfg.pinned");
  writeFileSync(pinPath, pinned);
  await espWrite(IMAGE, 1, pinPath, "/EFI/ubuntu/grub.cfg");
  return orig;
}

async function restoreLiveGrub(orig) {
  const path = join(OUT, "m11-live-grub.cfg.restore");
  writeFileSync(path, orig);
  await espWrite(IMAGE, 1, path, "/EFI/ubuntu/grub.cfg");
}

// Rewrite a target disk's installed grub.cfg for the harness: the
// menu renders on serial (so the harness can read it) while keys
// still come from the PS/2 keyboard (QMP), and the timeout stretches
// to 30s so the menu is up long enough to navigate. The entries
// themselves are untouched — they are what the installer wrote.
async function serialGrubCfg(disk, partNum) {
  const cfgPath = join(OUT, "m11-target-grub.cfg");
  await espRead(disk, partNum, "/EFI/ubuntu/grub.cfg", cfgPath);
  let cfg = readFileSync(cfgPath, "utf8");
  if (!cfg.includes("set timeout=5")) {
    throw new Error("installed grub.cfg has no set timeout=5 to stretch");
  }
  cfg = cfg.replace("set timeout=5", "set timeout=30");
  cfg =
    "serial --unit=0 --speed=115200\nterminal_input console\nterminal_output serial\n" +
    cfg;
  writeFileSync(cfgPath, cfg);
  await espWrite(disk, partNum, cfgPath, "/EFI/ubuntu/grub.cfg");
}

// The UEFI variables live in the per-boot VARS copy. The installer
// registers the SevynOS entry with efibootmgr; the entry name is
// stored UTF-16LE in the variables — a byte search is the host-side
// proof the entry was created.
function varsHasString(varsFile, text) {
  if (!varsFile || !existsSync(varsFile)) return false;
  const buf = readFileSync(varsFile);
  return buf.includes(Buffer.from(text, "utf16le"));
}

async function main() {
  const t0 = Date.now();
  const timeout = setTimeout(() => {
    console.error(`M11 check timed out after ${TIMEOUT_S}s`);
    process.exit(2);
  }, TIMEOUT_S * 1000);
  timeout.unref();

  // Step 0: host gate — the installer + updater host tests, before
  // any QEMU work.
  try {
    await execAsync("python3", [join(ROOT, "update", "test-install.py")]);
    check("host: test-install.py passes", true);
  } catch (e) {
    check("host: test-install.py passes", false, e.message);
    finish(false, { host_gate: "test-install.py" });
    return;
  }
  try {
    await execAsync("python3", [join(ROOT, "update", "test-updated.py")]);
    check("host: test-updated.py passes (all updater checks)", true);
  } catch (e) {
    check("host: test-updated.py passes (all updater checks)", false, e.message);
    finish(false, { host_gate: "test-updated.py" });
    return;
  }

  // Setup: the built image + data disk + mock disks.
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version", "sevynos.img"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m11-image.sh first`,
      );
      process.exit(1);
    }
  }
  const versionV1 = readFileSync(join(OUT, "os-version"), "utf8").trim();
  await execAsync("python3", [
    join(ROOT, "image", "make-data-disk.py"),
    "--kernel",
    join(OUT, "vmlinuz"),
    "--initramfs",
    join(OUT, "initramfs.cpio.gz"),
    "--version",
    versionV1,
    "--out",
    DISK,
    "--label",
    "SEVYN_DATA",
  ]);
  check("setup: data disk created (slot A = built image)", existsSync(DISK));

  // The mock Windows bootloader: a GRUB binary whose embedded config
  // prints a marker on serial, then drops to the GRUB prompt. It
  // stands in for bootmgfw.efi — chainloading it proves the
  // chainload path executes the Windows bootloader binary.
  const mockCfg = join(OUT, "mock-bootmgfw.cfg");
  writeFileSync(
    mockCfg,
    "serial --unit=0 --speed=115200\nterminal_input serial\nterminal_output serial\necho MOCK_WINDOWS_BOOTMGR_REACHED\n",
  );
  await execAsync("grub-mkimage", [
    "-O",
    "x86_64-efi",
    "-o",
    MOCK_EFI,
    "-p",
    "/EFI/Microsoft/Boot",
    "--config",
    mockCfg,
    "part_gpt",
    "fat",
    "serial",
    "terminal",
    "echo",
    "normal",
  ]);
  check("setup: mock bootmgfw.efi built (grub-mkimage)", existsSync(MOCK_EFI));

  await execAsync("python3", [
    join(ROOT, "image", "make-mock-windows-disk.py"),
    "--out",
    TARGET1,
    "--layout",
    "windows-free",
    "--windows-esp-mb",
    "100",
    "--windows-ntfs-mb",
    "512",
    "--free-mb",
    "3072",
    "--bootmgfw",
    MOCK_EFI,
  ]);
  // The replace run must clear the 2016 MiB minimum: 1152 + 1024.
  await execAsync("python3", [
    join(ROOT, "image", "make-mock-windows-disk.py"),
    "--out",
    TARGET2,
    "--layout",
    "windows-oldsevyn",
    "--windows-esp-mb",
    "100",
    "--windows-ntfs-mb",
    "512",
    "--old-esp-mb",
    "1152",
    "--old-data-mb",
    "1024",
    "--bootmgfw",
    MOCK_EFI,
  ]);
  check(
    "setup: mock Windows disks built (free-space + old-SevynOS)",
    existsSync(TARGET1) && existsSync(TARGET2),
  );
  // Installer v2 fixtures: a mock Linux disk, an empty disk (no
  // partition table), and a USB stick.
  await execAsync("python3", [
    join(ROOT, "image", "make-mock-windows-disk.py"),
    "--out",
    TARGET3,
    "--layout",
    "linux-free",
    "--linux-esp-mb",
    "100",
    "--linux-root-mb",
    "512",
    "--free-mb",
    "3072",
  ]);
  await execAsync("python3", [
    join(ROOT, "image", "make-mock-windows-disk.py"),
    "--out",
    USBSTICK,
    "--layout",
    "usb-free",
    "--usb-part-mb",
    "512",
    "--free-mb",
    "2200",
  ]);
  await execAsync("python3", [
    join(ROOT, "image", "make-mock-windows-disk.py"),
    "--out",
    EMPTYDISK,
    "--layout",
    "empty",
    "--empty-mb",
    "6144",
  ]);
  check(
    "setup: installer-v2 disks built (Linux + USB stick + empty)",
    existsSync(TARGET3) && existsSync(USBSTICK) && existsSync(EMPTYDISK),
  );
  // Linux partitions, hashed before anything writes — the
  // untouched proof for the beside-Linux plan step.
  const linEsp = await partHash(TARGET3, 1);
  const linRoot = await partHash(TARGET3, 2);
  const usbOld = await partHash(USBSTICK, 1);
  check("setup: Linux + USB partitions hashed", true);
  // Windows partitions, hashed before anything writes — the
  // untouched proof.
  const win1Esp = await partHash(TARGET1, 1);
  const win1Ntfs = await partHash(TARGET1, 2);
  const win2Esp = await partHash(TARGET2, 1);
  const win2Ntfs = await partHash(TARGET2, 2);
  check("setup: Windows partitions hashed (both disks)", true);

  // Step 1: regression boot (-kernel/-initrd + data disk).
  const b = await boot("main");
  await connectSockets(b);
  const ready = await waitForLog(b.logPath, /SEVYNOS_M5_READY/, 300000);
  check("boot: SEVYNOS_M5_READY (regression boot)", !!ready);
  const ready45 = await waitForLog(b.logPath, /SEVYNOS_M4_5_READY/, 30000);
  check("boot: SEVYNOS_M4_5_READY (M4.5 stack intact)", !!ready45);
  const ping = await appdCmd(b, "PING", /APPD PONG/);
  check("appd: PING -> PONG", !!ping);
  const term = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("terminal: launch", !!term);
  await sleep(5000);
  const status = await termCmd(b, "install status");
  check("install: sevyn install status runs on the live image", !!status);
  const beforeOps = logLines(b.logPath).length;
  const installerRun = await termCmd(
    b,
    "app run installer --permissions cli.exec --seconds 20 --width 800 --height 500 --out /tmp/m11-ops-installer.json",
  );
  check("installer: headless app run completes", !!installerRun);
  // The regression boot has no installable disk (the data disk is
  // the boot disk), so the installer correctly shows the disk
  // picker with "No disk available to install onto." — the plan
  // screen (and its "Install SevynOS alongside Windows" button)
  // only renders when an installable disk is present, which is
  // proven on live1 below. Here we assert the app launches, runs
  // its probe, and renders its (correct) no-disk state, waiting
  // for the text inside a parsed ops snapshot (not just in the
  // raw log — see waitForOpsText).
  const { ops: installerOps, texts: installerTexts } = await waitForOpsText(
    b,
    beforeOps,
    "No disk available to install onto.",
    60000,
  );
  check(
    "installer: app renders (Installer + no-disk state)",
    !!installerOps &&
      installerTexts.includes("Installer") &&
      installerTexts.includes("No disk available to install onto."),
    installerOps ? `${installerTexts.length} texts` : "no ops",
  );
  b.ctl.write("POWEROFF\n");
  const exited1 = await waitExit(b, 30000);
  check("boot: guest powers off on request", exited1);
  closeBoot(b);

  // Step 2: UEFI live boot + mock disk 1 — install into free space.
  const liveGrubOrig = await pinLiveGrub();
  check("live: grub.cfg pinned with sevyn.data=PARTUUID=", true);
  const live1 = await boot("live1", {
    mode: "uefi",
    extraDrives: [{ file: TARGET1, id: "t1", serial: "target1" }],
  });
  await connectSockets(live1);
  const live1Ready = await waitForLog(live1.logPath, /SEVYNOS_M5_READY/, 600000);
  check("live1: SEVYNOS_M5_READY (UEFI live boot)", !!live1Ready);
  const live1Data = await waitForLog(
    live1.logPath,
    /M11 init: sevyn\.data=PARTUUID=[0-9A-Fa-f-]{36} -> \/dev\/nvme\dn1p2/,
    60000,
  );
  check("live1: /data mounts from the live image (sevyn.data pin)", !!live1Data);
  const live1Term = await appdCmd(live1, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("live1: terminal launches", !!live1Term);
  await sleep(5000);
  const probe1 = await termCmd(live1, `install probe --disk ${TARGET1_BYID}`);
  check("live1: sevyn install probe finds Windows + free space", !!probe1);
  const plan1 = await termCmd(live1, `install plan --disk ${TARGET1_BYID} --target auto`);
  check("live1: sevyn install plan (auto) succeeds", !!plan1);
  // The wizard's plan screen only renders when a Windows disk is
  // present (live1 has TARGET1 attached). Run the headless
  // installer and wait for the plan button in an ops snapshot —
  // the first snapshot lands before the async probe+plan finishes
  // and shows only the loading shell. --seconds 45 gives the
  // probe+plan time to load (diag runs needed ~32s).
  const beforeWiz1 = logLines(live1.logPath).length;
  const wiz1Run = await termCmd(
    live1,
    "app run installer --permissions cli.exec --seconds 45 --width 800 --height 500 --out /tmp/m11-ops-installer.json",
  );
  const { ops: wiz1Ops, texts: wiz1Texts } = await waitForOpsText(
    live1,
    beforeWiz1,
    "Install SevynOS alongside Windows",
    30000,
  );
  check(
    "live1: installer wizard renders the plan (Install SevynOS alongside Windows)",
    !!wiz1Run && wiz1Texts.includes("Install SevynOS alongside Windows"),
    wiz1Ops ? `${wiz1Texts.length} texts` : "no ops",
  );
  const install1 = await termCmd(
    live1,
    `install install --disk ${TARGET1_BYID} --target auto --yes`,
    300000,
  );
  check("live1: sevyn install install --yes succeeds", !!install1);
  live1.ctl.write("POWEROFF\n");
  const exitedLive1 = await waitExit(live1, 30000);
  check("live1: guest powers off on request", exitedLive1);
  closeBoot(live1);
  // Host-side proof of the install.
  check(
    "live1: Windows ESP byte-identical after install",
    (await partHash(TARGET1, 1)) === win1Esp,
  );
  check(
    "live1: Windows NTFS byte-identical after install",
    (await partHash(TARGET1, 2)) === win1Ntfs,
  );
  const sgdisk1 = await execAsync("sgdisk", ["-p", TARGET1]);
  const hasP34 = /^\s*3\s/m.test(sgdisk1) && /^\s*4\s/m.test(sgdisk1);
  check(
    "live1: new ESP (p3) + data (p4) partitions exist",
    hasP34,
    sgdisk1.split("\n").slice(0, 8).join(" | "),
  );
  // A failed install leaves no p3/p4; record the dependent checks
  // as FAIL and continue to the remaining boots instead of crashing
  // in espRead/dataRead (partRange throws on a missing partition).
  if (hasP34 && install1) {
    const grub1Path = join(OUT, "m11-target1-grub.cfg");
    await espRead(TARGET1, 3, "/EFI/ubuntu/grub.cfg", grub1Path);
    const grub1 = readFileSync(grub1Path, "utf8");
    check(
      "live1: grub.cfg lists SevynOS + Windows 11",
      grub1.includes('menuentry "SevynOS"') && grub1.includes('menuentry "Windows 11"'),
      grub1.slice(0, 200),
    );
    check(
      "live1: grub.cfg pins sevyn.data=PARTUUID=",
      /sevyn\.data=PARTUUID=[0-9A-Fa-f-]{36}/.test(grub1),
    );
    const state1 = parseJsonSafe(await dataRead(TARGET1, 4, "/slot-state.json"));
    check(
      "live1: slot layout landed (active A, good A, attempts 0)",
      !!state1 && state1.active === "A" && state1.good === "A" && state1.attempts === 0,
      state1 ? JSON.stringify(state1) : "slot-state.json missing/unparseable",
    );
  } else {
    check(
      "live1: grub.cfg lists SevynOS + Windows 11",
      false,
      "no p3 (install wrote nothing)",
    );
    check(
      "live1: grub.cfg pins sevyn.data=PARTUUID=",
      false,
      "no p3 (install wrote nothing)",
    );
    check(
      "live1: slot layout landed (active A, good A, attempts 0)",
      false,
      "no p4 (install wrote nothing)",
    );
  }
  check(
    "live1: UEFI boot entry created (SevynOS in firmware vars)",
    varsHasString(live1.varsCopy, "SevynOS"),
  );

  // Step 3: UEFI boot, target disk 1 only — menu + default boot +
  // Windows chainload. A failed install leaves no p3/p4;
  // serialGrubCfg throws on a missing partition, so skip the boot
  // and record the dependent checks as FAIL instead of crashing.
  if (hasP34 && install1) {
    await serialGrubCfg(TARGET1, 3);
    const t1 = await boot("target1", {
      mode: "uefi",
      image: TARGET1,
      varsFrom: live1.varsCopy,
    });
    await connectSockets(t1);
    const menu1 = await waitForLog(t1.logPath, /Windows 11/, 600000);
    check("target1: GRUB menu lists the Windows 11 entry", !!menu1);
    const t1Ready = await waitForLog(t1.logPath, /SEVYNOS_M5_READY/, 600000);
    check("target1: SEVYNOS_M5_READY (default boot)", !!t1Ready);
    const t1Data = await waitForLog(t1.logPath, /M11 init: sevyn\.data=PARTUUID=/, 60000);
    check("target1: /data mounts via sevyn.data=PARTUUID=", !!t1Data);
    const t1DataDev = await waitForLog(
      t1.logPath,
      /M7 init: data disk mounted \(\/dev\/nvme0n1p4\)/,
      60000,
    );
    check("target1: /data is the new partition (nvme0n1p4)", !!t1DataDev);
    const t1Term = await appdCmd(t1, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
    check("target1: terminal launches on the installed system", !!t1Term);
    // Default boot proved. Power off and boot again FRESH to test
    // the Windows chainload — a second boot, not QMP system_reset
    // (the reset did not reboot the VM in round 8: no second BdsDxe
    // or kernel load appeared in the log within 300s, so the menu
    // never re-appeared). The serial menu config persists on disk
    // (serialGrubCfg rewrote grub.cfg before the first boot).
    t1.ctl.write("POWEROFF\n");
    const exitedT1 = await waitExit(t1, 30000);
    check("target1: guest powers off on request", exitedT1);
    closeBoot(t1);
    const t1b = await boot("target1b", {
      mode: "uefi",
      image: TARGET1,
      // Non-Secure-Boot firmware: the mock Windows bootloader is
      // unsigned, and shim rejects it under Secure Boot ("bad shim
      // signature"). Fresh vars (no varsFrom) — the chainload boots
      // via the BOOTX64.EFI fallback, no NVRAM entry needed.
      firmware: "nosecboot",
    });
    await connectSockets(t1b);
    const menu1b = await waitForLog(t1b.logPath, /Windows 11/, 600000);
    check("target1: GRUB menu lists Windows 11 on the second boot", !!menu1b);
    if (menu1b) {
      await keyTap(t1b.qmp, "down");
      await sleep(500);
      await keyTap(t1b.qmp, "ret");
      const mockBoot = await waitForLog(
        t1b.logPath,
        /MOCK_WINDOWS_BOOTMGR_REACHED/,
        120000,
      );
      check(
        "target1: Windows entry chainloads the bootloader (mock marker on serial)",
        !!mockBoot,
      );
    } else {
      check(
        "target1: Windows entry chainloads the bootloader (mock marker on serial)",
        false,
        "menu never appeared on the second boot",
      );
    }
    closeBoot(t1b);
  } else {
    for (const name of [
      "target1: GRUB menu lists the Windows 11 entry",
      "target1: SEVYNOS_M5_READY (default boot)",
      "target1: /data mounts via sevyn.data=PARTUUID=",
      "target1: /data is the new partition (nvme0n1p4)",
      "target1: terminal launches on the installed system",
      "target1: guest powers off on request",
      "target1: GRUB menu lists Windows 11 on the second boot",
      "target1: Windows entry chainloads the bootloader (mock marker on serial)",
    ]) {
      check(name, false, "no p3/p4 (install wrote nothing)");
    }
  }

  // Step 4: UEFI live boot + mock disk 2 — replace the old install.
  const live2 = await boot("live2", {
    mode: "uefi",
    extraDrives: [{ file: TARGET2, id: "t2", serial: "target2" }],
  });
  await connectSockets(live2);
  const live2Ready = await waitForLog(live2.logPath, /SEVYNOS_M5_READY/, 600000);
  check("live2: SEVYNOS_M5_READY (UEFI live boot)", !!live2Ready);
  const live2Term = await appdCmd(live2, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("live2: terminal launches", !!live2Term);
  await sleep(5000);
  const probe2 = await termCmd(live2, `install probe --disk ${TARGET2_BYID}`);
  check("live2: sevyn install probe finds Windows + old SevynOS", !!probe2);
  const plan2auto = await termCmd(
    live2,
    `install plan --disk ${TARGET2_BYID} --target auto`,
  );
  check(
    "live2: sevyn install plan (auto) succeeds — replace, no free space",
    !!plan2auto,
  );
  const plan2t3 = await termCmd(live2, `install plan --disk ${TARGET2_BYID} --target 3`);
  check("live2: sevyn install plan --target 3 (explicit replace) succeeds", !!plan2t3);
  const install2 = await termCmd(
    live2,
    `install install --disk ${TARGET2_BYID} --target 3 --yes`,
    300000,
  );
  check("live2: sevyn install install --target 3 --yes succeeds", !!install2);
  live2.ctl.write("POWEROFF\n");
  const exitedLive2 = await waitExit(live2, 30000);
  check("live2: guest powers off on request", exitedLive2);
  closeBoot(live2);
  check(
    "live2: Windows ESP byte-identical after replace",
    (await partHash(TARGET2, 1)) === win2Esp,
  );
  check(
    "live2: Windows NTFS byte-identical after replace",
    (await partHash(TARGET2, 2)) === win2Ntfs,
  );
  const sgdisk2 = await execAsync("sgdisk", ["-p", TARGET2]);
  const hasP34b = /^\s*3\s/m.test(sgdisk2) && /^\s*4\s/m.test(sgdisk2);
  check(
    "live2: new ESP (p3) + data (p4) partitions exist after replace",
    hasP34b,
    sgdisk2.split("\n").slice(0, 8).join(" | "),
  );
  // A failed replace can leave no p3/p4; record the dependent
  // checks as FAIL and continue instead of crashing in
  // espRead/dataRead (partRange throws on a missing partition).
  if (hasP34b && install2) {
    const grub2Path = join(OUT, "m11-target2-grub.cfg");
    await espRead(TARGET2, 3, "/EFI/ubuntu/grub.cfg", grub2Path);
    const grub2 = readFileSync(grub2Path, "utf8");
    check(
      "live2: new grub.cfg lists SevynOS + Windows 11 (old install replaced)",
      grub2.includes('menuentry "SevynOS"') && grub2.includes('menuentry "Windows 11"'),
      grub2.slice(0, 200),
    );
    check(
      "live2: new grub.cfg pins sevyn.data=PARTUUID=",
      /sevyn\.data=PARTUUID=[0-9A-Fa-f-]{36}/.test(grub2),
    );
    const state2 = parseJsonSafe(await dataRead(TARGET2, 4, "/slot-state.json"));
    check(
      "live2: slot layout landed on the replaced disk (active A, good A)",
      !!state2 && state2.active === "A" && state2.good === "A" && state2.attempts === 0,
      state2 ? JSON.stringify(state2) : "slot-state.json missing/unparseable",
    );
  } else {
    check(
      "live2: new grub.cfg lists SevynOS + Windows 11 (old install replaced)",
      false,
      "no p3 (replace wrote nothing)",
    );
    check(
      "live2: new grub.cfg pins sevyn.data=PARTUUID=",
      false,
      "no p3 (replace wrote nothing)",
    );
    check(
      "live2: slot layout landed on the replaced disk (active A, good A)",
      false,
      "no p4 (replace wrote nothing)",
    );
  }
  // The live boots are done — restore the live image's grub.cfg.
  await restoreLiveGrub(liveGrubOrig);
  check("live: grub.cfg restored on the live image", true);

  // Step 5: UEFI boot, target disk 2 only — menu + default boot.
  // Only if the replace ran: otherwise this would boot (and pass
  // checks against) the MOCK old install, not the new one.
  if (install2) {
    await serialGrubCfg(TARGET2, 3);
    const t2 = await boot("target2", {
      mode: "uefi",
      image: TARGET2,
      varsFrom: live2.varsCopy,
    });
    await connectSockets(t2);
    const menu2 = await waitForLog(t2.logPath, /Windows 11/, 600000);
    check("target2: GRUB menu lists the Windows 11 entry", !!menu2);
    const t2Ready = await waitForLog(t2.logPath, /SEVYNOS_M5_READY/, 600000);
    check("target2: SEVYNOS_M5_READY (default boot)", !!t2Ready);
    const t2Data = await waitForLog(t2.logPath, /M11 init: sevyn\.data=PARTUUID=/, 60000);
    check("target2: /data mounts via sevyn.data=PARTUUID=", !!t2Data);
    const t2Term = await appdCmd(t2, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
    check("target2: terminal launches on the replaced system", !!t2Term);
    t2.ctl.write("POWEROFF\n");
    const exitedT2 = await waitExit(t2, 30000);
    check("target2: guest powers off on request", exitedT2);
    closeBoot(t2);
  } else {
    for (const name of [
      "target2: GRUB menu lists the Windows 11 entry",
      "target2: SEVYNOS_M5_READY (default boot)",
      "target2: /data mounts via sevyn.data=PARTUUID=",
      "target2: terminal launches on the replaced system",
      "target2: guest powers off on request",
    ]) {
      check(name, false, "replace install did not run");
    }
  }

  // Step 6: installer v2 — UEFI live boot + Linux disk, empty disk,
  // and USB stick. Probe lists all three; beside-Linux and
  // whole-disk plans succeed; the boot disk refuses; the portable
  // install lands on the stick.
  const liveGrubOrig3 = await pinLiveGrub();
  check("live3: grub.cfg pinned with sevyn.data=PARTUUID=", true);
  const live3 = await boot("live3", {
    mode: "uefi",
    extraDrives: [
      { file: TARGET3, id: "t3", serial: "target3" },
      { file: EMPTYDISK, id: "te", serial: "empty1" },
    ],
    usbDrives: [{ file: USBSTICK, id: "usb0" }],
  });
  await connectSockets(live3);
  const live3Ready = await waitForLog(live3.logPath, /SEVYNOS_M5_READY/, 600000);
  check("live3: SEVYNOS_M5_READY (UEFI live boot)", !!live3Ready);
  const live3Term = await appdCmd(live3, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("live3: terminal launches", !!live3Term);
  await sleep(5000);
  const probe3 = await termCmd(live3, "install probe");
  check("live3: sevyn install probe lists the Linux + USB + empty disks", !!probe3);
  const plan3linux = await termCmd(
    live3,
    `install plan --disk ${TARGET3_BYID} --target auto`,
  );
  check("live3: sevyn install plan beside Linux succeeds", !!plan3linux);
  const plan3whole = await termCmd(
    live3,
    `install plan --disk ${EMPTY_BYID} --target whole`,
  );
  check(
    "live3: sevyn install plan --target whole on the empty disk succeeds",
    !!plan3whole,
  );
  const plan3port = await termCmd(
    live3,
    `install plan --disk ${USB_DEV} --target portable`,
  );
  check(
    "live3: sevyn install plan --target portable on the USB stick succeeds",
    !!plan3port,
  );
  const plan3boot = await termCmdCode(
    live3,
    `install plan --disk ${BOOT_BYID} --target auto`,
    1,
  );
  check("live3: sevyn install plan on the boot disk refuses (exit 1)", !!plan3boot);
  // The wizard sees three installable disks, so it shows the disk
  // picker (no auto-pick) — assert it renders with the USB disk.
  const beforeWiz3 = logLines(live3.logPath).length;
  const wiz3Run = await termCmd(
    live3,
    "app run installer --permissions cli.exec --seconds 45 --width 800 --height 500 --out /tmp/m11-ops-installer3.json",
  );
  const { ops: wiz3Ops, texts: wiz3Texts } = await waitForOpsText(
    live3,
    beforeWiz3,
    "Choose a disk",
    30000,
  );
  check(
    "live3: installer wizard renders the disk picker (Choose a disk + /dev/sda)",
    !!wiz3Run &&
      wiz3Texts.includes("Choose a disk") &&
      wiz3Texts.some((t) => t.startsWith("/dev/sda")),
    wiz3Ops ? `${wiz3Texts.length} texts` : "no ops",
  );
  const install3 = await termCmd(
    live3,
    `install install --disk ${USB_DEV} --target portable --yes`,
    300000,
  );
  check("live3: sevyn install install --target portable --yes succeeds", !!install3);
  live3.ctl.write("POWEROFF\n");
  const exitedLive3 = await waitExit(live3, 30000);
  check("live3: guest powers off on request", exitedLive3);
  closeBoot(live3);
  await restoreLiveGrub(liveGrubOrig3);
  check("live3: grub.cfg restored on the live image", true);
  // Host-side proof of the portable install.
  check(
    "live3: Linux ESP byte-identical (plan only, nothing installed there)",
    (await partHash(TARGET3, 1)) === linEsp,
  );
  check(
    "live3: Linux root byte-identical (plan only, nothing installed there)",
    (await partHash(TARGET3, 2)) === linRoot,
  );
  check(
    "live3: USB stick's old partition byte-identical after portable install",
    (await partHash(USBSTICK, 1)) === usbOld,
  );
  const sgdisk3 = await execAsync("sgdisk", ["-p", USBSTICK]);
  const hasP23 = /^\s*2\s/m.test(sgdisk3) && /^\s*3\s/m.test(sgdisk3);
  check(
    "live3: new ESP (p2) + data (p3) partitions exist on the stick",
    hasP23,
    sgdisk3.split("\n").slice(0, 8).join(" | "),
  );
  if (hasP23 && install3) {
    const grub3Path = join(OUT, "m11-usbstick-grub.cfg");
    await espRead(USBSTICK, 2, "/EFI/ubuntu/grub.cfg", grub3Path);
    const grub3 = readFileSync(grub3Path, "utf8");
    check(
      "live3: stick grub.cfg is SevynOS-only (no Windows entry)",
      grub3.includes('menuentry "SevynOS"') && !grub3.includes('menuentry "Windows 11"'),
      grub3.slice(0, 200),
    );
    check(
      "live3: stick grub.cfg pins sevyn.data=PARTUUID=",
      /sevyn\.data=PARTUUID=[0-9A-Fa-f-]{36}/.test(grub3),
    );
    const state3 = parseJsonSafe(await dataRead(USBSTICK, 3, "/slot-state.json"));
    check(
      "live3: slot layout landed on the stick (active A, good A, attempts 0)",
      !!state3 && state3.active === "A" && state3.good === "A" && state3.attempts === 0,
      state3 ? JSON.stringify(state3) : "slot-state.json missing/unparseable",
    );
    // The fallback bootloader is the portable boot path — it must
    // exist even though no NVRAM entry was registered.
    let bootx64 = false;
    try {
      await espRead(
        USBSTICK,
        2,
        "/EFI/BOOT/BOOTX64.EFI",
        join(OUT, "m11-usbstick-bootx64.efi"),
      );
      bootx64 = true;
    } catch {
      bootx64 = false;
    }
    check("live3: stick ESP carries the fallback BOOTX64.EFI", bootx64);
  } else {
    check(
      "live3: stick grub.cfg is SevynOS-only (no Windows entry)",
      false,
      "no p2 (install wrote nothing)",
    );
    check(
      "live3: stick grub.cfg pins sevyn.data=PARTUUID=",
      false,
      "no p2 (install wrote nothing)",
    );
    check(
      "live3: slot layout landed on the stick (active A, good A, attempts 0)",
      false,
      "no p3 (install wrote nothing)",
    );
    check("live3: stick ESP carries the fallback BOOTX64.EFI", false, "no p2");
  }

  // Step 7: installer v2 — UEFI boot from the USB stick alone, with
  // FRESH firmware variables (no NVRAM entry was ever registered
  // for the portable install): the fallback BOOTX64.EFI must boot
  // the stick on its own.
  if (hasP23 && install3) {
    await serialGrubCfg(USBSTICK, 2);
    const usb = await boot("usbboot", {
      mode: "uefi",
      image: USBSTICK,
    });
    await connectSockets(usb);
    const usbMenu = await waitForLog(usb.logPath, /SevynOS/, 600000);
    check("usbboot: GRUB menu lists SevynOS on the stick", !!usbMenu);
    const usbReady = await waitForLog(usb.logPath, /SEVYNOS_M5_READY/, 600000);
    check("usbboot: SEVYNOS_M5_READY (portable boot from the stick)", !!usbReady);
    const usbData = await waitForLog(
      usb.logPath,
      /M11 init: sevyn\.data=PARTUUID=/,
      60000,
    );
    check("usbboot: /data mounts via sevyn.data=PARTUUID=", !!usbData);
    const usbTerm = await appdCmd(usb, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
    check("usbboot: terminal launches on the portable system", !!usbTerm);
    usb.ctl.write("POWEROFF\n");
    const exitedUsb = await waitExit(usb, 30000);
    check("usbboot: guest powers off on request", exitedUsb);
    closeBoot(usb);
  } else {
    for (const name of [
      "usbboot: GRUB menu lists SevynOS on the stick",
      "usbboot: SEVYNOS_M5_READY (portable boot from the stick)",
      "usbboot: /data mounts via sevyn.data=PARTUUID=",
      "usbboot: terminal launches on the portable system",
      "usbboot: guest powers off on request",
    ]) {
      check(name, false, "portable install did not run");
    }
  }

  // Step 8: fallback — the updater's ESP discovery on a dual-boot
  // disk. Tamper target 1's slot state (attempts=2, active=B,
  // good=A); the daemon must restore the ESP from the good slot —
  // the SEVYNESP (p3), not the Windows ESP (p1) — and reboot.
  // The restore only triggers when the BOOTED slot is the failed
  // one (g_boot_slot != good, attempts >= 2). The installed
  // grub.cfg boots slot A (sevyn.slot=A), which IS the good slot,
  // so without a change the daemon would return early and never
  // restore. Rewrite the SevynOS entry to sevyn.slot=B for this
  // boot only: the daemon then sees booted slot B (failed) vs good
  // A and restores the ESP from slot A (which flips the entry back
  // to sevyn.slot=A on the restore). The kernel/initramfs are the
  // same files either way — the slot is the updater's bookkeeping,
  // not a separate kernel.
  const fbCfgPath = join(OUT, "m11-fallback-grub.cfg");
  await espRead(TARGET1, 3, "/EFI/ubuntu/grub.cfg", fbCfgPath);
  let fbCfg = readFileSync(fbCfgPath, "utf8");
  if (!fbCfg.includes("sevyn.slot=A")) {
    throw new Error(
      "installed grub.cfg has no sevyn.slot=A to flip to B for the fallback boot",
    );
  }
  fbCfg = fbCfg.replaceAll("sevyn.slot=A", "sevyn.slot=B");
  writeFileSync(fbCfgPath, fbCfg);
  await espWrite(TARGET1, 3, fbCfgPath, "/EFI/ubuntu/grub.cfg");
  const state1Before = parseJsonSafe(await dataRead(TARGET1, 4, "/slot-state.json"));
  const fbStatePath = join(OUT, "m11-fallback-state.json");
  writeFileSync(
    fbStatePath,
    JSON.stringify(
      {
        active: "B",
        good: "A",
        attempts: 2,
        version: state1Before?.version ?? "m11-test-1",
      },
      null,
      2,
    ) + "\n",
  );
  await dataWrite(TARGET1, 4, fbStatePath, "/slot-state.json");
  const fbStateBack = parseJsonSafe(await dataRead(TARGET1, 4, "/slot-state.json"));
  check(
    "fallback: tampered state (attempts=2, good=A) persisted to disk",
    !!fbStateBack &&
      fbStateBack.active === "B" &&
      fbStateBack.good === "A" &&
      fbStateBack.attempts === 2,
    JSON.stringify(fbStateBack),
  );
  const fb = await boot("fallback", {
    mode: "uefi",
    image: TARGET1,
    varsFrom: live1.varsCopy,
  });
  await connectSockets(fb);
  const restored = await waitForLog(
    fb.logPath,
    /UPDATE ESP restored from slot A/,
    300000,
  );
  check("fallback: daemon restores the ESP from good slot A", !!restored);
  const fbRebooted = await waitExit(fb, 60000);
  check("fallback: guest reboots after the restore", fbRebooted);
  closeBoot(fb);
  const grubFbPath = join(OUT, "m11-target1-grub-fb.cfg");
  await espRead(TARGET1, 3, "/EFI/ubuntu/grub.cfg", grubFbPath);
  const grubFb = readFileSync(grubFbPath, "utf8");
  check(
    "fallback: restored grub.cfg still lists Windows 11",
    grubFb.includes('menuentry "Windows 11"'),
    grubFb.slice(0, 200),
  );
  check(
    "fallback: restored grub.cfg still pins sevyn.data=PARTUUID=",
    /sevyn\.data=PARTUUID=[0-9A-Fa-f-]{36}/.test(grubFb),
  );
  check(
    "fallback: Windows ESP byte-identical after the restore (wrong ESP untouched)",
    (await partHash(TARGET1, 1)) === win1Esp,
  );
  const stateFb = parseJsonSafe(await dataRead(TARGET1, 4, "/slot-state.json"));
  check(
    "fallback: slot state flipped back to A (attempts 0)",
    !!stateFb && stateFb.active === "A" && stateFb.good === "A" && stateFb.attempts === 0,
    stateFb ? JSON.stringify(stateFb) : "slot-state.json missing/unparseable",
  );

  // Post-restore boot: the restored system boots clean.
  const rs = await boot("restored", {
    mode: "uefi",
    image: TARGET1,
    varsFrom: live1.varsCopy,
  });
  await connectSockets(rs);
  const rsReady = await waitForLog(rs.logPath, /SEVYNOS_M5_READY/, 600000);
  check("restored: SEVYNOS_M5_READY on the restored slot A", !!rsReady);
  const rsGood = await waitForLog(rs.logPath, /UPDATE SLOT GOOD A/, 120000);
  check("restored: slot A marked good again", !!rsGood);
  rs.ctl.write("POWEROFF\n");
  const exitedRs = await waitExit(rs, 30000);
  check("restored: guest powers off on request", exitedRs);
  closeBoot(rs);

  finish(
    checks.every((c) => c.ok),
    {
      duration_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    },
  );
}

function finish(ok, extra = {}) {
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    ...extra,
  };
  writeFileSync(join(OUT, "m11-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M11 CHECK PASSED" : "M11 CHECK FAILED");
  // Stop the guest: an early finish() must not leave QEMU holding
  // a disk's write lock for the next run.
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  // Snapshot this run's serial logs before exiting: the next check
  // run's boot() archives them, but a snapshot at the end is the
  // primary evidence for this run.
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const src of [
      join(OUT, "m11-boot-main.log"),
      join(OUT, "m11-uefi-boot-live1.log"),
      join(OUT, "m11-uefi-boot-target1.log"),
      join(OUT, "m11-uefi-boot-live2.log"),
      join(OUT, "m11-uefi-boot-target2.log"),
      join(OUT, "m11-uefi-boot-live3.log"),
      join(OUT, "m11-uefi-boot-usbboot.log"),
      join(OUT, "m11-uefi-boot-fallback.log"),
      join(OUT, "m11-uefi-boot-restored.log"),
    ]) {
      if (existsSync(src) && statSync(src).size > 0) {
        const base = src
          .split("/")
          .pop()
          .replace(/\.log$/, "");
        copyFileSync(src, join(OUT, `${base}-${stamp}.log`));
      }
    }
  } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M11 check crashed:", e);
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  const result = {
    pass: false,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    error: String(e),
  };
  try {
    writeFileSync(join(OUT, "m11-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
