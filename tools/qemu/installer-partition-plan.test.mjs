import assert from "node:assert/strict";
import test from "node:test";
import {
  ALONGSIDE_SAFETY_MARGIN_MIB,
  planAlongsideShrink,
  planEraseLayout,
  parsePartedMachineOutput,
  validateHostname,
  validateUsername,
} from "./installer-partition-plan.mjs";

test("erase layout matches the historical geometry on a 32 GiB disk", () => {
  const plan = planEraseLayout(32768);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.partitions, [
    { name: "BIOSBOOT", startMiB: 1, endMiB: 3, type: "bios_grub" },
    {
      name: "SEVYN_EFI",
      startMiB: 3,
      endMiB: 515,
      fs: "fat32",
      flags: ["esp"],
      label: "SEVYN_EFI",
    },
    {
      name: "SevynOS",
      startMiB: 516,
      endMiB: 28671,
      fs: "ext4",
      label: "SEVYNOS_ROOT",
    },
    {
      name: "swap",
      startMiB: 28672,
      endMiB: 32768,
      fs: "linux-swap",
      label: "SEVYN_SWAP",
    },
  ]);
});

test("erase layout refuses disks that are too small", () => {
  const plan = planEraseLayout(20000);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /too small/);
});

test("erase layout rejects invalid sizes", () => {
  assert.equal(planEraseLayout(0).ok, false);
  assert.equal(planEraseLayout(Number.NaN).ok, false);
  assert.equal(planEraseLayout(-5).ok, false);
});

test("erase layout is contiguous: root starts where ESP ends", () => {
  const plan = planEraseLayout(65536);
  assert.equal(plan.ok, true);
  const [bios, esp, root, swap] = plan.partitions;
  assert.equal(esp.startMiB, bios.endMiB);
  assert.equal(root.startMiB, esp.endMiB + 1);
  assert.equal(swap.startMiB, swap.endMiB - 4096);
  assert.ok(root.endMiB - root.startMiB >= 20480);
});

const SAMPLE_PARTED = `BYT;
/dev/sda:500107862016B:scsi:512:512:gpt:ATA QEMU HARDDISK:;
1:1.00MiB:515.00MiB:514.00MiB:fat32:EFI System Partition:esp;
2:515.00MiB:200000.00MiB:199485.00MiB:ntfs:Windows:msftdata;
3:200000.00MiB:476940.00MiB:276940.00MiB:ext4:Linux:;
`;

test("parses parted --machine output", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[1], {
    num: 2,
    startMiB: 515,
    endMiB: 200000,
    sizeMiB: 199485,
    fsType: "ntfs",
    name: "Windows",
    flags: "msftdata",
  });
  assert.equal(parts[0].flags, "esp");
});

test("alongside shrink plans exact geometry", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  // fsMin 150000 MiB probed via ntfsresize --info; need 24576 MiB
  const plan = planAlongsideShrink(parts, 2, 150000, 24576);
  assert.equal(plan.ok, true);
  assert.equal(plan.shrinkToMiB, 199485 - 24576);
  assert.equal(plan.freeStartMiB, 515 + plan.shrinkToMiB);
  assert.equal(plan.root.startMiB, plan.freeStartMiB);
  assert.equal(plan.root.endMiB - plan.root.startMiB, 20480);
  assert.equal(plan.swap.endMiB - plan.swap.startMiB, 4096);
  assert.ok(plan.swap.endMiB <= 200000);
});

test("alongside shrink refuses unsupported filesystems", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  const plan = planAlongsideShrink(parts, 1, 100, 24576);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /cannot resize safely/);
});

test("alongside shrink refuses when the filesystem is too full", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  // fs needs 190000 MiB but only 199485 exist: 9485 free < 24576 needed + margin
  const plan = planAlongsideShrink(parts, 2, 190000, 24576);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /cannot free/);
});

test("alongside shrink keeps the safety margin past the fs minimum", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  const fsMin = 199485 - 24576 - (ALONGSIDE_SAFETY_MARGIN_MIB - 1);
  const plan = planAlongsideShrink(parts, 2, fsMin, 24576);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /cannot free/);
});

test("alongside shrink leaves slack when swap would hit the device end", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  // Partition 3 ends at 476940 MiB; pretend the disk is exactly that size.
  const plan = planAlongsideShrink(parts, 3, 200000, 24576, {
    diskSizeMiB: 476940,
    rootMiB: 20480,
    swapMiB: 4096,
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.swap.endMiB < 476940);
  assert.equal(plan.swap.endMiB, 476939);
});

test("alongside shrink refuses an unknown partition number", () => {
  const parts = parsePartedMachineOutput(SAMPLE_PARTED);
  const plan = planAlongsideShrink(parts, 9, 100, 24576);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /not found/);
});

test("username validation", () => {
  assert.deepEqual(validateUsername("kevon"), { ok: true });
  assert.deepEqual(validateUsername("anna_99"), { ok: true });
  assert.deepEqual(validateUsername("a-b"), { ok: true });
  assert.equal(validateUsername("").ok, false);
  assert.equal(validateUsername("Root").ok, false);
  assert.equal(validateUsername("root").ok, false);
  assert.equal(validateUsername("9lives").ok, false);
  assert.equal(validateUsername("has space").ok, false);
  assert.equal(validateUsername("UPPER").ok, false);
  assert.equal(validateUsername("a".repeat(33)).ok, false);
});

test("hostname validation", () => {
  assert.deepEqual(validateHostname("SevynBox"), {
    ok: true,
    normalized: "sevynbox",
  });
  assert.deepEqual(validateHostname("  my-pc1  "), {
    ok: true,
    normalized: "my-pc1",
  });
  assert.equal(validateHostname("").ok, false);
  assert.equal(validateHostname("-bad").ok, false);
  assert.equal(validateHostname("bad-").ok, false);
  assert.equal(validateHostname("has space").ok, false);
  assert.equal(validateHostname("a".repeat(64)).ok, false);
});
