/**
 * SevynOS installer — pure partition-planning logic.
 *
 * All sizes are in MiB. This module performs no I/O and has no side effects:
 * it turns measurements (disk size, `parted --machine` output, filesystem
 * minimum sizes probed by the shell) into concrete, validated plans that the
 * shell installer executes with parted/mkfs. Every destructive decision the
 * installer makes flows through here so it can be unit-tested.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SEVYN_ROOT_MIN_MIB = 20480; // 20 GiB minimum for /
export const SEVYN_SWAP_MIB = 4096; // 4 GiB swap
export const SEVYN_ESP_MIB = 512; // 512 MiB EFI System Partition
export const ALONGSIDE_SAFETY_MARGIN_MIB = 1024; // 1 GiB left untouched past the fs minimum
export const ALONGSIDE_MIN_REMAINING_MIB = 10240; // shrunk OS keeps >= 10 GiB
export const SUPPORTED_SHRINK_FILESYSTEMS = Object.freeze([
  "ntfs",
  "ext4",
  "ext3",
  "ext2",
]);

/**
 * Layout for "erase disk" mode. Mirrors the historical installer geometry:
 * a tiny BIOS-boot partition (legacy boot), the FAT32 ESP, the ext4 root,
 * and swap at the end of the disk.
 *
 * @param {number} diskSizeMiB total disk size in MiB
 * @param {{espMiB?: number, swapMiB?: number, rootMinMiB?: number}} [opts]
 * @returns {{ok: true, partitions: Array<{name: string, startMiB: number, endMiB: number, fs?: string, flags?: string[], label?: string, type?: string}>} |
 *          {{ok: false, error: string}}}
 */
export function planEraseLayout(diskSizeMiB, opts = {}) {
  const espMiB = opts.espMiB ?? SEVYN_ESP_MIB;
  const swapMiB = opts.swapMiB ?? SEVYN_SWAP_MIB;
  const rootMinMiB = opts.rootMinMiB ?? SEVYN_ROOT_MIN_MIB;
  if (!Number.isFinite(diskSizeMiB) || diskSizeMiB <= 0) {
    return { ok: false, error: "Invalid disk size." };
  }

  const biosStart = 1;
  const biosEnd = 3;
  const espStart = biosEnd;
  const espEnd = espStart + espMiB;
  const rootStart = espEnd + 1;
  const swapStart = Math.floor(diskSizeMiB) - swapMiB;
  const rootEnd = swapStart - 1;
  const diskEnd = Math.floor(diskSizeMiB);

  const minDiskMiB = rootStart + rootMinMiB + 1 + swapMiB;
  if (diskSizeMiB < minDiskMiB) {
    return {
      ok: false,
      error:
        `Disk is too small: need at least ${minDiskMiB} MiB ` +
        `(${(minDiskMiB / 1024).toFixed(1)} GiB).`,
    };
  }

  return {
    ok: true,
    partitions: [
      { name: "BIOSBOOT", startMiB: biosStart, endMiB: biosEnd, type: "bios_grub" },
      {
        name: "SEVYN_EFI",
        startMiB: espStart,
        endMiB: espEnd,
        fs: "fat32",
        flags: ["esp"],
        label: "SEVYN_EFI",
      },
      {
        name: "SevynOS",
        startMiB: rootStart,
        endMiB: rootEnd,
        fs: "ext4",
        label: "SEVYNOS_ROOT",
      },
      {
        name: "swap",
        startMiB: swapStart,
        endMiB: diskEnd,
        fs: "linux-swap",
        label: "SEVYN_SWAP",
      },
    ],
  };
}

/**
 * Parse `parted -s --machine unit MiB print` output into partition records.
 * Machine format lines look like:
 *   1:1.00MiB:3.00MiB:2.00MiB:fat32:EFI System Partition:esp;
 *
 * @param {string} text stdout of parted --machine
 * @returns {Array<{num: number, startMiB: number, endMiB: number, sizeMiB: number, fsType: string, name: string, flags: string}>}
 */
export function parsePartedMachineOutput(text) {
  const partitions = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("BYT;")) continue;
    // parted --machine terminates each record with ';'
    const record = line.endsWith(";") ? line.slice(0, -1) : line;
    const fields = record.split(":");
    if (fields.length < 5) continue;
    const num = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(num)) continue;
    const mib = (value) => {
      const parsed = Number.parseFloat(String(value).replace(/MiB/i, ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    partitions.push({
      num,
      startMiB: mib(fields[1]),
      endMiB: mib(fields[2]),
      sizeMiB: mib(fields[3]),
      fsType: (fields[4] ?? "").trim().toLowerCase(),
      name: (fields[5] ?? "").trim(),
      flags: (fields[6] ?? "").trim(),
    });
  }
  return partitions.sort((a, b) => a.num - b.num);
}

/**
 * Plan an "alongside" install: shrink one existing partition to free space
 * for SevynOS root + swap at the end of the freed region.
 *
 * The filesystem MUST be shrunk to `shrinkToMiB` before the partition is
 * resized — the installer shrinks the filesystem first, then the partition.
 *
 * @param {Array<ReturnType<typeof parsePartedMachineOutput>[number]>} partitions
 * @param {number} targetNum partition number to shrink
 * @param {number} fsMinMiB minimum size the filesystem can shrink to (probed
 *   with ntfsresize --info / resize2fs -P by the shell)
 * @param {number} neededMiB MiB to free (root + swap)
 * @param {{safetyMarginMiB?: number, minRemainingMiB?: number, rootMiB?: number, swapMiB?: number, diskSizeMiB?: number}} [opts]
 *   diskSizeMiB: when the new swap would end exactly at the device end,
 *   parted rejects the location — leave 1 MiB slack in that case.
 */
export function planAlongsideShrink(
  partitions,
  targetNum,
  fsMinMiB,
  neededMiB,
  opts = {},
) {
  const safetyMarginMiB = opts.safetyMarginMiB ?? ALONGSIDE_SAFETY_MARGIN_MIB;
  const minRemainingMiB = opts.minRemainingMiB ?? ALONGSIDE_MIN_REMAINING_MIB;
  const rootMiB = opts.rootMiB ?? SEVYN_ROOT_MIN_MIB;
  const swapMiB = opts.swapMiB ?? SEVYN_SWAP_MIB;

  const target = partitions.find((p) => p.num === targetNum);
  if (!target) {
    return { ok: false, error: `Partition ${targetNum} was not found.` };
  }
  if (!SUPPORTED_SHRINK_FILESYSTEMS.includes(target.fsType)) {
    return {
      ok: false,
      error:
        `Partition ${targetNum} uses "${target.fsType || "unknown"}", which the ` +
        `installer cannot resize safely. Use "Erase disk" or partition manually.`,
    };
  }
  if (!Number.isFinite(fsMinMiB) || fsMinMiB <= 0) {
    return {
      ok: false,
      error: `Could not determine how far partition ${targetNum} can shrink.`,
    };
  }

  const sizeMiB = Math.floor(target.sizeMiB);
  const shrinkToMiB = sizeMiB - neededMiB;
  if (shrinkToMiB < fsMinMiB + safetyMarginMiB) {
    return {
      ok: false,
      error:
        `Partition ${targetNum} (${sizeMiB} MiB) cannot free ${neededMiB} MiB: ` +
        `its filesystem needs at least ${Math.ceil(fsMinMiB + safetyMarginMiB)} MiB. ` +
        `Free up space inside that OS first, or use another mode.`,
    };
  }
  if (shrinkToMiB < minRemainingMiB) {
    return {
      ok: false,
      error:
        `Shrinking partition ${targetNum} would leave it with only ${shrinkToMiB} MiB. ` +
        `The installer keeps at least ${minRemainingMiB} MiB for the existing OS.`,
    };
  }

  const freeStartMiB = Math.floor(target.startMiB) + shrinkToMiB;
  const rootStartMiB = freeStartMiB;
  const rootEndMiB = rootStartMiB + rootMiB;
  const swapStartMiB = rootEndMiB;
  let swapEndMiB = swapStartMiB + swapMiB;
  const partEndMiB = Math.floor(target.endMiB);
  if (swapEndMiB > partEndMiB) {
    return {
      ok: false,
      error:
        `Partition ${targetNum} is too fragmented to host the new partitions ` +
        `after shrinking. Use manual partitioning.`,
    };
  }
  // parted rejects a partition end exactly at the device end ("location is
  // outside of the device"), so leave 1 MiB slack in that case.
  const diskSizeMiB = opts.diskSizeMiB;
  if (Number.isFinite(diskSizeMiB) && swapEndMiB >= Math.floor(diskSizeMiB)) {
    swapEndMiB = Math.floor(diskSizeMiB) - 1;
  }

  return {
    ok: true,
    partNum: targetNum,
    fsType: target.fsType,
    partName: target.name,
    currentSizeMiB: sizeMiB,
    shrinkToMiB,
    freedMiB: sizeMiB - shrinkToMiB,
    freeStartMiB,
    root: {
      startMiB: rootStartMiB,
      endMiB: rootEndMiB,
      fs: "ext4",
      label: "SEVYNOS_ROOT",
    },
    swap: {
      startMiB: swapStartMiB,
      endMiB: swapEndMiB,
      fs: "linux-swap",
      label: "SEVYN_SWAP",
    },
  };
}

/**
 * Validate a SevynOS username (POSIX portable, Debian adduser-compatible).
 * @param {string} name
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateUsername(name) {
  const value = String(name ?? "");
  const reserved = new Set([
    "root",
    "admin",
    "administrator",
    "guest",
    "system",
    "sevyn",
    "daemon",
    "bin",
    "sys",
    "nobody",
    "operator",
    "superuser",
  ]);
  if (value.length === 0) return { ok: false, error: "Username cannot be empty." };
  if (value.length > 32)
    return { ok: false, error: "Username must be at most 32 characters." };
  if (!/^[a-z_][a-z0-9_-]*$/.test(value)) {
    return {
      ok: false,
      error:
        "Username must start with a lowercase letter or underscore, followed by " +
        "lowercase letters, digits, underscores or hyphens.",
    };
  }
  if (reserved.has(value))
    return { ok: false, error: `"${value}" is reserved. Choose another username.` };
  return { ok: true };
}

/**
 * Validate a hostname (RFC 1035-ish, what installers accept).
 * @param {string} name
 * @returns {{ok: true, normalized: string} | {ok: false, error: string}}
 */
export function validateHostname(name) {
  const value = String(name ?? "")
    .trim()
    .toLowerCase();
  if (value.length === 0) return { ok: false, error: "Hostname cannot be empty." };
  if (value.length > 63)
    return { ok: false, error: "Hostname must be at most 63 characters." };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) {
    return {
      ok: false,
      error:
        "Hostname may only contain lowercase letters, digits and hyphens, " +
        "and must start and end with a letter or digit.",
    };
  }
  return { ok: true, normalized: value };
}

// ─── Minimal CLI for the shell installer ─────────────────────────────
// Commands print `key=value` lines (values are numbers or fixed tokens, so
// the shell can read them without eval). Errors print `ok=0` + `error=...`.
const [command, ...args] = process.argv.slice(2);

function printRecord(record) {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    process.stdout.write(`${key}=${String(value).replace(/\n/g, " ")}\n`);
  }
}

if (command === "erase-plan") {
  const diskMiB = Number(args[0]);
  const plan = planEraseLayout(diskMiB);
  if (!plan.ok) {
    printRecord({ ok: 0, error: plan.error });
  } else {
    const parts = Object.fromEntries(plan.partitions.map((p) => [p.name, p]));
    printRecord({
      ok: 1,
      bios_start: parts.BIOSBOOT.startMiB,
      bios_end: parts.BIOSBOOT.endMiB,
      esp_start: parts.SEVYN_EFI.startMiB,
      esp_end: parts.SEVYN_EFI.endMiB,
      root_start: parts.SevynOS.startMiB,
      root_end: parts.SevynOS.endMiB,
      swap_start: parts.swap.startMiB,
      disk_end: parts.swap.endMiB,
    });
  }
} else if (command === "parts-menu") {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.on("end", () => {
    const parts = parsePartedMachineOutput(text);
    printRecord({ ok: 1, count: parts.length });
    for (const p of parts) {
      // tag|description — the shell feeds tags+descriptions to dialog --menu
      process.stdout.write(
        `part:${p.num}=${p.sizeMiB.toFixed(0)} MiB ${p.fsType || "unknown"}${p.name ? ` "${p.name}"` : ""}${p.flags ? ` [${p.flags}]` : ""}\n`,
      );
    }
  });
} else if (command === "alongside-plan") {
  const targetNum = Number(args[0]);
  const fsMinMiB = Number(args[1]);
  const neededMiB = Number(args[2] ?? SEVYN_ROOT_MIN_MIB + SEVYN_SWAP_MIB);
  const diskSizeMiB = Number(args[3]);
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.on("end", () => {
    const parts = parsePartedMachineOutput(text);
    const plan = planAlongsideShrink(parts, targetNum, fsMinMiB, neededMiB, {
      diskSizeMiB: Number.isFinite(diskSizeMiB) ? diskSizeMiB : undefined,
    });
    if (!plan.ok) {
      printRecord({ ok: 0, error: plan.error });
    } else {
      printRecord({
        ok: 1,
        part_num: plan.partNum,
        fs_type: plan.fsType,
        current_size: plan.currentSizeMiB,
        shrink_to: plan.shrinkToMiB,
        freed: plan.freedMiB,
        free_start: plan.freeStartMiB,
        root_start: plan.root.startMiB,
        root_end: plan.root.endMiB,
        swap_start: plan.swap.startMiB,
        swap_end: plan.swap.endMiB,
      });
    }
  });
} else if (command === "validate-username") {
  const result = validateUsername(args[0] ?? "");
  printRecord(result.ok ? { ok: 1 } : { ok: 0, error: result.error });
} else if (command === "validate-hostname") {
  const result = validateHostname(args[0] ?? "");
  printRecord(
    result.ok ? { ok: 1, normalized: result.normalized } : { ok: 0, error: result.error },
  );
} else if (command !== undefined) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(2);
}
