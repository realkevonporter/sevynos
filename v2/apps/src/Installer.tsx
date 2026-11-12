// SevynOS v2 M11 — the Installer system app (dual-boot install).
//
// The fresh-install wizard: Detect -> Plan -> Confirm -> Installing
// -> Done. It drives `sevyn install` (probe/plan/install) and shows
// the user exactly what will change before anything writes: the
// target disk, the new partitions, what is protected (Windows), and
// what is replaced (an old SevynOS install, if any). Nothing writes
// before the explicit Confirm button — the install verb itself also
// needs --yes, and re-probes first, aborting if the disk changed
// since the plan was shown.
//
// The app logs INSTALLER lines the harness asserts on: detected,
// plan shown, installed / failed.

import * as React from "react";
import { View, Text, Pressable, ScrollView } from "./host";
import { runCliAsync, parseField } from "./cli";

type DiskInfo = {
  path: string;
  windows: boolean;
  sevyn: boolean;
  bootDisk: boolean;
  freeMb: number;
};

function parseProbe(out: string): DiskInfo[] {
  const disks: DiskInfo[] = [];
  let cur: DiskInfo | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("disk: ")) {
      if (cur) disks.push(cur);
      cur = {
        path: line.slice(6).trim(),
        windows: false,
        sevyn: false,
        bootDisk: false,
        freeMb: 0,
      };
    } else if (cur) {
      if (line.startsWith("disk-windows: "))
        cur.windows = line.slice(14).trim() === "yes";
      else if (line.startsWith("disk-sevyn: "))
        cur.sevyn = line.slice(12).trim() === "yes";
      else if (line.startsWith("disk-boot-disk: "))
        cur.bootDisk = line.slice(16).trim() === "yes";
      else if (line.startsWith("disk-free-mb: "))
        cur.freeMb = parseInt(line.slice(14).trim(), 10) || 0;
    }
  }
  if (cur) disks.push(cur);
  return disks;
}

type Step = "detect" | "plan" | "confirm" | "installing" | "done" | "error";

export function Installer(): React.ReactElement {
  const [step, setStep] = React.useState<Step>("detect");
  const [target, setTarget] = React.useState<DiskInfo | null>(null);
  const [planText, setPlanText] = React.useState<string>("");
  const [planMode, setPlanMode] = React.useState<string>("");
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
    const disks = parseProbe(out);
    // The install target is a non-boot disk carrying Windows.
    const found = disks.find((d) => d.windows && !d.bootDisk) ?? null;
    setTarget(found);
    if (!found) {
      setStep("error");
      setMessage(
        disks.length === 0
          ? "No disks found."
          : "No Windows disk found to install alongside.",
      );
      Sevyn.log("INSTALLER no target disk");
      return;
    }
    Sevyn.log(
      "INSTALLER detected disk=" +
        found.path +
        " windows=yes sevyn=" +
        (found.sevyn ? "yes" : "no") +
        " free-mb=" +
        found.freeMb,
    );
    await showPlan(found);
  }

  async function showPlan(disk: DiskInfo): Promise<void> {
    setBusy(true);
    const { code, out } = await runCliAsync("sevyn install plan --disk " + disk.path);
    setBusy(false);
    if (code !== 0) {
      setStep("error");
      setMessage(out.trim() || "Could not compute the install plan.");
      Sevyn.log("INSTALLER plan failed disk=" + disk.path);
      return;
    }
    setPlanText(out);
    setPlanMode(parseField(out, "mode") ?? "");
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
      "sevyn install install --disk " + target.path + " --yes",
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
    setPlanText("");
    setPlanMode("");
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
          : step === "confirm"
            ? "Review the plan"
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

  const body = (
    <ScrollView style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
      {step === "detect" && (
        <Text style={{ fontSize: 15, color: "#374151" }}>
          {busy ? "Looking for disks and existing installs…" : "Detecting disks…"}
        </Text>
      )}
      {step === "confirm" && target && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 8 }}>
            SevynOS will install alongside Windows 11 on{" "}
            <Text style={{ fontWeight: "bold" }}>{target.path}</Text>.
          </Text>
          <Text style={{ fontSize: 15, color: "#111827", marginBottom: 8 }}>
            {planMode === "replace"
              ? "An old SevynOS install was found — its partitions will be replaced. "
              : "Free space on the disk will be used. "}
            Windows is never touched.
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
            onPress={() => void install()}
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
              Install SevynOS alongside Windows
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
      {step === "installing" && (
        <Text style={{ fontSize: 15, color: "#374151" }}>
          Installing SevynOS on {target ? target.path : "…"} — creating partitions,
          staging the bootloader, and verifying Windows is untouched. Do not power off.
        </Text>
      )}
      {step === "done" && (
        <View style={{ flexDirection: "column" }}>
          <Text style={{ fontSize: 17, fontWeight: "bold", color: "#111827" }}>
            SevynOS is installed.
          </Text>
          <Text style={{ fontSize: 15, color: "#374151", marginTop: 8 }}>
            Reboot and pick SevynOS or Windows 11 from the boot menu. Windows was not
            touched.
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
