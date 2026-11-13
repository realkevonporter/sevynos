// SevynOS v2 installer v2 — the Installer system app.
//
// The fresh-install wizard: Detect -> Choose disk -> Choose how to
// install -> Review the plan -> [Erase confirmation for destructive
// modes] -> Installing -> Done. It drives `sevyn install`
// (probe/plan/install) and shows the user exactly what will change
// before anything writes: the target disk, the mode, the new
// partitions, what is protected, and what is destroyed (whole-disk
// and wipe-portable modes name every partition they erase, and
// need a second explicit confirmation on a dedicated screen).
// Nothing writes before the Confirm button — the install verb
// itself also needs --yes, and re-probes first, aborting if the
// disk changed since the plan was shown.
//
// The installer is no longer Windows-only: it installs beside any
// detected OS (Windows, Linux, macOS), onto a whole disk, or
// portably onto a USB stick (no NVRAM entry — it boots on any
// machine from the stick). When exactly one installable disk is
// present the wizard picks it and shows its plan directly; with
// several disks it shows the picker.
//
// The app logs INSTALLER lines the harness asserts on: detected,
// plan shown, installed / failed.

import * as React from "react";
import { View, Text, Pressable, ScrollView } from "./host";
import { runCliAsync, parseField } from "./cli";

type DiskInfo = {
  path: string;
  sizeMb: number;
  model: string;
  transport: string;
  removable: boolean;
  windows: boolean;
  sevyn: boolean;
  linux: boolean;
  macos: boolean;
  osList: string;
  bootDisk: boolean;
  freeMb: number;
  gpt: boolean;
};

function parseProbe(out: string): DiskInfo[] {
  const disks: DiskInfo[] = [];
  let cur: DiskInfo | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("disk: ")) {
      if (cur) disks.push(cur);
      cur = {
        path: line.slice(6).trim(),
        sizeMb: 0,
        model: "",
        transport: "",
        removable: false,
        windows: false,
        sevyn: false,
        linux: false,
        macos: false,
        osList: "",
        bootDisk: false,
        freeMb: 0,
        gpt: true,
      };
    } else if (cur) {
      if (line.startsWith("disk-size-mb: "))
        cur.sizeMb = parseInt(line.slice(14).trim(), 10) || 0;
      else if (line.startsWith("disk-model: ")) cur.model = line.slice(12).trim();
      else if (line.startsWith("disk-transport: ")) cur.transport = line.slice(16).trim();
      else if (line.startsWith("disk-removable: "))
        cur.removable = line.slice(16).trim() === "yes";
      else if (line.startsWith("disk-windows: "))
        cur.windows = line.slice(14).trim() === "yes";
      else if (line.startsWith("disk-sevyn: "))
        cur.sevyn = line.slice(12).trim() === "yes";
      else if (line.startsWith("disk-linux: "))
        cur.linux = line.slice(12).trim() === "yes";
      else if (line.startsWith("disk-macos: "))
        cur.macos = line.slice(12).trim() === "yes";
      else if (line.startsWith("disk-os-list: ")) cur.osList = line.slice(14).trim();
      else if (line.startsWith("disk-boot-disk: "))
        cur.bootDisk = line.slice(16).trim() === "yes";
      else if (line.startsWith("disk-free-mb: "))
        cur.freeMb = parseInt(line.slice(14).trim(), 10) || 0;
      else if (line.startsWith("disk-gpt: ")) cur.gpt = line.slice(10).trim() === "yes";
    }
  }
  if (cur) disks.push(cur);
  return disks;
}

type Step =
  | "detect"
  | "pick"
  | "mode"
  | "confirm"
  | "wipe-confirm"
  | "installing"
  | "done"
  | "error";

type ModeChoice = {
  target: string;
  label: string;
  detail: string;
};

function modesFor(disk: DiskInfo): ModeChoice[] {
  const modes: ModeChoice[] = [];
  if (disk.freeMb >= 2016 || disk.sevyn) {
    const beside =
      disk.osList && disk.osList !== "-"
        ? "Install SevynOS beside " + disk.osList
        : "Install SevynOS in the free space";
    modes.push({
      target: "auto",
      label: beside,
      detail:
        "Uses the free space on the disk" +
        (disk.sevyn ? " (or replaces the old SevynOS install)" : "") +
        ". Your other operating systems are never touched.",
    });
  }
  if (disk.sevyn) {
    modes.push({
      target: "replace",
      label: "Replace the old SevynOS install",
      detail:
        "Removes the old SevynOS partitions and installs fresh in " +
        "their place. Your other operating systems are never touched.",
    });
  }
  modes.push({
    target: "whole",
    label: "Erase the disk and install SevynOS",
    detail:
      "Deletes EVERYTHING on this disk — all partitions, all " +
      "operating systems on it — and installs SevynOS on the whole " +
      "disk. Needs a second confirmation.",
  });
  if (disk.removable) {
    modes.push({
      target: "portable",
      label: "Portable install on this USB stick",
      detail:
        "Installs SevynOS on the stick so it boots on any machine. " +
        "No boot entry is written to this machine — the stick boots " +
        "from its own fallback bootloader.",
    });
  }
  return modes;
}

function installButtonLabel(mode: string, disk: DiskInfo): string {
  if (mode === "replace") return "Replace SevynOS";
  if (mode === "whole-disk") return "Erase disk and install SevynOS";
  if (mode === "portable") return "Install portable SevynOS on USB";
  if (disk.windows) return "Install SevynOS alongside Windows";
  if (disk.linux) return "Install SevynOS beside Linux";
  if (disk.macos) return "Install SevynOS beside macOS";
  return "Install SevynOS";
}

function formatSize(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  return mb + " MB";
}

export function Installer(): React.ReactElement {
  const [step, setStep] = React.useState<Step>("detect");
  const [disks, setDisks] = React.useState<DiskInfo[]>([]);
  const [target, setTarget] = React.useState<DiskInfo | null>(null);
  const [planText, setPlanText] = React.useState<string>("");
  const [planMode, setPlanMode] = React.useState<string>("");
  const [planTarget, setPlanTarget] = React.useState<string>("auto");
  const [planWipe, setPlanWipe] = React.useState<boolean>(false);
  const [message, setMessage] = React.useState<string>("");
  const [busy, setBusy] = React.useState<boolean>(false);
  const color = Sevyn.appColor;

  async function detect(): Promise<void> {
    setBusy(true);
    setMessage("");
    const { code, out } = await runCliAsync("sevyn install probe");
    setBusy(false);
    if (code !== 0) {
      setStep("error");
      setMessage("Could not list disks (" + out.trim() + ").");
      Sevyn.log("INSTALLER detect failed");
      return;
    }
    const found = parseProbe(out).filter((d) => d.path !== "none");
    setDisks(found);
    const installable = found.filter((d) => !d.bootDisk);
    if (installable.length === 0) {
      // No install target: show the picker with the (boot) disks
      // listed and the no-disk message, so the user sees why.
      setStep("pick");
      Sevyn.log("INSTALLER no target disk");
      return;
    }
    if (installable.length === 1) {
      const disk = installable[0];
      setTarget(disk);
      Sevyn.log(
        "INSTALLER detected disk=" +
          disk.path +
          " windows=" +
          (disk.windows ? "yes" : "no") +
          " sevyn=" +
          (disk.sevyn ? "yes" : "no") +
          " free-mb=" +
          disk.freeMb,
      );
      await showPlan(disk, "auto");
      return;
    }
    Sevyn.log("INSTALLER detected " + found.length + " disks, pick one");
    setStep("pick");
  }

  async function showPlan(disk: DiskInfo, planTargetArg: string): Promise<void> {
    setBusy(true);
    const { code, out } = await runCliAsync(
      "sevyn install plan --disk " + disk.path + " --target " + planTargetArg,
    );
    setBusy(false);
    if (code !== 0) {
      setStep("error");
      setMessage(out.trim() || "Could not compute the install plan.");
      Sevyn.log("INSTALLER plan failed disk=" + disk.path);
      return;
    }
    setPlanText(out);
    setPlanMode(parseField(out, "mode") ?? "");
    setPlanTarget(planTargetArg);
    setPlanWipe((parseField(out, "wipe") ?? "") === "yes");
    setStep("confirm");
    Sevyn.log(
      "INSTALLER plan disk=" + disk.path + " mode=" + (parseField(out, "mode") ?? "?"),
    );
  }

  async function install(): Promise<void> {
    if (!target) return;
    setStep("installing");
    setMessage("");
    const { code, out } = await runCliAsync(
      "sevyn install install --disk " +
        target.path +
        " --target " +
        planTarget +
        " --yes",
    );
    if (code !== 0) {
      setStep("error");
      setMessage(out.trim() || "The install failed.");
      Sevyn.log("INSTALLER failed disk=" + target.path);
      return;
    }
    setStep("done");
    Sevyn.log("INSTALLER installed disk=" + target.path);
  }

  function startOver(): void {
    setStep("detect");
    setTarget(null);
    setDisks([]);
    setPlanText("");
    setPlanMode("");
    setPlanTarget("auto");
    setPlanWipe(false);
    setMessage("");
    void detect();
  }

  React.useState(() => {
    void detect();
    return null;
  });

  const header = (
    <View
      style={{
        flexDirection: "row",
        height: 44,
        backgroundColor: color,
        alignItems: "center",
        paddingLeft: 16,
        paddingRight: 12,
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
        Installer
      </Text>
      <Text style={{ fontSize: 13, color: "#ffffff" }}>
        {step === "detect"
          ? "Detecting…"
          : step === "pick"
            ? "Choose a disk"
            : step === "mode"
              ? "How to install"
              : step === "confirm"
                ? "Review the plan"
                : step === "wipe-confirm"
                  ? "Erase the disk?"
                  : step === "installing"
                    ? "Installing…"
                    : step === "done"
                      ? "Done"
                      : step === "error"
                        ? "Something went wrong"
                        : "Plan"}
      </Text>
    </View>
  );

  function diskRow(disk: DiskInfo): React.ReactElement {
    const osText =
      disk.osList && disk.osList !== "-"
        ? disk.osList
        : disk.gpt
          ? "No operating system detected"
          : "No partition table";
    return (
      <Pressable
        key={disk.path}
        onPress={() => {
          if (disk.bootDisk) return;
          setTarget(disk);
          setStep("mode");
        }}
        style={{
          marginBottom: 12,
          borderRadius: 8,
          backgroundColor: disk.bootDisk ? "#f3f4f6" : "#ffffff",
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 10,
          paddingBottom: 10,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: "bold", color: "#111827" }}>
          {disk.path} · {formatSize(disk.sizeMb)}
        </Text>
        <Text style={{ fontSize: 14, color: "#374151", marginTop: 2 }}>
          {disk.model && disk.model !== "-" ? disk.model + " · " : ""}
          {disk.transport}
          {disk.removable ? " · USB, removable" : ""}
        </Text>
        <Text style={{ fontSize: 14, color: "#374151", marginTop: 2 }}>
          {osText} · {formatSize(disk.freeMb)} free
        </Text>
        {disk.bootDisk && (
          <Text style={{ fontSize: 14, color: "#b91c1c", marginTop: 2 }}>
            This is the disk you booted from — it can&apos;t be an install target.
          </Text>
        )}
      </Pressable>
    );
  }

  function modeSummary(): string {
    if (!target) return "";
    if (planMode === "replace")
      return "An old SevynOS install was found — its partitions will be replaced. ";
    if (planMode === "whole-disk")
      return (
        "The ENTIRE disk " +
        target.path +
        " will be erased — every partition on it will be destroyed — " +
        "and SevynOS will be installed on the whole disk. "
      );
    if (planMode === "portable")
      return (
        "SevynOS will install on the USB stick " +
        target.path +
        " as a portable system. It will boot on any machine from the " +
        "stick. "
      );
    if (target.windows)
      return "SevynOS will install alongside Windows 11 on " + target.path + ". ";
    if (target.linux) return "SevynOS will install beside Linux on " + target.path + ". ";
    if (target.macos) return "SevynOS will install beside macOS on " + target.path + ". ";
    return "SevynOS will install in the free space on " + target.path + ". ";
  }

  function destroyedList(): string {
    for (const line of planText.split("\n")) {
      if (line.startsWith("destroyed: ")) return line.slice(11).trim();
    }
    return "";
  }

  const body = (
    <ScrollView style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
      {step === "detect" && (
        <Text style={{ fontSize: 15, color: "#374151" }}>
          {busy ? "Looking for disks and existing installs…" : "Detecting disks…"}
        </Text>
      )}
      {step === "pick" && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 12 }}>
            Choose the disk to install SevynOS on.
          </Text>
          {disks.map((d) => diskRow(d))}
          {disks.filter((d) => !d.bootDisk).length === 0 && (
            <Text style={{ fontSize: 15, color: "#b91c1c" }}>
              No disk available to install onto.
            </Text>
          )}
          <Pressable
            onPress={() => void detect()}
            style={{
              marginTop: 4,
              height: 36,
              borderRadius: 8,
              backgroundColor: "#e5e7eb",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>Refresh</Text>
          </Pressable>
        </View>
      )}
      {step === "mode" && target && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 12 }}>
            How should SevynOS install on {target.path}?
          </Text>
          {modesFor(target).map((m) => (
            <Pressable
              key={m.target}
              onPress={() => void showPlan(target, m.target)}
              style={{
                marginBottom: 12,
                borderRadius: 8,
                backgroundColor: "#ffffff",
                paddingLeft: 12,
                paddingRight: 12,
                paddingTop: 10,
                paddingBottom: 10,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: "bold", color: "#111827" }}>
                {m.label}
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 2 }}>
                {m.detail}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setStep("pick")}
            style={{
              marginTop: 4,
              height: 36,
              borderRadius: 8,
              backgroundColor: "#e5e7eb",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>Back to disks</Text>
          </Pressable>
        </View>
      )}
      {step === "confirm" && target && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 8 }}>
            {modeSummary()}
            {planMode === "whole-disk" || planMode === "portable"
              ? ""
              : target.osList && target.osList !== "-"
                ? target.osList + " is never touched."
                : ""}
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: "#111827",
              backgroundColor: "#ffffff",
              borderRadius: 8,
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 10,
              paddingBottom: 10,
            }}
          >
            {planText}
          </Text>
          <Pressable
            onPress={() => {
              if (planWipe) setStep("wipe-confirm");
              else void install();
            }}
            style={{
              marginTop: 16,
              height: 44,
              borderRadius: 8,
              backgroundColor: "#2563eb",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff" }}>
              {installButtonLabel(planMode, target)}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void detect()}
            style={{
              marginTop: 12,
              height: 36,
              borderRadius: 8,
              backgroundColor: "#e5e7eb",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>Cancel</Text>
          </Pressable>
        </View>
      )}
      {step === "wipe-confirm" && target && (
        <View style={{ flexDirection: "column" }}>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "bold",
              color: "#b91c1c",
              marginBottom: 8,
            }}
          >
            Erase the entire disk?
          </Text>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 8 }}>
            This deletes EVERYTHING on {target.path}
            {destroyedList() && !destroyedList().startsWith("none")
              ? " — partitions " + destroyedList() + " will be destroyed"
              : ""}
            , including every operating system on it. This cannot be undone.
          </Text>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 8 }}>
            Make sure you have a backup of anything you need from this disk.
          </Text>
          <Pressable
            onPress={() => void install()}
            style={{
              marginTop: 8,
              height: 44,
              borderRadius: 8,
              backgroundColor: "#b91c1c",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff" }}>
              Yes, erase the entire disk
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setStep("confirm")}
            style={{
              marginTop: 12,
              height: 36,
              borderRadius: 8,
              backgroundColor: "#e5e7eb",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>Go back</Text>
          </Pressable>
        </View>
      )}
      {step === "installing" && (
        <Text style={{ fontSize: 15, color: "#374151" }}>
          Installing SevynOS on {target ? target.path : "…"} — creating partitions,
          staging the bootloader, and verifying your other operating systems are
          untouched. Do not power off.
        </Text>
      )}
      {step === "done" && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 17, fontWeight: "bold", color: "#111827" }}>
            SevynOS is installed.
          </Text>
          <Text style={{ fontSize: 15, color: "#374151", marginTop: 8 }}>
            {planMode === "portable"
              ? "Reboot from the USB stick on any machine and pick SevynOS from " +
                "the boot menu. Nothing was written to this machine's disks."
              : planMode === "whole-disk"
                ? "Reboot and SevynOS will start. The disk was erased as confirmed."
                : "Reboot and pick SevynOS or your other operating system from the " +
                  "boot menu. Your other operating systems were not touched."}
          </Text>
        </View>
      )}
      {step === "error" && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 15, color: "#b91c1c" }}>{message}</Text>
          <Pressable
            onPress={() => startOver()}
            style={{
              marginTop: 16,
              height: 36,
              borderRadius: 8,
              backgroundColor: "#e5e7eb",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>Try again</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "column",
        backgroundColor: "#f9fafb",
      }}
    >
      {header}
      {body}
    </View>
  );
}
