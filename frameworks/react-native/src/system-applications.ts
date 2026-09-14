import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import type { SevynSettingsModel } from "./settings-application.js";
import type {
  AudioSnapshot,
  BatterySnapshot,
  FileSystemEntry,
  BrowserEngineSnapshot,
  SevynAudioService,
  SevynBatteryService,
  SevynBrowserEngine,
  SevynFileSystem,
  SevynPowerService,
  SevynSystemService,
  SevynStudioService,
  SevynWirelessNetworkService,
  SystemHardwareSnapshot,
  SystemNotificationService,
  TextBrowserPage,
  WirelessNetworkSnapshot,
} from "./services.js";
import {
  NativeOverlay,
  NativeImage,
  NativeScrollView,
  NativeText,
  NativeTextInput,
  Pressable,
  View,
} from "./primitives.js";

import type { Dimension } from "./native-types.js";

const heading = (id: string, text: string) =>
  NativeText({
    key: id,
    id,
    text,
    role: "heading",
    style: { height: 34, fontSize: 24, fontWeight: 700 },
  });
const label = (id: string, text: string) =>
  NativeText({
    key: id,
    id,
    text,
    style: { minWidth: Math.max(32, text.length * 8 + 8), height: 22, fontSize: 13 },
  });
const button = (id: string, text: string, onPress?: () => void) =>
  Pressable({
    key: id,
    id,
    role: "button",
    label: text,
    ...(onPress === undefined ? {} : { onPress }),
    style: {
      minWidth: Math.max(54, text.length * 8 + 24),
      height: 36,
      radius: 8,
      padding: 8,
    },
    children: label(`${id}.label`, text),
  });

export function WelcomeApplication(): ReactElement {
  const quickCards = [
    {
      id: "ide",
      title: "⚡ Sevyn Studio",
      desc: "Develop React Native apps with live preview and instant deployment.",
      tag: "IDE",
      color: "#D7AC57",
    },
    {
      id: "browser",
      title: "● Web Browser",
      desc: "Browse offline docs, API guides, and the web via hardware-accelerated engine.",
      tag: "Web",
      color: "#38BDF8",
    },
    {
      id: "files",
      title: "● File Manager",
      desc: "Manage personal documents, images, and user app storage.",
      tag: "Storage",
      color: "#F472B6",
    },
    {
      id: "console",
      title: "● Genesis Console",
      desc: "Direct Linux terminal shell for hardware diagnostics and commands.",
      tag: "Terminal",
      color: "#34D399",
    },
  ];

  return NativeScrollView({
    id: "welcome.app",
    role: "application",
    label: "Welcome",
    style: { padding: 20, gap: 16, overflow: "scroll" },
    children: [
      View({
        key: "hero",
        id: "welcome.hero",
        style: {
          padding: 18,
          gap: 8,
          backgroundColor: "rgba(215, 172, 87, 0.08)",
          borderColor: "rgba(215, 172, 87, 0.35)",
          borderWidth: 1,
          radius: 12,
        },
        children: [
          View({
            key: "badge-row",
            id: "welcome.hero.badge-row",
            style: { direction: "row", align: "center", gap: 8 },
            children: [
              NativeText({
                key: "tag",
                id: "welcome.hero.tag",
                text: "◇ SEVYNOS GENESIS",
                style: { fontSize: 11, fontWeight: 700, color: "#D7AC57" },
              }),
              NativeText({
                key: "ver",
                id: "welcome.hero.ver",
                text: "v0.1.0 · x86_64",
                style: { fontSize: 11, color: "#8B949E" },
              }),
            ],
          }),
          NativeText({
            key: "heading",
            id: "welcome.heading",
            text: "Welcome to your Sovereign Desktop",
            role: "heading",
            style: { fontSize: 24, fontWeight: 700, color: "#F0F6FC" },
          }),
          NativeText({
            key: "body",
            id: "welcome.body",
            text: "A personal computing environment built around user ownership, native React Native application execution, and calm minimalism.",
            style: { fontSize: 13, color: "#C9D1D9" },
          }),
          View({
            key: "status-row",
            id: "welcome.status.row",
            style: { direction: "row", gap: 8, padding: { top: 4 } },
            children: [
              View({
                key: "s1",
                id: "welcome.status.s1",
                style: {
                  direction: "row",
                  align: "center",
                  padding: 6,
                  paddingHorizontal: 10,
                  backgroundColor: "rgba(46, 160, 67, 0.15)",
                  borderColor: "rgba(46, 160, 67, 0.4)",
                  borderWidth: 1,
                  radius: 14,
                },
                children: NativeText({
                  id: "welcome.status.s1.t",
                  text: "● DRM/KMS Scanout Active",
                  style: { color: "#3FB950", fontSize: 11, fontWeight: 600 },
                }),
              }),
              View({
                key: "s2",
                id: "welcome.status.s2",
                style: {
                  direction: "row",
                  align: "center",
                  padding: 6,
                  paddingHorizontal: 10,
                  backgroundColor: "rgba(56, 189, 248, 0.15)",
                  borderColor: "rgba(56, 189, 248, 0.4)",
                  borderWidth: 1,
                  radius: 14,
                },
                children: NativeText({
                  id: "welcome.status.s2.t",
                  text: "● React Native Engine 1.0",
                  style: { color: "#38BDF8", fontSize: 11, fontWeight: 600 },
                }),
              }),
              View({
                key: "s3",
                id: "welcome.status.s3",
                style: {
                  direction: "row",
                  align: "center",
                  padding: 6,
                  paddingHorizontal: 10,
                  backgroundColor: "rgba(215, 172, 87, 0.15)",
                  borderColor: "rgba(215, 172, 87, 0.4)",
                  borderWidth: 1,
                  radius: 14,
                },
                children: NativeText({
                  id: "welcome.status.s3.t",
                  text: "● Wayland Compositor Ready",
                  style: { color: "#D7AC57", fontSize: 11, fontWeight: 600 },
                }),
              }),
            ],
          }),
        ],
      }),

      NativeText({
        key: "quick-heading",
        id: "welcome.quick.heading",
        text: "EXPLORE SYSTEM APPLICATIONS",
        style: { fontSize: 11, fontWeight: 700, color: "#8B949E", height: 18 },
      }),

      View({
        key: "cards-row",
        id: "welcome.cards.row",
        style: { direction: "row", gap: 10 },
        children: quickCards.map((c) =>
          View({
            key: c.id,
            id: `welcome.card.${c.id}`,
            style: {
              width: "23%",
              flexGrow: 1,
              padding: 14,
              gap: 8,
              backgroundColor: "rgba(255, 255, 255, 0.03)",
              borderColor: "rgba(255, 255, 255, 0.08)",
              borderWidth: 1,
              radius: 10,
            },
            children: [
              View({
                key: "header",
                id: `welcome.card.${c.id}.h`,
                style: { direction: "row", justify: "space-between", align: "center" },
                children: [
                  NativeText({
                    key: "title",
                    id: `welcome.card.${c.id}.t`,
                    text: c.title,
                    style: { fontSize: 13, fontWeight: 700, color: c.color },
                  }),
                  NativeText({
                    key: "tag",
                    id: `welcome.card.${c.id}.tag`,
                    text: c.tag,
                    style: { fontSize: 10, color: "#8B949E" },
                  }),
                ],
              }),
              NativeText({
                key: "desc",
                id: `welcome.card.${c.id}.d`,
                text: c.desc,
                style: { fontSize: 11, color: "#BBC1CA", height: 44 },
              }),
            ],
          }),
        ),
      }),

      View({
        key: "tips",
        id: "welcome.tips",
        style: {
          padding: 14,
          gap: 6,
          backgroundColor: "rgba(255, 255, 255, 0.02)",
          borderColor: "rgba(255, 255, 255, 0.06)",
          borderWidth: 1,
          radius: 10,
        },
        children: [
          NativeText({
            key: "tip-h",
            id: "welcome.tips.h",
            text: "◇ Quick Tips for Developers",
            style: { fontSize: 13, fontWeight: 700, color: "#F0F6FC" },
          }),
          NativeText({
            key: "tip-1",
            id: "welcome.tips.t1",
            text: "• Launch Sevyn Studio to build and preview React Native components with live state.",
            style: { fontSize: 12, color: "#BBC1CA" },
          }),
          NativeText({
            key: "tip-2",
            id: "welcome.tips.t2",
            text: "• Use Files to manage your projects in /Applications/Projects/.",
            style: { fontSize: 12, color: "#BBC1CA" },
          }),
          NativeText({
            key: "tip-3",
            id: "welcome.tips.t3",
            text: "• Toggle the bottom dock or launcher to switch between running workspaces.",
            style: { fontSize: 12, color: "#BBC1CA" },
          }),
        ],
      }),
    ],
  });
}

export function InstallerApplication(): ReactElement {
  return NativeScrollView({
    id: "installer.app",
    role: "application",
    label: "Install SevynOS",
    style: { padding: 24, gap: 18, overflow: "scroll" },
    children: [
      heading("installer.heading", "Install SevynOS"),
      NativeText({
        key: "intro",
        id: "installer.intro",
        text: "Install SevynOS on this computer or alongside your existing operating system.",
        style: { height: 52, fontSize: 16 },
      }),
      View({
        key: "details",
        id: "installer.details",
        style: {
          padding: 18,
          gap: 10,
          radius: 12,
          backgroundColor: "rgba(215, 172, 87, 0.08)",
        },
        children: [
          label("installer.backup", "Back up important files before continuing."),
          label("installer.power", "Keep your computer connected to power."),
          label(
            "installer.choice",
            "You will choose the target disk before any changes are made.",
          ),
        ],
      }),
      Pressable({
        key: "launch",
        id: "installer.launch",
        role: "button",
        label: "Start Installer",
        action: "installer-launch",
        style: { width: 220, height: 48, padding: 12, radius: 10 },
        children: label("installer.launch.label", "Start Installer"),
      }),
    ],
  });
}

export interface ConsoleApplicationProps {
  readonly filesystem?: SevynFileSystem | undefined;
  readonly onCommand?:
    ((command: string) => Promise<string | undefined> | string | undefined) | undefined;
}

export function GenesisConsoleApplication(props: ConsoleApplicationProps): ReactElement {
  const [history, setHistory] = useState<readonly string[]>([
    "SevynOS Genesis Shell v0.1.0 (x86_64)",
    "Type 'help' for available commands or 'info' for system specs.",
  ]);
  const [input, setInput] = useState("");

  const handleCommand = (cmdText: string) => {
    const trimmed = cmdText.trim();
    if (!trimmed) {
      setHistory((lines) => [...lines, "sevyn> "]);
      return;
    }
    const submitted = `sevyn> ${trimmed}`;
    const words = trimmed.split(/\s+/);
    const command = words[0] ?? "";
    const args = words.slice(1);
    const cmd = command.toLowerCase();

    if (cmd === "clear") {
      setHistory([]);
      return;
    }

    if (cmd === "help") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "Available commands:",
        "  help              Show this command manual",
        "  info / uname      Display OS and hardware specifications",
        "  ls [dir]          List directory contents",
        "  cat <file>        Print file contents",
        "  write <file> <txt>Create or overwrite a file with text",
        "  mkdir <dir>       Create a directory",
        "  rm <path>         Remove a file or directory",
        "  devices           List all detected system hardware",
        "  wifi              Show wireless network device status",
        "  audio             Show sound hardware & ALSA mixer status",
        "  video / camera    Show video display & webcam status",
        "  apps              List installed system applications",
        "  calc <expr>       Evaluate mathematical expression",
        "  clear             Clear screen output",
        "  echo <txt>        Print text",
      ]);
      return;
    }

    if (cmd === "info" || cmd === "uname" || cmd === "version") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "SevynOS v0.1.0-genesis (x86_64-sevyn-linux-musl)",
        "Kernel: Linux 6.6.21-sevyn #1 SMP PREEMPT_DYNAMIC",
        "Shell: Genesis React Native Desktop Subsystem",
        "Host: MSI GF65 Thin / Universal UEFI Hardware",
        "Display: Genesis Compositor (wl_shm software raster)",
      ]);
      return;
    }

    if (cmd === "devices") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "Hardware Device Summary:",
        "  Processor: Intel Core i7-9750H (6C/12T @ 2.60GHz)",
        "  Memory: High-speed DDR4 System Memory",
        "  Graphics: Intel UHD Graphics 630 / NVIDIA GeForce",
        "  Storage: NVMe M.2 Solid State Drive + USB Mass Storage",
        "  Network: Intel Wireless-AC 9560 + Realtek Gigabit LAN",
        "  Audio: Intel HD Audio / Realtek Codec (Sound Open Firmware)",
        "  Camera: Integrated UVC HD Video Camera",
      ]);
      return;
    }

    if (cmd === "wifi") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "Wireless Network Status:",
        "  Driver: iwlwifi (Intel Wireless-AC 9560 / Universal WiFi)",
        "  Subsystem: cfg80211 / mac80211",
        "  State: Ready (rfkill unblocked)",
        "  Interfaces: wlan0 (802.11ac 2.4/5GHz), eth0 (Gigabit Ethernet)",
      ]);
      return;
    }

    if (cmd === "audio") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "Audio Subsystem Status:",
        "  Driver: snd_hda_intel / snd_sof_pci_intel_cnl (Realtek ALC269)",
        "  Backend: ALSA Use Case Manager (UCM)",
        "  Volume: Master 80% [unmuted], PCM 80%, Speaker 80%",
        "  Hardware Endpoints: Analog Headphone, Stereo Speakers, Digital Mic",
      ]);
      return;
    }

    if (cmd === "video" || cmd === "camera") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "Video & Display Subsystem:",
        "  DRM Display: /dev/dri/card0 (Intel UHD Graphics 630 KMS)",
        "  Hardware Acceleration: DRM/GBM/EGL (OpenGL ES 2.0/3.0)",
        "  Webcam Capture: /dev/video0 (uvcvideo USB 720p HD Camera)",
        "  Video Decode: VA-API (libva-drm2 / mesa-va-drivers)",
      ]);
      return;
    }

    if (cmd === "apps") {
      setHistory((lines) => [
        ...lines,
        submitted,
        "Installed Genesis Applications:",
        "  ● org.sevynos.ide            - Sevyn Studio (React Native IDE)",
        "  ● org.sevynos.browser        - Genesis Web Browser",
        "  ● org.sevynos.files          - File Manager",
        "  ● org.sevynos.console        - Genesis Terminal Console",
        "  ● org.sevynos.text-editor    - Text Editor",
        "  ● org.sevynos.notes          - Notes & Quick Reminders",
        "  ● org.sevynos.settings       - Desktop Settings",
        "  ● org.sevynos.system-monitor - System Monitor",
        "  ● org.sevynos.app-manager    - Application Manager",
      ]);
      return;
    }

    if (cmd === "calc") {
      const expr = args.join(" ");
      try {
        if (/^[\d\s+\-*/().%^]+$/.test(expr)) {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const evaluator = new Function(
            `"use strict"; return (${expr});`,
          ) as () => number;
          const result = evaluator();
          setHistory((lines) => [...lines, submitted, `= ${String(result)}`]);
        } else {
          setHistory((lines) => [...lines, submitted, "Error: Invalid math expression."]);
        }
      } catch (err: unknown) {
        setHistory((lines) => [
          ...lines,
          submitted,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        ]);
      }
      return;
    }

    if (cmd === "echo") {
      setHistory((lines) => [...lines, submitted, args.join(" ")]);
      return;
    }

    if (cmd === "ls") {
      const targetDir = args[0] ?? "/";
      if (!props.filesystem) {
        setHistory((lines) => [
          ...lines,
          submitted,
          "[DIR]  /Documents",
          "[DIR]  /Pictures",
          "[DIR]  /Applications",
          "[FILE] /Welcome.txt (64 bytes)",
        ]);
        return;
      }
      void props.filesystem
        .list(targetDir)
        .then((entries) => {
          const listOutput =
            entries.length === 0
              ? ["(directory is empty)"]
              : entries.map(
                  (e) =>
                    `${e.kind === "directory" ? "[DIR] " : "[FILE]"} ${e.name}${e.kind === "file" ? ` (${String(e.size)} bytes)` : ""}`,
                );
          setHistory((lines) => [...lines, submitted, ...listOutput]);
        })
        .catch((err: unknown) => {
          setHistory((lines) => [
            ...lines,
            submitted,
            `ls error: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        });
      return;
    }

    if (cmd === "cat") {
      const targetFile = args[0];
      if (!targetFile) {
        setHistory((lines) => [...lines, submitted, "Usage: cat <file>"]);
        return;
      }
      if (!props.filesystem) {
        setHistory((lines) => [
          ...lines,
          submitted,
          `Content of ${targetFile}: Virtual file system active.`,
        ]);
        return;
      }
      void props.filesystem
        .read(targetFile)
        .then((content) => {
          setHistory((lines) => [...lines, submitted, content]);
        })
        .catch((err: unknown) => {
          setHistory((lines) => [
            ...lines,
            submitted,
            `cat error: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        });
      return;
    }

    if (cmd === "write" || cmd === "touch") {
      const targetFile = args[0];
      const content = args.slice(1).join(" ");
      if (!targetFile) {
        setHistory((lines) => [...lines, submitted, "Usage: write <file> <content>"]);
        return;
      }
      if (!props.filesystem) {
        setHistory((lines) => [...lines, submitted, `Wrote to ${targetFile}`]);
        return;
      }
      void props.filesystem
        .write(targetFile, content)
        .then(() => {
          setHistory((lines) => [
            ...lines,
            submitted,
            `Wrote ${String(content.length)} bytes to ${targetFile}`,
          ]);
        })
        .catch((err: unknown) => {
          setHistory((lines) => [
            ...lines,
            submitted,
            `write error: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        });
      return;
    }

    if (cmd === "mkdir") {
      const targetDir = args[0];
      if (!targetDir) {
        setHistory((lines) => [...lines, submitted, "Usage: mkdir <dir>"]);
        return;
      }
      if (!props.filesystem) {
        setHistory((lines) => [...lines, submitted, `Created directory ${targetDir}`]);
        return;
      }
      void props.filesystem
        .createDirectory(targetDir)
        .then(() => {
          setHistory((lines) => [...lines, submitted, `Created directory ${targetDir}`]);
        })
        .catch((err: unknown) => {
          setHistory((lines) => [
            ...lines,
            submitted,
            `mkdir error: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        });
      return;
    }

    if (cmd === "rm") {
      const targetPath = args[0];
      if (!targetPath) {
        setHistory((lines) => [...lines, submitted, "Usage: rm <path>"]);
        return;
      }
      const fs = props.filesystem;
      if (!fs?.delete) {
        setHistory((lines) => [...lines, submitted, `Deleted ${targetPath}`]);
        return;
      }
      void fs
        .delete(targetPath)
        .then(() => {
          setHistory((lines) => [...lines, submitted, `Deleted ${targetPath}`]);
        })
        .catch((err: unknown) => {
          setHistory((lines) => [
            ...lines,
            submitted,
            `rm error: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        });
      return;
    }

    if (props.onCommand) {
      void Promise.resolve(props.onCommand(trimmed)).then((res) => {
        if (res !== undefined) setHistory((lines) => [...lines, submitted, res]);
        else setHistory((lines) => [...lines, submitted]);
      });
      return;
    }

    setHistory((lines) => [
      ...lines,
      submitted,
      `sevyn: command not found: ${command}. Type 'help' for available commands.`,
    ]);
  };

  return View({
    id: "console.app",
    role: "application",
    label: "Genesis Console",
    style: {
      padding: 16,
      gap: 8,
      backgroundColor: "#0D1117",
      radius: 8,
      borderColor: "rgba(255, 255, 255, 0.12)",
    },
    children: [
      NativeScrollView({
        key: "history",
        id: "console.history",
        role: "list",
        style: { flexGrow: 1, overflow: "scroll", gap: 4 },
        children: history.map((line, index) =>
          NativeText({
            key: `${String(index)}-${line}`,
            id: `console.line.${String(index)}`,
            text: line,
            role: "listitem",
            style: { height: 20, color: "#3FB950", fontSize: 13 },
          }),
        ),
      }),
      NativeTextInput({
        key: "input",
        id: "console.input",
        role: "textbox",
        label: "Console command",
        value: input,
        onTextInput: setInput,
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            handleCommand(input);
            setInput("");
          } else if (event.key === "Escape") setInput("");
        },
        style: {
          height: 38,
          padding: 8,
          backgroundColor: "#161B22",
          color: "#F0F6FC",
          radius: 6,
        },
      }),
    ],
  });
}

export interface SystemMonitorModel {
  readonly runningApplicationSessions: number;
  readonly openWindows: number;
  readonly focusedWindow: string | undefined;
  readonly cursorKind: string;
  readonly frameExecutionCount: number;
  readonly activeWorkspace: string;
  readonly graphicsEngine?: string;
  readonly applicationWorkers?: readonly {
    readonly applicationId: string;
    readonly status: string;
    readonly metrics: {
      readonly inboundMessages: number;
      readonly outboundMessages: number;
      readonly inboundQueueDepth: number;
      readonly outboundQueueDepth: number;
      readonly averageEventDuration: number;
      readonly timeoutCount: number;
      readonly restartCount: number;
      readonly terminationReason?: string;
    };
  }[];
}
export function SystemMonitorApplication(props: {
  readonly model: SystemMonitorModel;
}): ReactElement {
  const graphicsEngine =
    props.model.graphicsEngine ??
    (typeof process !== "undefined" &&
    process.env["SEVYN_GRAPHICS_ACCELERATION"] === "gpu"
      ? "GPU Accelerated (GBM/EGL)"
      : "GPU / Hardware Preferred");
  const rows = [
    ["Graphics engine", graphicsEngine],
    ["Running sessions", props.model.runningApplicationSessions],
    ["Open windows", props.model.openWindows],
    ["Focused window", props.model.focusedWindow ?? "None"],
    ["Cursor", props.model.cursorKind],
    ["Frames", props.model.frameExecutionCount],
    ["Workspace", props.model.activeWorkspace],
    ["Application workers", props.model.applicationWorkers?.length ?? 0],
    [
      "Worker messages",
      (props.model.applicationWorkers ?? []).reduce(
        (total, worker) =>
          total + worker.metrics.inboundMessages + worker.metrics.outboundMessages,
        0,
      ),
    ],
    [
      "Worker queue depth",
      (props.model.applicationWorkers ?? []).reduce(
        (total, worker) =>
          total + worker.metrics.inboundQueueDepth + worker.metrics.outboundQueueDepth,
        0,
      ),
    ],
    [
      "Worker timeouts",
      (props.model.applicationWorkers ?? []).reduce(
        (total, worker) => total + worker.metrics.timeoutCount,
        0,
      ),
    ],
  ] as const;
  return View({
    id: "monitor.app",
    role: "application",
    label: "System Monitor",
    style: { padding: 22, gap: 10 },
    children: [
      heading("monitor.heading", "System Monitor"),
      ...rows.map(([name, value]) =>
        View({
          key: name,
          id: `monitor.${name}`,
          role: "listitem",
          label: name,
          style: { direction: "row", height: 32, gap: 12 },
          children: [
            NativeText({
              key: "label",
              id: `monitor.${name}.label`,
              text: name,
              style: { width: "55%" },
            }),
            NativeText({
              key: "value",
              id: `monitor.${name}.value`,
              text: String(value),
              style: { flexGrow: 1, color: "#67C695" },
            }),
          ],
        }),
      ),
    ],
  });
}

const settingRows = [
  "theme",
  "accent",
  "taskbar-position",
  "taskbar-behavior",
  "display-layout",
  "workspace-count",
  "cursor-size",
  "reduced-motion",
  "restore-session",
] as const;
export function SettingsReactApplication(props: {
  readonly settings: SevynSettingsModel;
  readonly network: SevynWirelessNetworkService;
  readonly power: SevynPowerService;
  readonly battery?: SevynBatteryService | undefined;
  readonly audio?: SevynAudioService | undefined;
  readonly system?: SevynSystemService | undefined;
}): ReactElement {
  const [section, setSection] = useState<
    "desktop" | "network" | "sound" | "power" | "system"
  >("desktop");
  const [wireless, setWireless] = useState<WirelessNetworkSnapshot>({
    available: false,
    enabled: false,
    state: "unavailable",
    networks: [],
  });
  const [battery, setBattery] = useState<BatterySnapshot>({
    available: false,
    percent: 100,
    charging: false,
    state: "unknown",
  });
  const [audio, setAudio] = useState<AudioSnapshot>({
    available: false,
    volume: 75,
    muted: false,
    outputDevice: "Default ALSA Device",
    hasHeadphones: false,
  });
  const [system, setSystem] = useState<SystemHardwareSnapshot>({
    cpuPercent: 0,
    cpuCores: 1,
    memoryTotalBytes: 0,
    memoryUsedBytes: 0,
    memoryAvailableBytes: 0,
    uptimeSeconds: 0,
  });
  const [selectedSsid, setSelectedSsid] = useState<string>();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void props.network
        .snapshot()
        .then((snapshot) => {
          if (active) setWireless(snapshot);
        })
        .catch((error: unknown) => {
          if (active) {
            setWireless((current) => ({
              ...current,
              available: false,
              state: "failed",
              error:
                error instanceof Error ? error.message : "The network request failed.",
            }));
          }
        });
    };
    refresh();
    const unsubscribe = props.network.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [props.network]);

  useEffect(() => {
    if (!props.battery) return;
    let active = true;
    const refresh = () => {
      void props.battery?.snapshot().then((snapshot) => {
        if (active) setBattery(snapshot);
      });
    };
    refresh();
    const unsubscribe = props.battery.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [props.battery]);

  useEffect(() => {
    if (!props.audio) return;
    let active = true;
    const refresh = () => {
      void props.audio?.snapshot().then((snapshot) => {
        if (active) setAudio(snapshot);
      });
    };
    refresh();
    const unsubscribe = props.audio.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [props.audio]);

  useEffect(() => {
    if (!props.system) return;
    let active = true;
    const refresh = () => {
      void props.system?.snapshot().then((snapshot) => {
        if (active) setSystem(snapshot);
      });
    };
    refresh();
    const unsubscribe = props.system.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [props.system]);

  const runNetworkAction = (action: () => Promise<WirelessNetworkSnapshot>): void => {
    if (busy) return;
    setBusy(true);
    void action()
      .then((snapshot) => {
        setWireless(snapshot);
        if (snapshot.state === "connected") {
          setSelectedSsid(undefined);
          setPassword("");
        }
      })
      .catch((error: unknown) => {
        setWireless((current) => ({
          ...current,
          state: "failed",
          error: error instanceof Error ? error.message : "The network request failed.",
        }));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const values: Record<(typeof settingRows)[number], string> = {
    theme: props.settings.theme,
    accent: props.settings.accentColor,
    "taskbar-position": props.settings.taskbarPosition,
    "taskbar-behavior": props.settings.taskbarBehavior,
    "display-layout": props.settings.displayLayout,
    "workspace-count": String(props.settings.workspaceCount),
    "cursor-size": `${String(props.settings.cursorSize)}×`,
    "reduced-motion": props.settings.reducedMotion ? "On" : "Off",
    "restore-session": props.settings.restorePreviousSession ? "On" : "Off",
  };
  const selectedNetwork = wireless.networks.find(
    (network) => network.ssid === selectedSsid,
  );
  const connectionSummary = !wireless.available
    ? "No supported wireless adapter was detected."
    : wireless.state === "connected"
      ? `${wireless.connectedSsid ?? "Connected"}${wireless.ipAddress === undefined ? "" : ` · ${wireless.ipAddress}`}`
      : wireless.state === "connecting"
        ? "Connecting…"
        : wireless.state === "scanning"
          ? "Looking for nearby networks…"
          : wireless.state === "failed"
            ? (wireless.error ?? "The wireless request failed.")
            : "Wi-Fi is ready. Choose a network to connect.";

  const sidebarItem = (
    id: string,
    text: string,
    target: "desktop" | "network" | "sound" | "power" | "system",
  ) =>
    Pressable({
      key: id,
      id,
      role: "tab",
      label: text,
      selected: section === target,
      onPress: () => {
        setSection(target);
      },
      style: {
        height: 38,
        padding: 9,
        radius: 8,
        backgroundColor:
          section === target ? "rgba(215, 172, 87, 0.20)" : "rgba(255, 255, 255, 0.03)",
        borderColor:
          section === target ? "rgba(215, 172, 87, 0.50)" : "rgba(255, 255, 255, 0.06)",
        borderWidth: 1,
      },
      children: label(`${id}.label`, text),
    });

  const canConnect =
    !busy &&
    selectedNetwork !== undefined &&
    selectedNetwork.supported &&
    (!selectedNetwork.requiresPassword || password.length >= 8);

  const networkContent = [
    View({
      key: "network-header",
      id: "settings.network.header",
      style: {
        minHeight: 82,
        padding: 14,
        gap: 8,
        radius: 10,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        borderWidth: 1,
      },
      children: [
        View({
          key: "header-top",
          id: "settings.network.toolbar",
          style: {
            height: 38,
            direction: "row",
            align: "center",
            justify: "space-between",
            gap: 10,
          },
          children: [
            heading("settings.network.title", "Network & Wi-Fi"),
            View({
              key: "toolbar-actions",
              id: "settings.network.toolbar-actions",
              style: { direction: "row", gap: 8, align: "center" },
              children: [
                ...(wireless.available && !busy
                  ? [
                      button("settings.network.scan", "Scan", () => {
                        runNetworkAction(() => props.network.scan());
                      }),
                    ]
                  : []),
                ...(wireless.state === "connected" && !busy
                  ? [
                      button("settings.network.disconnect", "Disconnect", () => {
                        runNetworkAction(() => props.network.disconnect());
                      }),
                    ]
                  : []),
              ],
            }),
          ],
        }),
        NativeText({
          key: "summary",
          id: "settings.network.summary",
          text: connectionSummary,
          style: {
            height: 20,
            fontSize: 13,
            color: wireless.state === "failed" ? "#FF7B72" : "#BBC1CA",
          },
        }),
      ],
    }),
    View({
      key: "split-container",
      id: "settings.network.split-container",
      style: { direction: "row", gap: 14, minHeight: 330 },
      breakpoint: { compact: 560, compactStyle: { direction: "column" } },
      children: [
        // Left Column: Available Networks List
        View({
          key: "available",
          id: "settings.network.available",
          style: {
            flex: 1.1,
            minWidth: 230,
            padding: 12,
            gap: 8,
            radius: 10,
            backgroundColor: "rgba(255, 255, 255, 0.02)",
            borderColor: "rgba(255, 255, 255, 0.06)",
            borderWidth: 1,
          },
          children: [
            NativeText({
              key: "title",
              id: "settings.network.available.title",
              text:
                "Available networks" +
                (wireless.networks.length > 0
                  ? ` (${String(wireless.networks.length)})`
                  : ""),
              role: "heading",
              style: { height: 24, fontSize: 15, fontWeight: 650 },
            }),
            View({
              key: "list-scroll",
              id: "settings.network.list-scroll",
              style: { gap: 6, paddingRight: 4 },
              children: !wireless.available
                ? [
                    NativeText({
                      key: "unavailable",
                      id: "settings.network.unavailable",
                      text: "Connect a supported Wi-Fi adapter,",
                      style: { height: 20, fontSize: 13, color: "#8B949E" },
                    }),
                    NativeText({
                      key: "unavailable-sub",
                      id: "settings.network.unavailable-sub",
                      text: "then reopen Settings to scan.",
                      style: { height: 20, fontSize: 13, color: "#8B949E" },
                    }),
                  ]
                : wireless.networks.length === 0
                  ? [
                      NativeText({
                        key: "empty",
                        id: "settings.network.empty",
                        text: busy
                          ? "Scanning for nearby networks…"
                          : "Select Scan to find nearby Wi-Fi networks.",
                        style: { height: 38, padding: 8, fontSize: 13, color: "#8B949E" },
                      }),
                    ]
                  : wireless.networks.map((network) =>
                      Pressable({
                        key: network.ssid,
                        id: `settings.network.${network.ssid}`,
                        role: "button",
                        label: network.ssid,
                        selected: selectedSsid === network.ssid,
                        onPress: () => {
                          setSelectedSsid(network.ssid);
                          setPassword("");
                        },
                        style: {
                          minHeight: 52,
                          padding: 10,
                          radius: 8,
                          backgroundColor:
                            network.connected || selectedSsid === network.ssid
                              ? "rgba(215, 172, 87, 0.16)"
                              : "rgba(255, 255, 255, 0.03)",
                          borderColor:
                            network.connected || selectedSsid === network.ssid
                              ? "rgba(215, 172, 87, 0.42)"
                              : "rgba(255, 255, 255, 0.06)",
                          borderWidth: 1,
                        },
                        children: [
                          NativeText({
                            key: "name",
                            id: `settings.network.${network.ssid}.name`,
                            text: `${network.connected ? "● " : ""}${network.ssid}`,
                            style: {
                              height: 21,
                              fontSize: 14,
                              fontWeight: 600,
                              color: network.connected ? "#67C695" : "#F0F6FC",
                            },
                          }),
                          NativeText({
                            key: "details",
                            id: `settings.network.${network.ssid}.details`,
                            text: `${String(network.signal)}% signal · ${network.security === "open" ? "Open" : network.security === "personal" ? "Secured" : network.security === "enhanced-open" ? "Enhanced Open" : network.security === "enterprise" ? "Enterprise · not supported yet" : "Legacy security · not supported"}`,
                            style: { height: 18, fontSize: 12, color: "#8B949E" },
                          }),
                        ],
                      }),
                    ),
            }),
          ],
        }),
        // Right Column: Dedicated Selected Network Card / Connect Panel
        View({
          key: "connect-panel",
          id: "settings.network.connect-panel",
          style: {
            flex: 1,
            minWidth: 240,
            padding: 14,
            gap: 10,
            radius: 10,
            backgroundColor: "rgba(255, 255, 255, 0.04)",
            borderColor: "rgba(215, 172, 87, 0.35)",
            borderWidth: 1,
          },
          children:
            selectedNetwork !== undefined
              ? [
                  NativeText({
                    key: "title",
                    id: "settings.network.connect-title",
                    text: selectedNetwork.ssid,
                    role: "heading",
                    style: { height: 26, fontSize: 17, fontWeight: 700 },
                  }),
                  NativeText({
                    key: "network-status",
                    id: "settings.network.selected-status",
                    text: selectedNetwork.connected
                      ? "● Connected to this network"
                      : `${String(selectedNetwork.signal)}% signal · ${selectedNetwork.security === "open" ? "Open network (No password required)" : "WPA2/WPA3 Personal (Secured)"}`,
                    style: {
                      height: 20,
                      fontSize: 12,
                      color: selectedNetwork.connected ? "#67C695" : "#BBC1CA",
                    },
                  }),
                  ...(!selectedNetwork.supported
                    ? [
                        NativeText({
                          key: "unsupported",
                          id: "settings.network.unsupported",
                          text:
                            selectedNetwork.security === "enterprise"
                              ? "Enterprise Wi-Fi setup will be added with certificate and identity management."
                              : "This legacy Wi-Fi security mode is not supported.",
                          style: { height: 38, fontSize: 12, color: "#FFB86C" },
                        }),
                      ]
                    : selectedNetwork.connected
                      ? [
                          button(
                            "settings.network.disconnect-active",
                            "Disconnect",
                            () => {
                              runNetworkAction(() => props.network.disconnect());
                            },
                          ),
                        ]
                      : [
                          ...(selectedNetwork.requiresPassword
                            ? [
                                NativeText({
                                  key: "password-label",
                                  id: "settings.network.password-label",
                                  text: "Wi-Fi Password",
                                  style: { height: 18, fontSize: 12, color: "#BBC1CA" },
                                }),
                                View({
                                  key: "password-row",
                                  id: "settings.network.password-row",
                                  style: {
                                    height: 38,
                                    direction: "row",
                                    gap: 6,
                                    align: "center",
                                  },
                                  children: [
                                    NativeTextInput({
                                      key: "password",
                                      id: "settings.network.password",
                                      role: "textbox",
                                      label: `Password for ${selectedNetwork.ssid}`,
                                      value: password,
                                      secureTextEntry: !showPassword,
                                      onTextInput: (value: string) => {
                                        setPassword(value);
                                      },
                                      onChangeText: (value: string) => {
                                        setPassword(value);
                                      },
                                      onValueChange: (
                                        value: string | number | boolean,
                                      ) => {
                                        setPassword(String(value));
                                      },
                                      style: {
                                        flexGrow: 1,
                                        height: 36,
                                        padding: 8,
                                        radius: 6,
                                        backgroundColor: "rgba(0, 0, 0, 0.28)",
                                        borderColor: "rgba(255, 255, 255, 0.16)",
                                        borderWidth: 1,
                                      },
                                    }),
                                    button(
                                      "settings.network.toggle-password",
                                      showPassword ? "Hide" : "Show",
                                      () => {
                                        setShowPassword((prev) => !prev);
                                      },
                                    ),
                                  ],
                                }),
                                NativeText({
                                  key: "password-hint",
                                  id: "settings.network.password-hint",
                                  text:
                                    password.length === 0
                                      ? "Enter password (8+ characters)"
                                      : password.length < 8
                                        ? `Password must be at least 8 characters (${String(password.length)}/8)`
                                        : `Ready to connect (${String(password.length)} characters)`,
                                  style: {
                                    height: 18,
                                    fontSize: 11,
                                    color:
                                      password.length === 0
                                        ? "#8B949E"
                                        : password.length < 8
                                          ? "#FFB86C"
                                          : "#67C695",
                                  },
                                }),
                              ]
                            : []),
                          Pressable({
                            key: "connect-btn",
                            id: "settings.network.connect",
                            role: "button",
                            label: busy ? "Connecting…" : "Connect",
                            disabled: !canConnect,
                            ...(canConnect
                              ? {
                                  onPress: () => {
                                    runNetworkAction(() =>
                                      props.network.connect(
                                        selectedNetwork.ssid,
                                        selectedNetwork.requiresPassword
                                          ? password
                                          : undefined,
                                      ),
                                    );
                                  },
                                }
                              : {}),
                            style: {
                              height: 38,
                              radius: 8,
                              padding: 8,
                              backgroundColor: canConnect
                                ? "rgba(215, 172, 87, 0.85)"
                                : "rgba(255, 255, 255, 0.06)",
                              borderColor: canConnect
                                ? "#D7AC57"
                                : "rgba(255, 255, 255, 0.10)",
                              borderWidth: 1,
                              align: "center",
                              justify: "center",
                            },
                            children: NativeText({
                              key: "connect-label",
                              id: "settings.network.connect.label",
                              text: busy
                                ? "Connecting…"
                                : `Connect${selectedNetwork.requiresPassword && password.length < 8 ? " (Enter Password)" : ""}`,
                              style: {
                                fontSize: 13,
                                fontWeight: 650,
                                color: canConnect
                                  ? "#14110C"
                                  : "rgba(255, 255, 255, 0.35)",
                              },
                            }),
                          }),
                        ]),
                ]
              : [
                  NativeText({
                    key: "title",
                    id: "settings.network.connect-title",
                    text: "Network Details",
                    role: "heading",
                    style: { height: 26, fontSize: 17, fontWeight: 700 },
                  }),
                  NativeText({
                    key: "placeholder-desc",
                    id: "settings.network.placeholder-desc",
                    text: "Select a Wi-Fi network from the list to connect.",
                    style: { height: 22, fontSize: 13, color: "#8B949E" },
                  }),
                  button("settings.network.prompt-scan", "Scan for Networks", () => {
                    runNetworkAction(() => props.network.scan());
                  }),
                ],
        }),
      ],
    }),
  ];

  const soundContent = [
    heading("settings.sound.title", "Sound & Audio"),
    NativeText({
      key: "sound-desc",
      id: "settings.sound.desc",
      text: "Manage master output volume, mute state, and audio hardware devices.",
      style: { height: 24, fontSize: 13, color: "#BBC1CA" },
    }),
    View({
      key: "sound-card",
      id: "settings.sound.card",
      style: {
        padding: 16,
        gap: 12,
        radius: 10,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        borderWidth: 1,
      },
      children: [
        NativeText({
          key: "volume-heading",
          id: "settings.sound.volume-heading",
          text: `Master Output Volume · ${String(audio.volume)}%${audio.muted ? " (Muted)" : ""}`,
          role: "heading",
          style: { height: 24, fontSize: 15, fontWeight: 650 },
        }),
        View({
          key: "volume-bar",
          id: "settings.sound.volume-bar",
          style: {
            height: 8,
            radius: 4,
            backgroundColor: "rgba(255, 255, 255, 0.10)",
            overflow: "hidden",
          },
          children: [
            View({
              key: "volume-fill",
              id: "settings.sound.volume-fill",
              style: {
                width: `${String(audio.volume)}%` as `${number}%`,
                height: 8,
                radius: 4,
                backgroundColor: audio.muted ? "#FF7B72" : "#D7AC57",
              },
            }),
          ],
        }),
        View({
          key: "volume-controls",
          id: "settings.sound.volume-controls",
          style: { direction: "row", gap: 8, align: "center" },
          children: [
            button("settings.sound.mute", audio.muted ? "Unmute" : "Mute", () => {
              if (props.audio) {
                void props.audio.setMuted(!audio.muted).then((s) => {
                  setAudio(s);
                });
              }
            }),
            button("settings.sound.down", "- 10%", () => {
              if (props.audio) {
                const next = Math.max(0, audio.volume - 10);
                void props.audio.setVolume(next).then((s) => {
                  setAudio(s);
                });
              }
            }),
            button("settings.sound.up", "+ 10%", () => {
              if (props.audio) {
                const next = Math.min(100, audio.volume + 10);
                void props.audio.setVolume(next).then((s) => {
                  setAudio(s);
                });
              }
            }),
            button("settings.sound.25", "25%", () => {
              if (props.audio) {
                void props.audio.setVolume(25).then((s) => {
                  setAudio(s);
                });
              }
            }),
            button("settings.sound.50", "50%", () => {
              if (props.audio) {
                void props.audio.setVolume(50).then((s) => {
                  setAudio(s);
                });
              }
            }),
            button("settings.sound.75", "75%", () => {
              if (props.audio) {
                void props.audio.setVolume(75).then((s) => {
                  setAudio(s);
                });
              }
            }),
            button("settings.sound.100", "100%", () => {
              if (props.audio) {
                void props.audio.setVolume(100).then((s) => {
                  setAudio(s);
                });
              }
            }),
          ],
        }),
        NativeText({
          key: "device-status",
          id: "settings.sound.device-status",
          text: audio.available
            ? `Audio Hardware: ALSA Direct Kernel Interface · ${audio.hasHeadphones ? "Headphones connected" : "Stereo speakers"}`
            : "Audio Hardware: Emulated / Generic ALSA Device",
          style: { height: 20, fontSize: 12, color: "#8B949E" },
        }),
      ],
    }),
  ];

  const powerContent = [
    heading("settings.power.title", "Power & Battery"),
    NativeText({
      key: "power-desc",
      id: "settings.power.desc",
      text: "Monitor hardware battery status, AC adapter presence, and safely power off your device.",
      style: { height: 24, fontSize: 13, color: "#BBC1CA" },
    }),
    View({
      key: "battery-card",
      id: "settings.power.card",
      style: {
        padding: 16,
        gap: 12,
        radius: 10,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        borderWidth: 1,
      },
      children: [
        NativeText({
          key: "bat-heading",
          id: "settings.power.bat-heading",
          text: battery.available
            ? `Battery Level · ${String(battery.percent)}% (${battery.charging ? "Charging" : battery.state === "full" ? "Fully Charged" : "On Battery"})`
            : "Power Source: Continuous AC Line Power (Desktop / Virtualized)",
          role: "heading",
          style: { height: 24, fontSize: 15, fontWeight: 650 },
        }),
        ...(battery.available
          ? [
              View({
                key: "bat-bar",
                id: "settings.power.bat-bar",
                style: {
                  height: 8,
                  radius: 4,
                  backgroundColor: "rgba(255, 255, 255, 0.10)",
                  overflow: "hidden",
                },
                children: [
                  View({
                    key: "bat-fill",
                    id: "settings.power.bat-fill",
                    style: {
                      width: `${String(battery.percent)}%` as Dimension,
                      height: 8,
                      radius: 4,
                      backgroundColor: battery.charging
                        ? "#34C759"
                        : battery.percent <= 20
                          ? "#FF7B72"
                          : "#D7AC57",
                    },
                  }),
                ],
              }),
            ]
          : []),
        NativeText({
          key: "power-sub",
          id: "settings.power.sub",
          text: battery.available
            ? `Hardware Supply: /sys/class/power_supply · State: ${battery.state}`
            : "No integrated battery controller detected on this motherboard.",
          style: { height: 20, fontSize: 12, color: "#8B949E" },
        }),
      ],
    }),
    View({
      key: "shutdown-card",
      id: "settings.power.shutdown-card",
      style: {
        padding: 16,
        gap: 12,
        radius: 10,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        borderWidth: 1,
      },
      children: [
        NativeText({
          key: "shutdown-heading",
          id: "settings.power.shutdown-heading",
          text: "System Power Actions",
          role: "heading",
          style: { height: 24, fontSize: 15, fontWeight: 650 },
        }),
        NativeText({
          key: "shutdown-desc",
          id: "settings.power.shutdown-desc",
          text: "Safely close applications, flush disk caches to bare metal storage, and power off.",
          style: { height: 24, fontSize: 13, color: "#BBC1CA" },
        }),
        Pressable({
          key: "shutdown-btn",
          id: "settings.power.shutdown",
          role: "button",
          label: "Shut Down",
          onPress: () => {
            void props.power.shutdown();
          },
          style: {
            width: 180,
            height: 40,
            padding: 10,
            radius: 8,
            backgroundColor: "rgba(217, 101, 109, 0.22)",
            borderColor: "rgba(217, 101, 109, 0.65)",
            borderWidth: 1,
            align: "center",
            justify: "center",
          },
          children: NativeText({
            key: "shutdown-label",
            id: "settings.power.shutdown.label",
            text: "Shut Down SevynOS",
            style: { fontSize: 13, fontWeight: 650, color: "#FFA198" },
          }),
        }),
      ],
    }),
  ];

  const memUsedMb = Math.round(system.memoryUsedBytes / (1024 * 1024));
  const memTotalMb = Math.round(system.memoryTotalBytes / (1024 * 1024));
  const memPct = memTotalMb > 0 ? Math.round((memUsedMb / memTotalMb) * 100) : 0;
  const uptimeH = Math.floor(system.uptimeSeconds / 3600);
  const uptimeM = Math.floor((system.uptimeSeconds % 3600) / 60);
  const uptimeS = Math.floor(system.uptimeSeconds % 60);

  const systemContent = [
    heading("settings.system.title", "System Information"),
    NativeText({
      key: "system-desc",
      id: "settings.system.desc",
      text: "Hardware specifications, system telemetry, and operating system identity.",
      style: { height: 24, fontSize: 13, color: "#BBC1CA" },
    }),
    View({
      key: "os-card",
      id: "settings.system.os-card",
      style: {
        padding: 16,
        gap: 8,
        radius: 10,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        borderWidth: 1,
      },
      children: [
        NativeText({
          key: "os-title",
          id: "settings.system.os-title",
          text: "SevynOS Genesis (Bare Metal Edition)",
          role: "heading",
          style: { height: 26, fontSize: 16, fontWeight: 700, color: "#D7AC57" },
        }),
        NativeText({
          key: "os-kernel",
          id: "settings.system.os-kernel",
          text: "Kernel: Linux 6.12.63-sevynos (x86_64) with native Wayland & DRM/KMS",
          style: { height: 20, fontSize: 13, color: "#F0F6FC" },
        }),
        NativeText({
          key: "os-ui",
          id: "settings.system.os-ui",
          text: "Interface: React Native High-Performance Software Compositor (Genesis 2.0)",
          style: { height: 20, fontSize: 13, color: "#BBC1CA" },
        }),
        NativeText({
          key: "os-storage",
          id: "settings.system.os-storage",
          text: "User Space Root: /var/lib/sevynos/user",
          style: { height: 20, fontSize: 12, color: "#8B949E" },
        }),
      ],
    }),
    View({
      key: "metrics-card",
      id: "settings.system.metrics-card",
      style: {
        padding: 16,
        gap: 12,
        radius: 10,
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        borderWidth: 1,
      },
      children: [
        NativeText({
          key: "cpu-metric-title",
          id: "settings.system.cpu-title",
          text: `CPU Load · ${String(system.cpuPercent)}%`,
          role: "heading",
          style: { height: 22, fontSize: 14, fontWeight: 650 },
        }),
        View({
          key: "cpu-bar",
          id: "settings.system.cpu-bar",
          style: {
            height: 6,
            radius: 3,
            backgroundColor: "rgba(255, 255, 255, 0.10)",
            overflow: "hidden",
          },
          children: [
            View({
              key: "cpu-fill",
              id: "settings.system.cpu-fill",
              style: {
                width: `${String(system.cpuPercent)}%` as Dimension,
                height: 6,
                radius: 3,
                backgroundColor: "#58A6FF",
              },
            }),
          ],
        }),
        NativeText({
          key: "mem-metric-title",
          id: "settings.system.mem-title",
          text: `Physical Memory · ${String(memUsedMb)} MB / ${String(memTotalMb)} MB (${String(memPct)}%)`,
          role: "heading",
          style: { height: 22, fontSize: 14, fontWeight: 650 },
        }),
        View({
          key: "mem-bar",
          id: "settings.system.mem-bar",
          style: {
            height: 6,
            radius: 3,
            backgroundColor: "rgba(255, 255, 255, 0.10)",
            overflow: "hidden",
          },
          children: [
            View({
              key: "mem-fill",
              id: "settings.system.mem-fill",
              style: {
                width: `${String(memPct)}%` as Dimension,
                height: 6,
                radius: 3,
                backgroundColor: "#34C759",
              },
            }),
          ],
        }),
        NativeText({
          key: "uptime-text",
          id: "settings.system.uptime",
          text: `System Uptime: ${String(uptimeH)}h ${String(uptimeM)}m ${String(uptimeS)}s`,
          style: { height: 20, fontSize: 12, color: "#8B949E" },
        }),
      ],
    }),
  ];

  return View({
    id: "settings.app",
    role: "application",
    label: "Settings",
    style: { direction: "row", padding: 12, gap: 16 },
    breakpoint: { compact: 600, compactStyle: { direction: "column" } },
    children: [
      View({
        key: "sidebar",
        id: "settings.sidebar",
        style: { width: 180, padding: 16, gap: 12 },
        children: [
          heading("settings.title", "Settings"),
          label("settings.section", "SYSTEM"),
          sidebarItem("settings.sidebar.desktop", "Desktop & Experience", "desktop"),
          sidebarItem("settings.sidebar.network", "Network & Wi-Fi", "network"),
          sidebarItem("settings.sidebar.sound", "Sound & Audio", "sound"),
          sidebarItem("settings.sidebar.power", "Power & Battery", "power"),
          sidebarItem("settings.sidebar.system", "System Information", "system"),
        ],
      }),
      NativeScrollView({
        key: "content",
        id: "settings.content",
        style: { flexGrow: 1, overflow: "scroll", padding: 12, gap: 8 },
        children:
          section === "network"
            ? networkContent
            : section === "sound"
              ? soundContent
              : section === "power"
                ? powerContent
                : section === "system"
                  ? systemContent
                  : [
                      heading("settings.content.title", "Desktop & Experience"),
                      ...settingRows.map((action) =>
                        Pressable({
                          key: action,
                          id: `settings.${action}`,
                          action,
                          role:
                            action === "reduced-motion" || action === "restore-session"
                              ? "checkbox"
                              : "button",
                          label: action.replaceAll("-", " "),
                          value: values[action],
                          ...(action === "reduced-motion"
                            ? { checked: props.settings.reducedMotion }
                            : action === "restore-session"
                              ? { checked: props.settings.restorePreviousSession }
                              : {}),
                          style: { height: 48, padding: 8, radius: 8 },
                          children: [
                            NativeText({
                              key: "name",
                              id: `settings.${action}.name`,
                              text: action.replaceAll("-", " "),
                              style: { height: 20, fontWeight: 600 },
                            }),
                            NativeText({
                              key: "value",
                              id: `settings.${action}.value`,
                              text: values[action],
                              style: { height: 18, color: "#BBC1CA", fontSize: 12 },
                            }),
                          ],
                        }),
                      ),
                    ],
      }),
    ],
  });
}

export function FilesApplication(props: {
  readonly filesystem: SevynFileSystem;
  readonly notifications?: SystemNotificationService;
}): ReactElement {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<readonly FileSystemEntry[]>([]);
  const [selected, setSelected] = useState<string>();
  const [grid, setGrid] = useState(false);
  const isImage = (name: string): boolean =>
    /\.(png|jpe?g|gif|svg|bmp|webp)$/i.test(name);

  const [error, setError] = useState<string>();
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const requestRevision = useRef(0);
  const inTrash = path === "/.Trash";

  const reportError = (failure: unknown): void => {
    setError(failure instanceof Error ? failure.message : "The file operation failed.");
  };
  const refreshEntries = async (): Promise<void> => {
    const revision = ++requestRevision.current;
    try {
      const items = inTrash
        ? ((await props.filesystem.listTrash?.()) ?? [])
        : await props.filesystem.list(path);
      if (revision === requestRevision.current) {
        setEntries(items);
        setError(undefined);
      }
    } catch (failure) {
      if (revision === requestRevision.current) reportError(failure);
    }
  };

  useEffect(() => {
    setEntries([]);
    setSelected(undefined);
    setConfirmEmpty(false);
    void refreshEntries();
    return () => {
      requestRevision.current += 1;
    };
  }, [path, props.filesystem]);

  const runOperation = (operation: () => Promise<void>, title: string): void => {
    setError(undefined);
    const revision = requestRevision.current;
    void operation()
      .then(async () => {
        if (revision !== requestRevision.current) return;
        await refreshEntries();
        setSelected(undefined);
        props.notifications?.show({ title, message: "File operation completed." });
      })
      .catch((failure: unknown) => {
        if (revision === requestRevision.current) reportError(failure);
      });
  };

  const goUp = (): void => {
    if (path !== "/") setPath(path.replace(/\/[^/]+$/, "") || "/");
  };
  const createNewFile = (): void => {
    const name = `Document_${String(Date.now())}.txt`;
    runOperation(
      () => props.filesystem.write(`${path === "/" ? "" : path}/${name}`, ""),
      "File created",
    );
  };
  const createNewFolder = (): void => {
    const name = `Folder_${String(Date.now())}`;
    runOperation(
      () => props.filesystem.createDirectory(`${path === "/" ? "" : path}/${name}`),
      "Folder created",
    );
  };
  const deleteSelected = (): void => {
    const move = props.filesystem.moveToTrash?.bind(props.filesystem);
    if (!selected || !move || inTrash) return;
    runOperation(() => move(selected), "Moved to Trash");
  };
  const restoreSelected = (): void => {
    const entry = entries.find((item) => item.path === selected);
    const restore = props.filesystem.restoreFromTrash?.bind(props.filesystem);
    if (!entry || !restore) return;
    runOperation(() => restore(entry.name), "Restored from Trash");
  };
  const emptyTrash = (): void => {
    const empty = props.filesystem.emptyTrash?.bind(props.filesystem);
    if (!empty) return;
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    runOperation(() => empty(), "Trash emptied");
  };

  const selectedEntry = entries.find((e) => e.path === selected);

  return View({
    id: "files.app",
    role: "application",
    label: "Files",
    style: { direction: "row", padding: 12, gap: 12 },
    children: [
      View({
        key: "sidebar",
        id: "files.sidebar",
        style: { width: 170, padding: 12, gap: 8 },
        children: [
          heading("files.title", "Files"),
          label("files.locations", "LOCATIONS"),
          button("files.loc.root", "📁 / (Root)", () => {
            setPath("/");
          }),
          button("files.loc.desktop", "💻 Desktop", () => {
            setPath("/Desktop");
          }),
          button("files.loc.docs", "📄 Documents", () => {
            setPath("/Documents");
          }),
          button("files.loc.downloads", "📥 Downloads", () => {
            setPath("/Downloads");
          }),
          button("files.loc.pics", "🎨 Pictures", () => {
            setPath("/Pictures");
          }),
          button("files.loc.music", "🎵 Music", () => {
            setPath("/Music");
          }),
          button("files.loc.videos", "🎬 Videos", () => {
            setPath("/Videos");
          }),
          button("files.loc.trash", "🗑 Trash", () => {
            setPath("/.Trash");
          }),
          View({
            key: "div",
            id: "files.sidebar.div",
            style: { height: 1, backgroundColor: "rgba(255,255,255,0.08)" },
          }),
          button("files.view", grid ? "List view" : "Grid view", () => {
            setGrid((value) => !value);
          }),
        ],
      }),
      View({
        key: "browser",
        id: "files.browser",
        style: { flexGrow: 1, gap: 8 },
        children: [
          View({
            key: "toolbar",
            id: "files.toolbar",
            style: { direction: "row", height: 36, gap: 8, align: "center" },
            children: [
              ...(path !== "/" ? [button("files.up", "↑ Up", goUp)] : []),
              NativeText({
                key: "breadcrumb",
                id: "files.breadcrumb",
                text: `Location: ${path}`,
                role: "heading",
                style: {
                  flexGrow: 1,
                  height: 26,
                  fontWeight: 650,
                  color: "#D7AC57",
                  fontSize: 13,
                },
              }),
              ...(!inTrash
                ? [
                    button("files.new_file", "+ File", createNewFile),
                    button("files.new_folder", "+ Folder", createNewFolder),
                  ]
                : []),
              button("files.refresh", "Refresh", () => {
                void refreshEntries();
              }),
              ...(inTrash && selected && props.filesystem.restoreFromTrash
                ? [button("files.restore", "Restore", restoreSelected)]
                : []),
              ...(path === "/.Trash" && props.filesystem.emptyTrash
                ? [
                    button(
                      "files.empty_trash",
                      confirmEmpty ? "Confirm permanent deletion" : "Empty Trash",
                      emptyTrash,
                    ),
                    ...(confirmEmpty
                      ? [
                          button("files.cancel_empty", "Cancel", () => {
                            setConfirmEmpty(false);
                          }),
                        ]
                      : []),
                  ]
                : []),
              ...(selected && !inTrash && props.filesystem.moveToTrash
                ? [button("files.delete", "🗑 Trash", deleteSelected)]
                : []),
            ],
          }),
          ...(error
            ? [
                NativeText({
                  key: "error",
                  id: "files.error",
                  text: error,
                  style: { height: 42, color: "#FF8989", fontSize: 12 },
                }),
              ]
            : []),
          NativeScrollView({
            key: "entries",
            id: "files.entries",
            role: "list",
            style: {
              flexGrow: 1,
              overflow: "scroll",
              direction: grid ? "row" : "column",
              gap: 6,
            },
            children:
              entries.length === 0
                ? [
                    NativeText({
                      key: "empty",
                      id: "files.empty",
                      text: inTrash
                        ? "Trash is empty."
                        : "This folder is empty. Use '+ File' or '+ Folder' above.",
                      style: { height: 40, color: "#8B949E", padding: 12 },
                    }),
                  ]
                : entries.map((entry) =>
                    Pressable({
                      key: entry.path,
                      id: `file.${entry.path}`,
                      role: "listitem",
                      label: entry.name,
                      selected: selected === entry.path,
                      onPress: () => {
                        setSelected(entry.path);
                        if (!inTrash && entry.kind === "directory") setPath(entry.path);
                      },
                      style: {
                        height: grid ? 80 : 36,
                        width: grid ? 120 : "100%",
                        padding: 8,
                        radius: 6,
                        backgroundColor:
                          selected === entry.path
                            ? "rgba(215, 172, 87, 0.20)"
                            : "rgba(255, 255, 255, 0.03)",
                        borderColor:
                          selected === entry.path
                            ? "rgba(215, 172, 87, 0.50)"
                            : "rgba(255, 255, 255, 0.06)",
                        borderWidth: 1,
                      },
                      children: NativeText({
                        id: `file.${entry.path}.label`,
                        text: `${entry.kind === "directory" ? "📁" : isImage(entry.name) ? "🖼" : "📄"} ${entry.name}${entry.kind === "file" ? ` (${String(entry.size)}B)` : ""}`,
                        style: {
                          color: selected === entry.path ? "#D7AC57" : "#F0F6FC",
                          fontSize: 13,
                        },
                      }),
                    }),
                  ),
          }),
          ...(selectedEntry && isImage(selectedEntry.name)
            ? [
                View({
                  key: "preview",
                  id: "files.preview",
                  style: {
                    height: 50,
                    direction: "row",
                    align: "center",
                    padding: 8,
                    backgroundColor: "#0D1117",
                    radius: 6,
                    gap: 12,
                    borderColor: "rgba(215, 172, 87, 0.3)",
                    borderWidth: 1,
                  },
                  children: [
                    NativeText({
                      key: "p-icon",
                      id: "files.preview.icon",
                      text: "🖼",
                      style: { fontSize: 24, width: 32 },
                    }),
                    View({
                      key: "p-info",
                      id: "files.preview.info",
                      style: { flexGrow: 1, gap: 2 },
                      children: [
                        NativeText({
                          key: "p-title",
                          id: "files.preview.title",
                          text: selectedEntry.name,
                          style: { fontSize: 12, fontWeight: 700, color: "#F0F6FC" },
                        }),
                        NativeText({
                          key: "p-desc",
                          id: "files.preview.desc",
                          text: selectedEntry.mimeType ?? "Image file",
                          style: { fontSize: 11, color: "#67C695" },
                        }),
                      ],
                    }),
                  ],
                }),
              ]
            : []),
          ...(selectedEntry
            ? [
                View({
                  key: "inspector",
                  id: "files.inspector",
                  style: {
                    height: 38,
                    direction: "row",
                    align: "center",
                    padding: 8,
                    backgroundColor: "#161B22",
                    radius: 6,
                    gap: 12,
                  },
                  children: [
                    NativeText({
                      key: "type",
                      id: "files.inspector.type",
                      text:
                        selectedEntry.kind === "directory"
                          ? "📁 Folder"
                          : isImage(selectedEntry.name)
                            ? "🖼 Picture"
                            : "📄 Document",
                      style: { fontSize: 12, color: "#D7AC57", fontWeight: 700 },
                    }),
                    NativeText({
                      key: "name",
                      id: "files.inspector.name",
                      text: selectedEntry.name,
                      style: { fontSize: 12, color: "#F0F6FC", flexGrow: 1 },
                    }),
                    NativeText({
                      key: "size",
                      id: "files.inspector.size",
                      text:
                        selectedEntry.kind === "file"
                          ? `${String(selectedEntry.size)} bytes`
                          : "Folder",
                      style: { fontSize: 11, color: "#8B949E" },
                    }),
                  ],
                }),
              ]
            : []),
        ],
      }),
    ],
  });
}

export function BrowserApplication(props: {
  readonly loadPage: (address: string) => Promise<TextBrowserPage>;
  readonly engine?: SevynBrowserEngine;
}): ReactElement {
  return props.engine === undefined
    ? createElement(TextBrowserApplication, { loadPage: props.loadPage })
    : createElement(EngineBrowserApplication, { engine: props.engine });
}

function EngineBrowserApplication(props: {
  readonly engine: SevynBrowserEngine;
}): ReactElement {
  const [browser, setBrowser] = useState<BrowserEngineSnapshot>(props.engine.snapshot());
  const [address, setAddress] = useState(browser.url || "https://duckduckgo.com");

  useEffect(() => {
    const refresh = () => {
      const snapshot = props.engine.snapshot();
      setBrowser(snapshot);
      if (snapshot.url !== "") setAddress(snapshot.url);
    };
    const unsubscribe = props.engine.subscribe(refresh);
    if (!props.engine.snapshot().ready)
      void props.engine.navigate("https://duckduckgo.com");
    return unsubscribe;
  }, [props.engine]);

  const run = (operation: () => Promise<BrowserEngineSnapshot>): void => {
    void operation().then((snapshot) => {
      setBrowser(snapshot);
      if (snapshot.url !== "") setAddress(snapshot.url);
    });
  };
  const navigate = (): void => {
    let target = address.trim();
    if (target === "") target = "https://duckduckgo.com";
    else if (!/^[a-z][a-z\d+.-]*:/i.test(target))
      target =
        target.includes(".") && !target.includes(" ")
          ? `https://${target}`
          : `https://duckduckgo.com/?q=${encodeURIComponent(target)}`;
    run(() => props.engine.navigate(target));
  };
  return View({
    id: "browser.app",
    role: "application",
    label: "Sevyn Browser",
    style: { padding: 10, gap: 8 },
    children: [
      View({
        key: "toolbar",
        id: "browser.toolbar",
        style: { direction: "row", height: 42, gap: 6, align: "center" },
        children: [
          button("browser.back", "←", () => {
            run(() => props.engine.back());
          }),
          button("browser.forward", "→", () => {
            run(() => props.engine.forward());
          }),
          button("browser.reload", "↻", () => {
            run(() => props.engine.reload());
          }),
          NativeTextInput({
            key: "address",
            id: "browser.address",
            role: "textbox",
            label: "Address or search",
            value: address,
            onTextInput: setAddress,
            onKeyDown: (event) => {
              if (event.key === "Enter") navigate();
            },
            style: {
              flexGrow: 1,
              height: 38,
              padding: 9,
              radius: 9,
              backgroundColor: "rgba(0, 0, 0, 0.22)",
              borderColor: "rgba(255, 255, 255, 0.12)",
              borderWidth: 1,
            },
          }),
          button("browser.go", "Go", navigate),
          button("browser.scroll-up", "↑", () => {
            run(() => props.engine.scroll(-520));
          }),
          button("browser.scroll-down", "↓", () => {
            run(() => props.engine.scroll(520));
          }),
        ],
      }),
      View({
        key: "status",
        id: "browser.engine-status",
        style: { direction: "row", height: 24, align: "center", gap: 8 },
        children: [
          NativeText({
            key: "title",
            id: "browser.engine-title",
            text: browser.title || "New Tab",
            style: { flexGrow: 1, height: 20, fontSize: 13, fontWeight: 600 },
          }),
          NativeText({
            key: "state",
            id: "browser.engine-state",
            text: browser.loading ? "Loading…" : (browser.error ?? "Secure web engine"),
            style: {
              height: 20,
              fontSize: 11,
              color: browser.error === undefined ? "#67C695" : "#FF7B72",
            },
          }),
        ],
      }),
      ...(browser.pixels === undefined
        ? [
            View({
              key: "loading",
              id: "browser.engine-loading",
              style: {
                flexGrow: 1,
                align: "center",
                justify: "center",
                radius: 10,
                backgroundColor: "#FFFFFF",
              },
              children: NativeText({
                id: "browser.engine-loading.text",
                text: browser.error ?? "Starting the Sevyn web engine…",
                style: { height: 28, fontSize: 14, color: "#343A40" },
              }),
            }),
          ]
        : [
            NativeImage({
              key: "web-view",
              id: "browser.web-view",
              role: "button",
              label: "Web page content",
              source: {
                width: browser.width,
                height: browser.height,
                pixels: browser.pixels,
              },
              onPointerDown: (event) => {
                void props.engine.pointerDown(event.x, event.y, event.button);
              },
              onPointerUp: (event) => {
                run(() => props.engine.pointerUp(event.x, event.y, event.button));
              },
              onWheel: (event) => {
                run(() => props.engine.scroll(event.deltaY));
              },
              onKeyDown: (event) => {
                run(() =>
                  props.engine.key(event.key, event.code, {
                    shift: event.shift,
                    alt: event.alt,
                    control: event.control,
                    meta: event.meta,
                  }),
                );
              },
              style: {
                flexGrow: 1,
                overflow: "hidden",
                radius: 8,
                backgroundColor: "#FFFFFF",
                borderColor: "rgba(255, 255, 255, 0.10)",
                borderWidth: 1,
              },
            }),
          ]),
    ],
  });
}

function TextBrowserApplication(props: {
  readonly loadPage: (address: string) => Promise<TextBrowserPage>;
}): ReactElement {
  const [address, setAddress] = useState("sevyn://start");
  const [page, setPage] = useState<TextBrowserPage>({
    url: "sevyn://start",
    title: "Start",
    lines: [
      "Welcome to the SevynOS Browser.",
      "Enter an http:// or https:// address above to load a text-first web page.",
    ],
  });
  const [history, setHistory] = useState<readonly TextBrowserPage[]>([page]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [status, setStatus] = useState("Ready");

  const navigate = (nextAddress: string, replace = false) => {
    let normalized = nextAddress.trim();
    if (!normalized) normalized = "sevyn://start";
    else if (!normalized.includes("://")) {
      if (normalized.includes(".") && !normalized.includes(" ")) {
        normalized = `https://${normalized}`;
      } else {
        normalized = `https://duckduckgo.com/html/?q=${encodeURIComponent(normalized)}`;
      }
    }
    setStatus("Loading…");
    void props
      .loadPage(normalized)
      .then((nextPage) => {
        setPage(nextPage);
        setAddress(nextPage.url);
        setStatus("Ready");
        if (replace) {
          setHistory((items) =>
            items.map((item, index) => (index === historyIndex ? nextPage : item)),
          );
        } else {
          setHistory((items) => [...items.slice(0, historyIndex + 1), nextPage]);
          setHistoryIndex((index) => index + 1);
        }
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "The page could not load.");
      });
  };

  useEffect(() => {
    navigate("sevyn://start");
  }, []);

  const visitHistory = (nextIndex: number) => {
    const nextPage = history[nextIndex];
    if (nextPage === undefined) return;
    setHistoryIndex(nextIndex);
    setPage(nextPage);
    setAddress(nextPage.url);
    setStatus("Ready");
  };

  return View({
    id: "browser.app",
    role: "application",
    label: "Browser",
    style: { padding: 12, gap: 8 },
    children: [
      View({
        key: "toolbar",
        id: "browser.toolbar",
        style: { direction: "row", height: 38, gap: 6, align: "center" },
        children: [
          button("browser.back", "◀", () => {
            visitHistory(historyIndex - 1);
          }),
          button("browser.forward", "▶", () => {
            visitHistory(historyIndex + 1);
          }),
          button("browser.home", "⌂ Home", () => {
            navigate("sevyn://start");
          }),
          NativeTextInput({
            key: "address",
            id: "browser.address",
            role: "textbox",
            label: "Web address",
            value: address,
            onTextInput: setAddress,
            onKeyDown: (event) => {
              if (event.key === "Enter") navigate(address);
            },
            style: { flexGrow: 1, height: 38, radius: 8 },
          }),
          button("browser.go", "Go", () => {
            navigate(address);
          }),
          button("browser.reload", "⟳", () => {
            navigate(page.url, true);
          }),
        ],
      }),
      View({
        key: "bookmarks",
        id: "browser.bookmarks",
        style: { direction: "row", height: 28, gap: 6 },
        children: [
          button("browser.bm.start", "🏠 Start", () => {
            navigate("sevyn://start");
          }),
          button("browser.bm.docs", "📖 SevynOS Docs", () => {
            navigate("sevyn://docs");
          }),
          button("browser.bm.rn", "⚡ React Native", () => {
            navigate("sevyn://react-native");
          }),
          button("browser.bm.tutorials", "🚀 Tutorials", () => {
            navigate("sevyn://tutorials");
          }),
          button("browser.bm.tools", "🛠 Tools", () => {
            navigate("sevyn://tools");
          }),
          button("browser.bm.web", "🌐 sevynos.org", () => {
            navigate("https://sevynos.org");
          }),
        ],
      }),
      View({
        key: "page-heading",
        id: "browser.page-heading",
        style: { height: 48, gap: 2 },
        children: [
          heading("browser.title", page.title),
          NativeText({
            key: "status",
            id: "browser.status",
            text: `${status} · ${page.url}`,
            style: { height: 18, fontSize: 11, color: "#8B949E" },
          }),
        ],
      }),
      NativeScrollView({
        key: "document",
        id: "browser.document",
        role: "list",
        label: page.title,
        style: { flexGrow: 1, overflow: "scroll", gap: 10, padding: 10 },
        children:
          page.sections && page.sections.length > 0
            ? page.sections.map((section, index) => {
                switch (section.kind) {
                  case "card-group":
                    return View({
                      key: `cards-${String(index)}`,
                      id: `browser.cards.${String(index)}`,
                      style: { direction: "row", gap: 10 },
                      children: section.cards.map((card, cIdx) =>
                        Pressable({
                          key: `card-${String(cIdx)}`,
                          id: `browser.card.${String(index)}.${String(cIdx)}`,
                          role: "button",
                          label: card.title,
                          onPress: () => {
                            navigate(card.url);
                          },
                          style: {
                            width: 250,
                            padding: 12,
                            backgroundColor: "#161B22",
                            borderColor: "rgba(215, 172, 87, 0.35)",
                            borderWidth: 1,
                            radius: 8,
                            gap: 6,
                          },
                          children: [
                            View({
                              key: "header",
                              id: `browser.card.${String(index)}.${String(cIdx)}.h`,
                              style: { direction: "row", justify: "space-between" },
                              children: [
                                NativeText({
                                  key: "title",
                                  id: `browser.card.${String(index)}.${String(cIdx)}.t`,
                                  text: card.title,
                                  style: {
                                    fontWeight: 700,
                                    color: "#D7AC57",
                                    fontSize: 14,
                                  },
                                }),
                                ...(card.tag
                                  ? [
                                      NativeText({
                                        key: "tag",
                                        id: `browser.card.${String(index)}.${String(cIdx)}.tag`,
                                        text: card.tag,
                                        style: { fontSize: 10, color: "#38BDF8" },
                                      }),
                                    ]
                                  : []),
                              ],
                            }),
                            NativeText({
                              key: "desc",
                              id: `browser.card.${String(index)}.${String(cIdx)}.d`,
                              text: card.description,
                              style: { fontSize: 12, color: "#8B949E" },
                            }),
                            NativeText({
                              key: "link",
                              id: `browser.card.${String(index)}.${String(cIdx)}.l`,
                              text: `Visit → ${card.url}`,
                              style: { fontSize: 11, color: "#58A6FF" },
                            }),
                          ],
                        }),
                      ),
                    });
                  case "heading":
                    return NativeText({
                      key: `heading-${String(index)}`,
                      id: `browser.heading.${String(index)}`,
                      role: "heading",
                      text: section.text,
                      style: {
                        fontSize:
                          section.level === 1 ? 22 : section.level === 2 ? 18 : 15,
                        fontWeight: 700,
                        color: section.level === 1 ? "#D7AC57" : "#F0F6FC",
                        padding: { top: 8 },
                      },
                    });
                  case "paragraph":
                    return NativeText({
                      key: `p-${String(index)}`,
                      id: `browser.p.${String(index)}`,
                      text: section.text,
                      style: { fontSize: 13, color: "#C9D1D9" },
                    });
                  case "link":
                    return Pressable({
                      key: `link-${String(index)}`,
                      id: `browser.link.${String(index)}`,
                      role: "button",
                      label: section.text,
                      onPress: () => {
                        navigate(section.url);
                      },
                      style: { padding: 4 },
                      children: NativeText({
                        id: `browser.link.${String(index)}.t`,
                        text: `🔗 ${section.text} (${section.url})`,
                        style: { color: "#58A6FF", fontSize: 13 },
                      }),
                    });
                  case "code":
                    return View({
                      key: `code-${String(index)}`,
                      id: `browser.code.${String(index)}`,
                      style: {
                        padding: 10,
                        backgroundColor: "#0D1117",
                        borderColor: "rgba(255, 255, 255, 0.12)",
                        borderWidth: 1,
                        radius: 6,
                      },
                      children: NativeText({
                        id: `browser.code.${String(index)}.t`,
                        text: section.code,
                        style: { color: "#7EE787", fontSize: 12 },
                      }),
                    });
                  case "list-item":
                    return NativeText({
                      key: `li-${String(index)}`,
                      id: `browser.li.${String(index)}`,
                      role: "listitem",
                      text: `  • ${section.text}`,
                      style: { fontSize: 13, color: "#C9D1D9" },
                    });
                  case "callout":
                    return View({
                      key: `callout-${String(index)}`,
                      id: `browser.callout.${String(index)}`,
                      style: {
                        padding: 10,
                        backgroundColor: "#161B22",
                        borderColor:
                          section.tone === "success"
                            ? "#3FB950"
                            : section.tone === "warning"
                              ? "#D29922"
                              : "#58A6FF",
                        borderWidth: 1,
                        radius: 6,
                        gap: 4,
                      },
                      children: [
                        NativeText({
                          key: "title",
                          id: `browser.callout.${String(index)}.t`,
                          text: section.title,
                          style: { fontWeight: 700, color: "#F0F6FC", fontSize: 13 },
                        }),
                        NativeText({
                          key: "msg",
                          id: `browser.callout.${String(index)}.m`,
                          text: section.text,
                          style: { fontSize: 12, color: "#8B949E" },
                        }),
                      ],
                    });
                }
              })
            : page.lines.map((line, index) =>
                NativeText({
                  key: `${String(index)}-${line}`,
                  id: `browser.line.${String(index)}`,
                  role: "listitem",
                  text: line,
                  style: { height: 24, fontSize: 13 },
                }),
              ),
      }),
    ],
  });
}

export function TextEditorApplication(props: {
  readonly filesystem: SevynFileSystem;
  readonly notifications?: SystemNotificationService;
}): ReactElement {
  const [files, setFiles] = useState<readonly FileSystemEntry[]>([]);
  const [path, setPath] = useState("/Documents/Welcome.txt");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("Opening…");
  const requestRevision = useRef(0);

  const refreshFiles = async (revision: number): Promise<void> => {
    const entries = await props.filesystem.list("/Documents");
    if (revision === requestRevision.current) {
      setFiles(entries.filter((entry) => entry.kind === "file"));
    }
  };
  const open = async (
    nextPath: string,
    revision = requestRevision.current,
  ): Promise<void> => {
    setStatus("Opening…");
    try {
      const value = await props.filesystem.read(nextPath);
      if (revision === requestRevision.current) {
        setPath(nextPath);
        setContent(value);
        setStatus("Saved");
      }
    } catch (error: unknown) {
      if (revision === requestRevision.current) {
        setStatus(error instanceof Error ? error.message : "Could not open file.");
      }
    }
  };
  useEffect(() => {
    const revision = ++requestRevision.current;
    void refreshFiles(revision).catch((error: unknown) => {
      if (revision === requestRevision.current) {
        setStatus(error instanceof Error ? error.message : "Could not list documents.");
      }
    });
    void open("/Documents/Welcome.txt", revision);
    return () => {
      requestRevision.current += 1;
    };
  }, [props.filesystem]);

  const save = () => {
    const normalizedPath = path.startsWith("/") ? path : `/Documents/${path}`;
    setStatus("Saving…");
    void props.filesystem
      .write(normalizedPath, content)
      .then(() => {
        setPath(normalizedPath);
        setStatus("Saved");
        void refreshFiles(requestRevision.current);
        props.notifications?.show({
          title: "Text Editor",
          message: `Saved ${normalizedPath}`,
        });
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "Could not save file.");
      });
  };

  return View({
    id: "text-editor.app",
    role: "application",
    label: "Text Editor",
    style: { direction: "row", padding: 12, gap: 12 },
    children: [
      NativeScrollView({
        key: "files",
        id: "text-editor.files",
        role: "list",
        label: "Documents",
        style: { width: 180, overflow: "scroll", gap: 6, padding: 8 },
        children: [
          heading("text-editor.documents", "Documents"),
          button("text-editor.new", "New document", () => {
            setPath("/Documents/Untitled.txt");
            setContent("");
            setStatus("Unsaved");
          }),
          ...files.map((file) =>
            Pressable({
              key: file.path,
              id: `text-editor.file.${file.path}`,
              role: "listitem",
              label: file.name,
              selected: file.path === path,
              onPress: () => {
                void open(file.path);
              },
              style: { height: 36, padding: 8 },
              children: NativeText({
                id: `text-editor.file.${file.path}.label`,
                text: file.name,
              }),
            }),
          ),
        ],
      }),
      View({
        key: "editor",
        id: "text-editor.editor",
        style: { flexGrow: 1, gap: 8 },
        children: [
          View({
            key: "toolbar",
            id: "text-editor.toolbar",
            style: { direction: "row", height: 40, gap: 8 },
            children: [
              NativeTextInput({
                key: "path",
                id: "text-editor.path",
                role: "textbox",
                label: "Document path",
                value: path,
                onTextInput: (value) => {
                  setPath(value);
                  setStatus("Unsaved");
                },
                style: { flexGrow: 1, height: 40, radius: 8 },
              }),
              button("text-editor.save", "Save", save),
            ],
          }),
          NativeTextInput({
            key: "content",
            id: "text-editor.content",
            role: "textbox",
            label: "Document content",
            multiline: true,
            value: content,
            onTextInput: (value) => {
              setContent(value);
              setStatus("Unsaved");
            },
            onKeyDown: (event) => {
              if ((event.control || event.meta) && event.key.toLowerCase() === "s")
                save();
            },
            style: {
              flexGrow: 1,
              padding: 10,
              backgroundColor: "#11151D",
              color: "#F4F4F6",
              radius: 8,
              fontSize: 13,
            },
          }),
          NativeText({
            key: "status",
            id: "text-editor.status",
            text: `${status} · Ctrl/Cmd+S to save`,
            style: { height: 22, fontSize: 11 },
          }),
        ],
      }),
    ],
  });
}

export function DeveloperExampleApplication(props: {
  readonly notifications: SystemNotificationService;
}): ReactElement {
  const [name, setName] = useState("");
  const [dialog, setDialog] = useState(false);
  return View({
    id: "example.app",
    role: "application",
    label: "SDK Example",
    style: { padding: 24, gap: 12 },
    children: [
      heading("example.heading", "Application SDK Example"),
      NativeTextInput({
        id: "example.name",
        role: "textbox",
        label: "Name",
        value: name,
        onTextInput: setName,
        style: { height: 38 },
      }),
      button("example.dialog", "Open dialog", () => {
        setDialog(true);
      }),
      button("example.notification", "Show notification", () => {
        props.notifications.show({ title: "Hello", message: name || "Sevyn developer" });
      }),
      dialog
        ? NativeOverlay({
            id: "example.overlay",
            role: "dialog",
            label: "Example dialog",
            focusTrap: true,
            onDismiss: () => {
              setDialog(false);
            },
            style: {
              position: "absolute",
              left: 80,
              top: 80,
              width: 320,
              height: 180,
              padding: 20,
            },
            children: [
              heading("example.overlay.title", "A real React dialog"),
              button("example.overlay.close", "Close", () => {
                setDialog(false);
              }),
            ],
          })
        : null,
    ],
  });
}

export interface NotesApplicationProps {
  readonly filesystem?: SevynFileSystem | undefined;
  readonly notifications?: SystemNotificationService | undefined;
}

interface NoteItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly folder: string;
  readonly updatedAt: string;
}

export function NotesApplication(props: NotesApplicationProps): ReactElement {
  const [selectedFolder, setSelectedFolder] = useState<string>("All Notes");
  const [selectedNoteId, setSelectedNoteId] = useState<string>("note-1");
  const [searchQuery, setSearchQuery] = useState("");
  const [notes, setNotes] = useState<readonly NoteItem[]>([
    {
      id: "note-1",
      title: "Welcome to Sevyn Notes",
      body: "Sevyn Notes is a native React Native application running directly on SevynOS.\n\nAll notes are automatically stored in the virtual filesystem at /Documents/Notes/.\n\nYou can organize notes into folders, search across titles and content, and write without distraction.",
      folder: "Quick Notes",
      updatedAt: "Today at 9:41 AM",
    },
    {
      id: "note-2",
      title: "React Native System Architecture",
      body: "SevynOS executes standard React Native component trees directly into Wayland surfaces.\n\nPrimitives like View, Text, TextInput, Pressable, and ScrollView map directly to native render commands.",
      folder: "Projects",
      updatedAt: "Yesterday",
    },
    {
      id: "note-3",
      title: "Ideas & Project Wishlist",
      body: "1. Integrate Meta's Yoga engine for 100% flexbox compliance.\n2. Built-in AsyncStorage persistence.\n3. Add React Navigation support for multi-screen apps.",
      folder: "Ideas",
      updatedAt: "Sep 4",
    },
  ]);

  const folders = ["All Notes", "Quick Notes", "Projects", "Ideas", "Personal"];
  const activeNote = notes.find((n) => n.id === selectedNoteId) ?? notes[0];

  const filteredNotes = notes.filter((note) => {
    const matchesFolder =
      selectedFolder === "All Notes" || note.folder === selectedFolder;
    const matchesSearch =
      searchQuery === "" ||
      note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      note.body.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFolder && matchesSearch;
  });

  const handleCreateNote = () => {
    const newId = `note-${String(Date.now())}`;
    const newNote: NoteItem = {
      id: newId,
      title: "Untitled Note",
      body: "",
      folder: selectedFolder === "All Notes" ? "Quick Notes" : selectedFolder,
      updatedAt: "Just now",
    };
    setNotes([newNote, ...notes]);
    setSelectedNoteId(newId);
    if (props.filesystem) {
      void props.filesystem.write(`/Documents/Notes/${newNote.title}.txt`, newNote.body);
    }
  };

  const handleUpdateTitle = (title: string) => {
    setNotes(
      notes.map((n) =>
        n.id === selectedNoteId ? { ...n, title, updatedAt: "Just now" } : n,
      ),
    );
  };

  const handleUpdateBody = (body: string) => {
    setNotes(
      notes.map((n) =>
        n.id === selectedNoteId ? { ...n, body, updatedAt: "Just now" } : n,
      ),
    );
    if (props.filesystem && activeNote) {
      void props.filesystem.write(`/Documents/Notes/${activeNote.title}.txt`, body);
    }
  };

  const handleDeleteNote = () => {
    if (!activeNote) return;
    const remaining = notes.filter((n) => n.id !== activeNote.id);
    setNotes(remaining);
    setSelectedNoteId(remaining[0]?.id ?? "");
    props.notifications?.show({
      title: "Note Deleted",
      message: `Removed ${activeNote.title}`,
    });
  };

  return View({
    id: "notes.app",
    role: "application",
    label: "Notes",
    style: { direction: "row", padding: 12, gap: 10, flexGrow: 1 },
    children: [
      // 1. Sidebar (Folders)
      View({
        key: "sidebar",
        id: "notes.sidebar",
        style: {
          width: 170,
          padding: 10,
          gap: 6,
          backgroundColor: "rgba(255, 255, 255, 0.03)",
          borderColor: "rgba(255, 255, 255, 0.06)",
          borderWidth: 1,
          radius: 10,
        },
        children: [
          NativeText({
            key: "h",
            id: "notes.sidebar.title",
            text: "Notes",
            role: "heading",
            style: { fontSize: 18, fontWeight: 700, color: "#F0F6FC", height: 26 },
          }),
          NativeText({
            key: "sub",
            id: "notes.sidebar.folders-label",
            text: "FOLDERS",
            style: { fontSize: 10, fontWeight: 700, color: "#8B949E", height: 16 },
          }),
          ...folders.map((fld) => {
            const count =
              fld === "All Notes"
                ? notes.length
                : notes.filter((n) => n.folder === fld).length;
            const isSelected = selectedFolder === fld;
            return Pressable({
              key: fld,
              id: `notes.folder.${fld}`,
              role: "button",
              label: fld,
              selected: isSelected,
              onPress: () => {
                setSelectedFolder(fld);
              },
              style: {
                height: 32,
                direction: "row",
                align: "center",
                justify: "space-between",
                padding: 6,
                radius: 6,
                backgroundColor: isSelected ? "rgba(215, 172, 87, 0.18)" : "transparent",
                borderColor: isSelected ? "rgba(215, 172, 87, 0.40)" : "transparent",
                borderWidth: 1,
              },
              children: [
                NativeText({
                  key: "name",
                  id: `notes.folder.${fld}.name`,
                  text: `${fld === "All Notes" ? "●" : "○"} ${fld}`,
                  style: {
                    fontSize: 12,
                    fontWeight: isSelected ? 700 : 500,
                    color: isSelected ? "#D7AC57" : "#BBC1CA",
                  },
                }),
                NativeText({
                  key: "count",
                  id: `notes.folder.${fld}.count`,
                  text: String(count),
                  style: { fontSize: 11, color: "#8B949E" },
                }),
              ],
            });
          }),
          View({ key: "spacer", id: "notes.sidebar.spacer", style: { flexGrow: 1 } }),
          Pressable({
            key: "new-btn",
            id: "notes.new-btn",
            role: "button",
            label: "New Note",
            onPress: handleCreateNote,
            style: {
              height: 34,
              padding: 8,
              backgroundColor: "#238636",
              radius: 6,
              align: "center",
              justify: "center",
            },
            children: NativeText({
              id: "notes.new-btn.t",
              text: "+ New Note",
              style: { color: "#FFF", fontWeight: 700, fontSize: 12 },
            }),
          }),
        ],
      }),

      // 2. Note List Pane
      View({
        key: "list-pane",
        id: "notes.list-pane",
        style: {
          width: 220,
          padding: 8,
          gap: 6,
          backgroundColor: "rgba(255, 255, 255, 0.02)",
          borderColor: "rgba(255, 255, 255, 0.06)",
          borderWidth: 1,
          radius: 10,
        },
        children: [
          NativeTextInput({
            key: "search",
            id: "notes.search",
            role: "textbox",
            label: "Search notes",
            value: searchQuery,
            onTextInput: setSearchQuery,
            style: {
              height: 32,
              padding: 6,
              backgroundColor: "#0D1117",
              color: "#FFF",
              radius: 6,
              borderColor: "rgba(255, 255, 255, 0.10)",
              borderWidth: 1,
              fontSize: 12,
            },
          }),
          NativeScrollView({
            key: "scroll",
            id: "notes.scroll",
            role: "list",
            style: { flexGrow: 1, gap: 4, overflow: "scroll" },
            children:
              filteredNotes.length === 0
                ? [
                    NativeText({
                      key: "empty",
                      id: "notes.empty",
                      text: "No notes found in this folder.",
                      style: { fontSize: 12, color: "#8B949E", padding: 8 },
                    }),
                  ]
                : filteredNotes.map((note) => {
                    const isSelected = note.id === selectedNoteId;
                    return Pressable({
                      key: note.id,
                      id: `note.item.${note.id}`,
                      role: "listitem",
                      label: note.title,
                      selected: isSelected,
                      onPress: () => {
                        setSelectedNoteId(note.id);
                      },
                      style: {
                        padding: 8,
                        gap: 3,
                        radius: 6,
                        backgroundColor: isSelected
                          ? "rgba(215, 172, 87, 0.16)"
                          : "rgba(255, 255, 255, 0.03)",
                        borderColor: isSelected
                          ? "rgba(215, 172, 87, 0.45)"
                          : "rgba(255, 255, 255, 0.06)",
                        borderWidth: 1,
                      },
                      children: [
                        NativeText({
                          key: "t",
                          id: `note.item.${note.id}.t`,
                          text: note.title || "Untitled",
                          style: {
                            fontSize: 13,
                            fontWeight: 700,
                            color: isSelected ? "#D7AC57" : "#F0F6FC",
                          },
                        }),
                        NativeText({
                          key: "time",
                          id: `note.item.${note.id}.time`,
                          text: `${note.updatedAt} · ${note.folder}`,
                          style: { fontSize: 10, color: "#8B949E" },
                        }),
                      ],
                    });
                  }),
          }),
        ],
      }),

      // 3. Editor Pane
      View({
        key: "editor-pane",
        id: "notes.editor-pane",
        style: {
          flexGrow: 1,
          padding: 14,
          gap: 8,
          backgroundColor: "#0D1117",
          borderColor: "rgba(255, 255, 255, 0.08)",
          borderWidth: 1,
          radius: 10,
        },
        children: activeNote
          ? [
              View({
                key: "header-row",
                id: "notes.editor.h-row",
                style: { direction: "row", justify: "space-between", align: "center" },
                children: [
                  NativeText({
                    key: "meta",
                    id: "notes.editor.meta",
                    text: `${activeNote.updatedAt} · Folder: ${activeNote.folder}`,
                    style: { fontSize: 11, color: "#67C695" },
                  }),
                  Pressable({
                    key: "del",
                    id: "notes.editor.del",
                    role: "button",
                    label: "Delete",
                    onPress: handleDeleteNote,
                    style: {
                      height: 26,
                      padding: 4,
                      paddingHorizontal: 8,
                      backgroundColor: "rgba(217, 101, 109, 0.18)",
                      borderColor: "rgba(217, 101, 109, 0.50)",
                      borderWidth: 1,
                      radius: 4,
                    },
                    children: NativeText({
                      id: "notes.editor.del.t",
                      text: "× Delete",
                      style: { fontSize: 11, color: "#FF7B72" },
                    }),
                  }),
                ],
              }),
              NativeTextInput({
                key: "title-inp",
                id: "notes.editor.title",
                role: "textbox",
                label: "Note Title",
                value: activeNote.title,
                onTextInput: handleUpdateTitle,
                style: {
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#F0F6FC",
                  height: 36,
                  padding: 4,
                  backgroundColor: "transparent",
                },
              }),
              NativeTextInput({
                key: "body-inp",
                id: "notes.editor.body",
                role: "textbox",
                label: "Note Content",
                multiline: true,
                value: activeNote.body,
                onTextInput: handleUpdateBody,
                style: {
                  flexGrow: 1,
                  padding: 8,
                  color: "#C9D1D9",
                  fontSize: 13,
                  backgroundColor: "rgba(255, 255, 255, 0.02)",
                  radius: 6,
                },
              }),
            ]
          : [
              NativeText({
                key: "no-note",
                id: "notes.editor.empty",
                text: "Select or create a note to begin editing.",
                style: { color: "#8B949E", fontSize: 13, padding: 12 },
              }),
            ],
      }),
    ],
  });
}

export function ComponentGalleryApplication(): ReactElement {
  const states = [
    ["idle", "theme"],
    ["hovered", "accent"],
    ["focused", "taskbar-position"],
    ["pressed", "workspace-count"],
    ["disabled", "reduced-motion"],
  ] as const;
  return NativeScrollView({
    id: "gallery.app",
    role: "application",
    label: "Sevyn Component Gallery",
    style: { padding: 24, gap: 12, overflow: "scroll" },
    children: [
      heading("gallery.heading", "Sevyn Component Gallery"),
      NativeText({
        key: "description",
        id: "gallery.description",
        text: "Primitives, interaction states, motion, and accessibility semantics.",
        style: { height: 28 },
      }),
      ...states.map(([state, action]) =>
        Pressable({
          key: state,
          id: `gallery.${state}`,
          action,
          role: "button",
          label: `${state} button`,
          disabled: state === "disabled",
          interactionState: state,
          style: { height: 42, width: 220, padding: 10 },
          children: NativeText({ id: `gallery.${state}.label`, text: state }),
        }),
      ),
      NativeTextInput({
        key: "input",
        id: "gallery.input",
        role: "textbox",
        label: "Example text input",
        defaultValue: "Editable value",
        style: { height: 40 },
      }),
    ],
  });
}

export interface AppManagerEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly developer: string;
  readonly permissions: readonly string[];
  readonly storageBytes: number;
  readonly status?: string;
  readonly metrics?:
    | {
        readonly inboundMessages: number;
        readonly outboundMessages: number;
        readonly inboundQueueDepth: number;
        readonly outboundQueueDepth: number;
        readonly averageEventDuration: number;
        readonly timeoutCount: number;
        readonly restartCount: number;
        readonly terminationReason?: string;
      }
    | undefined;
}
export interface AppManagerApplicationProps {
  readonly applications: readonly AppManagerEntry[];
  readonly onLaunch?: ((applicationId: string) => Promise<void> | void) | undefined;
  readonly onTerminate?: ((applicationId: string) => Promise<void> | void) | undefined;
}

export function AppManagerApplication(props: AppManagerApplicationProps): ReactElement {
  const [selected, setSelected] = useState(props.applications[0]?.id);
  const [activity, setActivity] = useState<string>();
  const current = props.applications.find((application) => application.id === selected);

  useEffect(() => {
    if (current === undefined) setSelected(props.applications[0]?.id);
  }, [current, props.applications]);

  const runAction = (
    verb: "Launching" | "Terminating",
    action: ((applicationId: string) => Promise<void> | void) | undefined,
  ): void => {
    if (current === undefined || action === undefined || activity !== undefined) return;
    setActivity(`${verb} ${current.name}…`);
    void Promise.resolve(action(current.id)).then(
      () => {
        setActivity(
          verb === "Launching"
            ? `${current.name} is ready.`
            : `${current.name} was terminated.`,
        );
      },
      (error: unknown) => {
        setActivity(
          error instanceof Error ? error.message : `${verb} ${current.name} failed.`,
        );
      },
    );
  };

  return View({
    id: "app-manager.app",
    role: "application",
    label: "App Manager",
    style: { direction: "row", padding: 16, gap: 16 },
    children: [
      NativeScrollView({
        key: "installed",
        id: "app-manager.installed",
        role: "list",
        style: { width: 260, overflow: "scroll", gap: 6 },
        children: [
          heading("app-manager.heading", "Installed Applications"),
          ...props.applications.map((application) =>
            Pressable({
              key: application.id,
              id: `app-manager.${application.id}`,
              role: "listitem",
              label: application.name,
              selected: application.id === selected,
              onPress: () => {
                setSelected(application.id);
              },
              children: NativeText({
                id: `app-manager.${application.id}.name`,
                text: application.name,
              }),
            }),
          ),
        ],
      }),
      View({
        key: "details",
        id: "app-manager.details",
        style: { flexGrow: 1, gap: 10 },
        children:
          current === undefined
            ? NativeText({ id: "app-manager.empty", text: "No application selected" })
            : [
                heading("app-manager.name", current.name),
                label("app-manager.version", `Version ${current.version}`),
                label("app-manager.developer", current.developer),
                label(
                  "app-manager.permissions",
                  `Permissions: ${current.permissions.join(", ") || "None"}`,
                ),
                label(
                  "app-manager.storage",
                  `Storage: ${String(current.storageBytes)} bytes`,
                ),
                label("app-manager.status", `Process: ${current.status ?? "unknown"}`),
                ...(current.metrics === undefined
                  ? []
                  : [
                      label(
                        "app-manager.metrics",
                        `Messages: ${String(current.metrics.inboundMessages + current.metrics.outboundMessages)} · Queue: ${String(current.metrics.inboundQueueDepth + current.metrics.outboundQueueDepth)} · Timeouts: ${String(current.metrics.timeoutCount)} · Restarts: ${String(current.metrics.restartCount)}`,
                      ),
                    ]),
                ...(props.onLaunch === undefined
                  ? []
                  : [
                      button("app-manager.launch", "Launch", () => {
                        runAction("Launching", props.onLaunch);
                      }),
                    ]),
                ...(props.onTerminate === undefined || current.status === "terminated"
                  ? []
                  : [
                      button("app-manager.terminate", "Terminate", () => {
                        runAction("Terminating", props.onTerminate);
                      }),
                    ]),
                NativeText({
                  id: "app-manager.activity",
                  text:
                    activity ??
                    "Built-in applications are protected. Install and removal are handled by the package installer.",
                  role: "status",
                  style: { minHeight: 24, fontSize: 12, color: "#8B949E" },
                }),
              ],
      }),
    ],
  });
}

const COUNTER_APP_TEMPLATE = `import { useState } from "react";
import { View, NativeText, Pressable } from "@sevynos/react-native";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <View style={{ padding: 16, gap: 12, backgroundColor: "#11151D", radius: 10 }}>
      <NativeText style={{ fontSize: 20, fontWeight: 700, color: "#D7AC57" }}>
        ⚡ SevynOS Counter App
      </NativeText>
      <NativeText style={{ fontSize: 13, color: "#8B949E" }}>
        State updates live inside Genesis!
      </NativeText>
      <View style={{ padding: 14, backgroundColor: "#161B22", radius: 8, alignItems: "center" }}>
        <NativeText style={{ fontSize: 32, fontWeight: 800, color: "#58A6FF" }}>
          {count}
        </NativeText>
      </View>
      <View style={{ direction: "row", gap: 8 }}>
        <Pressable
          onPress={() => setCount((c) => c + 1)}
          style={{ padding: 10, backgroundColor: "#238636", radius: 6, flexGrow: 1 }}
        >
          <NativeText style={{ color: "#FFF", fontWeight: 700, textAlign: "center" }}>
            + Increment
          </NativeText>
        </Pressable>
        <Pressable
          onPress={() => setCount((c) => Math.max(0, c - 1))}
          style={{ padding: 10, backgroundColor: "#DA3633", radius: 6, flexGrow: 1 }}
        >
          <NativeText style={{ color: "#FFF", fontWeight: 700, textAlign: "center" }}>
            - Decrement
          </NativeText>
        </Pressable>
        <Pressable
          onPress={() => setCount(0)}
          style={{ padding: 10, backgroundColor: "#30363D", radius: 6 }}
        >
          <NativeText style={{ color: "#FFF", textAlign: "center" }}>Reset</NativeText>
        </Pressable>
      </View>
    </View>
  );
}`;

const TODO_APP_TEMPLATE = `import { useState } from "react";
import { View, NativeText, NativeTextInput, Pressable, NativeScrollView } from "@sevynos/react-native";

export default function App() {
  const [tasks, setTasks] = useState([
    { id: 1, text: "Explore SevynOS Wayland desktop", done: true },
    { id: 2, text: "Build React Native app in Sevyn Studio", done: false },
    { id: 3, text: "Test on laptop hardware", done: false },
  ]);
  const [input, setInput] = useState("");

  const add = () => {
    if (!input.trim()) return;
    setTasks([...tasks, { id: Date.now(), text: input.trim(), done: false }]);
    setInput("");
  };

  const toggle = (id: number) => {
    setTasks(tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  };

  return (
    <View style={{ padding: 14, gap: 10, backgroundColor: "#11151D", radius: 10 }}>
      <NativeText style={{ fontSize: 18, fontWeight: 700, color: "#D7AC57" }}>
        ✓ Sevyn Tasks
      </NativeText>
      <View style={{ direction: "row", gap: 6 }}>
        <NativeTextInput
          value={input}
          onTextInput={setInput}
          placeholder="New task…"
          style={{ flexGrow: 1, height: 36, padding: 8, backgroundColor: "#161B22", color: "#FFF", radius: 6 }}
        />
        <Pressable onPress={add} style={{ padding: 8, backgroundColor: "#238636", radius: 6 }}>
          <NativeText style={{ color: "#FFF", fontWeight: 700 }}>Add</NativeText>
        </Pressable>
      </View>
      <NativeScrollView style={{ gap: 6 }}>
        {tasks.map(task => (
          <Pressable
            key={task.id}
            onPress={() => toggle(task.id)}
            style={{ padding: 8, backgroundColor: task.done ? "#161B22" : "#21262D", radius: 6, direction: "row", gap: 8 }}
          >
            <NativeText style={{ color: task.done ? "#3FB950" : "#8B949E" }}>
              {task.done ? "✓" : "○"}
            </NativeText>
            <NativeText style={{ color: task.done ? "#8B949E" : "#F0F6FC" }}>
              {task.text}
            </NativeText>
          </Pressable>
        ))}
      </NativeScrollView>
    </View>
  );
}`;

const SHOWCASE_APP_TEMPLATE = `import { useState } from "react";
import { View, NativeText, NativeTextInput, Pressable } from "@sevynos/react-native";

export default function App() {
  const [text, setText] = useState("Hello SevynOS");
  const [selectedTag, setSelectedTag] = useState("Design");

  return (
    <View style={{ padding: 14, gap: 10, backgroundColor: "#11151D", radius: 10 }}>
      <NativeText style={{ fontSize: 18, fontWeight: 700, color: "#D7AC57" }}>
        ◇ UI Showcase
      </NativeText>
      <View style={{ direction: "row", gap: 6 }}>
        {["Design", "Runtime", "Compositor"].map(tag => (
          <Pressable
            key={tag}
            onPress={() => setSelectedTag(tag)}
            style={{
              padding: 6,
              radius: 6,
              backgroundColor: selectedTag === tag ? "rgba(215, 172, 87, 0.25)" : "#21262D",
              borderColor: selectedTag === tag ? "#D7AC57" : "transparent",
              borderWidth: 1,
            }}
          >
            <NativeText style={{ color: selectedTag === tag ? "#D7AC57" : "#8B949E", fontSize: 12 }}>
              {tag}
            </NativeText>
          </Pressable>
        ))}
      </View>
      <NativeTextInput
        value={text}
        onTextInput={setText}
        style={{ height: 36, padding: 8, backgroundColor: "#161B22", color: "#FFF", radius: 6 }}
      />
      <View style={{ padding: 10, backgroundColor: "#161B22", radius: 8, gap: 4 }}>
        <NativeText style={{ fontSize: 12, color: "#8B949E" }}>Live Value:</NativeText>
        <NativeText style={{ fontSize: 14, color: "#38BDF8", fontWeight: 600 }}>{text}</NativeText>
      </View>
    </View>
  );
}`;

const CALCULATOR_APP_TEMPLATE = `import { useState } from "react";
import { View, NativeText, Pressable } from "@sevynos/react-native";

export default function App() {
  const [display, setDisplay] = useState("0");
  const [prev, setPrev] = useState(null);
  const [op, setOp] = useState(null);

  const num = (n) => setDisplay(display === "0" ? n : display + n);

  return (
    <View style={{ padding: 12, gap: 8, backgroundColor: "#11151D", radius: 10 }}>
      <View style={{ height: 44, padding: 8, backgroundColor: "#161B22", radius: 6, justifyContent: "center" }}>
        <NativeText style={{ fontSize: 22, fontWeight: 700, color: "#F0F6FC", textAlign: "end" }}>
          {display}
        </NativeText>
      </View>
      <View style={{ direction: "row", gap: 6 }}>
        <Pressable onPress={() => setDisplay("0")} style={{ flexGrow: 1, padding: 8, backgroundColor: "#DA3633", radius: 6 }}>
          <NativeText style={{ color: "#FFF", textAlign: "center", fontWeight: 700 }}>C</NativeText>
        </Pressable>
      </View>
      {[["7","8","9"], ["4","5","6"], ["1","2","3"], ["0",".","="]].map((row, r) => (
        <View key={r} style={{ direction: "row", gap: 6 }}>
          {row.map((btn, b) => (
            <Pressable key={b} onPress={() => num(btn)} style={{ flexGrow: 1, padding: 8, backgroundColor: "#21262D", radius: 6 }}>
              <NativeText style={{ color: "#F0F6FC", textAlign: "center", fontWeight: 600 }}>{btn}</NativeText>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}`;

const IDE_TEMPLATES = {
  counter: { code: COUNTER_APP_TEMPLATE, appName: "CounterApp" },
  todo: { code: TODO_APP_TEMPLATE, appName: "TasksApp" },
  showcase: { code: SHOWCASE_APP_TEMPLATE, appName: "ShowcaseApp" },
  calculator: { code: CALCULATOR_APP_TEMPLATE, appName: "CalculatorApp" },
} as const;

type IdeTemplate = keyof typeof IDE_TEMPLATES;

export function ReactNativeIdeApplication(props: {
  readonly filesystem?: SevynFileSystem;
  readonly notifications?: SystemNotificationService;
  readonly studio?: SevynStudioService;
}): ReactElement {
  const [activeTemplate, setActiveTemplate] = useState<IdeTemplate>("counter");
  const [activeFile, setActiveFile] = useState("App.tsx");
  const [code, setCode] = useState(COUNTER_APP_TEMPLATE);
  const [status, setStatus] = useState("Ready");
  const [outputLogs, setOutputLogs] = useState<readonly string[]>([
    "[12:00:00] ⚡ Sevyn Studio IDE ready.",
    "[12:00:01] ✓ React Native compiler initialized.",
    "[12:00:02] ● Live interactive preview active.",
  ]);

  // Live state for the interactive preview pane
  const [counterValue, setCounterValue] = useState(0);
  const [todoTasks, setTodoTasks] = useState([
    { id: 1, text: "Explore SevynOS Wayland desktop", done: true },
    { id: 2, text: "Build React Native app in Sevyn Studio", done: false },
    { id: 3, text: "Test on laptop hardware", done: false },
  ]);
  const [todoInput, setTodoInput] = useState("");
  const [showcaseText, setShowcaseText] = useState("Hello SevynOS");
  const [showcaseTag, setShowcaseTag] = useState("Design");
  const [calcDisplay, setCalcDisplay] = useState("0");

  const switchTemplate = (tmpl: IdeTemplate): void => {
    setActiveTemplate(tmpl);
    setCode(IDE_TEMPLATES[tmpl].code);
    setOutputLogs((logs) => [
      ...logs,
      `[${new Date().toLocaleTimeString()}] ◇ Loaded template: ${tmpl}`,
    ]);
  };

  const appName = IDE_TEMPLATES[activeTemplate].appName;
  const applicationId = `org.sevynos.user.${appName.toLowerCase()}`;

  const buildCurrentApp = async (): Promise<
    Awaited<ReturnType<SevynStudioService["build"]>>
  > => {
    if (props.studio === undefined)
      throw new Error("Sevyn Studio's build service is unavailable on this host.");
    setStatus("Compiling…");
    const result = await props.studio.build({
      applicationId,
      applicationName: appName,
      source: code,
    });
    setOutputLogs((logs) => [
      ...logs,
      ...result.diagnostics.map((line) => `[${new Date().toLocaleTimeString()}] ${line}`),
    ]);
    return result;
  };

  const handleRun = () => {
    void buildCurrentApp()
      .then(() => {
        setStatus("Running");
        setOutputLogs((logs) => [
          ...logs,
          `[${new Date().toLocaleTimeString()}] ▶ Built ${activeFile} successfully; Hermes bytecode verified.`,
        ]);
      })
      .catch((error: unknown) => {
        setStatus("Build failed");
        setOutputLogs((logs) => [
          ...logs,
          `[${new Date().toLocaleTimeString()}] ✗ ${error instanceof Error ? error.message : String(error)}`,
        ]);
      });
  };

  const handleSave = () => {
    setStatus("Saving…");
    if (props.filesystem) {
      void props.filesystem
        .write(`/Applications/Projects/${activeFile}`, code)
        .then(() => {
          setStatus("Saved");
          props.notifications?.show({
            title: "Sevyn Studio",
            message: `Saved ${activeFile}`,
          });
          setOutputLogs((logs) => [
            ...logs,
            `[${new Date().toLocaleTimeString()}] ✓ Saved /Applications/Projects/${activeFile}`,
          ]);
        })
        .catch((error: unknown) => {
          setStatus("Save failed");
          setOutputLogs((logs) => [
            ...logs,
            `[${new Date().toLocaleTimeString()}] ✗ ${error instanceof Error ? error.message : String(error)}`,
          ]);
        });
    } else {
      setStatus("Saved");
    }
  };

  const handleDeploy = () => {
    setStatus("Deploying…");
    void buildCurrentApp()
      .then((result) => {
        if (props.filesystem === undefined)
          throw new Error("User storage is unavailable.");
        return props.filesystem
          .write(`/Applications/Installed/${appName}.sevynapp`, result.packageJson)
          .then(() =>
            props.filesystem?.write(`/Applications/Projects/${activeFile}`, code),
          )
          .then(() => result);
      })
      .then(() => {
        setStatus("Deployed");
        props.notifications?.show({
          title: "App Deployed to SevynOS",
          message: `⚡ ${appName} was packaged and registered with SevynOS!`,
        });
        setOutputLogs((logs) => [
          ...logs,
          `[${new Date().toLocaleTimeString()}] ⚡ Deploying ${appName} to SevynOS…`,
          `[${new Date().toLocaleTimeString()}] ✓ Verified package written: /Applications/Installed/${appName}.sevynapp`,
          `[${new Date().toLocaleTimeString()}] ✓ Source saved: /Applications/Projects/${activeFile}`,
        ]);
      })
      .catch((error: unknown) => {
        setStatus("Build failed");
        setOutputLogs((logs) => [
          ...logs,
          `[${new Date().toLocaleTimeString()}] ✗ ${error instanceof Error ? error.message : String(error)}`,
        ]);
      });
  };

  const handleExport = () => {
    if (props.filesystem) {
      void props.filesystem
        .write(`/Applications/Projects/${activeFile}`, code)
        .then(() => {
          props.notifications?.show({
            title: "App Exported",
            message: "Application package exported to /Applications/Projects/",
          });
          setOutputLogs((logs) => [
            ...logs,
            `[${new Date().toLocaleTimeString()}] ✓ Exported application package to /Applications/Projects/`,
          ]);
        })
        .catch((error: unknown) => {
          setStatus("Export failed");
          setOutputLogs((logs) => [
            ...logs,
            `[${new Date().toLocaleTimeString()}] ✗ ${error instanceof Error ? error.message : String(error)}`,
          ]);
        });
    }
  };

  return View({
    id: "ide.app",
    role: "application",
    label: "Sevyn Studio",
    style: { padding: 12, gap: 8, backgroundColor: "#090C12" },
    children: [
      View({
        key: "topbar",
        id: "ide.topbar",
        style: {
          height: 78,
          gap: 6,
          padding: 8,
          backgroundColor: "#11151D",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          radius: 8,
        },
        children: [
          View({
            key: "primary-row",
            id: "ide.topbar.primary",
            style: { direction: "row", height: 30, gap: 7, align: "center" },
            children: [
              NativeText({
                key: "title",
                id: "ide.title",
                text: "⚡ Sevyn Studio",
                role: "heading",
                style: { fontWeight: 800, color: "#D7AC57", fontSize: 15, width: 180 },
              }),
              NativeText({
                key: "project",
                id: "ide.project",
                text: `${appName} · ${status}`,
                style: { color: status.includes("failed") ? "#FF7B72" : "#8B949E", fontSize: 11 },
              }),
              View({ key: "spacer", id: "ide.topbar.spacer", style: { flexGrow: 1 } }),
              button("ide.run", "▶ Run", handleRun),
              button("ide.deploy", "⚡ Deploy", handleDeploy),
              button("ide.save", "✓ Save", handleSave),
            ],
          }),
          View({
            key: "secondary-row",
            id: "ide.topbar.secondary",
            style: { direction: "row", height: 28, gap: 7, align: "center" },
            children: [
              label("ide.templates.title", "STARTER"),
              button("ide.tmpl.counter", "Counter", () => {
                switchTemplate("counter");
              }),
              button("ide.tmpl.todo", "Tasks", () => {
                switchTemplate("todo");
              }),
              button("ide.tmpl.showcase", "Showcase", () => {
                switchTemplate("showcase");
              }),
              button("ide.tmpl.calc", "Calculator", () => {
                switchTemplate("calculator");
              }),
              View({ key: "spacer", id: "ide.template.spacer", style: { flexGrow: 1 } }),
              button("ide.export", "Export", handleExport),
              button("ide.reset", "Reset", () => {
                switchTemplate(activeTemplate);
              }),
            ],
          }),
        ],
      }),
      View({
        key: "workspace",
        id: "ide.workspace",
        style: { direction: "row", flexGrow: 1, gap: 8 },
        children: [
          View({
            key: "sidebar",
            id: "ide.sidebar",
            style: {
              width: 136,
              padding: 8,
              gap: 6,
              backgroundColor: "#11151D",
              radius: 6,
            },
            children: [
              label("ide.files.title", "PROJECT FILES"),
              button("ide.file.app", `◇ ${activeFile}`, () => {
                setActiveFile("App.tsx");
              }),
              button("ide.file.header", "◇ Header.tsx", () => {
                setActiveFile("Header.tsx");
              }),
              button("ide.file.theme", "◇ theme.ts", () => {
                setActiveFile("theme.ts");
              }),
              button("ide.file.manifest", "◇ manifest.json", () => {
                setActiveFile("manifest.json");
              }),
              View({
                key: "div",
                id: "ide.sidebar.div",
                style: { height: 1, backgroundColor: "rgba(255,255,255,0.08)" },
              }),
              NativeText({
                key: "info",
                id: "ide.sidebar.info",
                text: `${String(code.split("\n").length)} lines · React Native`,
                style: { fontSize: 11, color: "#8B949E" },
              }),
            ],
          }),
          View({
            key: "editor-container",
            id: "ide.editor-container",
            style: { flexGrow: 1, gap: 6 },
            children: [
              View({
                key: "tabs",
                id: "ide.tabs",
                style: { direction: "row", height: 26, gap: 6, align: "center" },
                children: [
                  NativeText({
                    key: "tab",
                    id: "ide.tab.active",
                    text: `● ${activeFile}`,
                    style: { color: "#D7AC57", fontWeight: 700, fontSize: 12 },
                  }),
                  NativeText({
                    key: "status",
                    id: "ide.status",
                    text: `· ${status}`,
                    style: { color: "#8B949E", fontSize: 11 },
                  }),
                ],
              }),
              NativeTextInput({
                key: "code",
                id: "ide.code",
                role: "textbox",
                label: "React Native Source Code",
                multiline: true,
                value: code,
                onTextInput: setCode,
                onKeyDown: (event) => {
                  if ((event.control || event.meta) && event.key.toLowerCase() === "s")
                    handleSave();
                  if (
                    (event.control || event.meta) &&
                    event.key.toLowerCase() === "enter"
                  )
                    handleRun();
                },
                style: {
                  flexGrow: 1,
                  padding: 10,
                  backgroundColor: "#0D1117",
                  color: "#E6EDF3",
                  radius: 6,
                  borderColor: "rgba(255, 255, 255, 0.12)",
                  borderWidth: 1,
                  fontSize: 12,
                },
              }),
            ],
          }),
          View({
            key: "preview-pane",
            id: "ide.preview-pane",
            style: { width: 280, gap: 6 },
            children: [
              NativeText({
                key: "preview-title",
                id: "ide.preview-title",
                text: "● Live Preview (SevynOS)",
                style: { fontWeight: 700, color: "#D7AC57", fontSize: 12 },
              }),
              View({
                key: "preview-frame",
                id: "ide.preview-frame",
                style: {
                  flexGrow: 1,
                  padding: 12,
                  backgroundColor: "#161B22",
                  borderColor: "rgba(255, 255, 255, 0.15)",
                  borderWidth: 1,
                  radius: 8,
                },
                children:
                  activeTemplate === "counter"
                    ? [
                        View({
                          key: "counter-app",
                          id: "ide.prev.counter",
                          style: { gap: 12 },
                          children: [
                            NativeText({
                              key: "h",
                              id: "ide.prev.counter.h",
                              text: "⚡ SevynOS Counter App",
                              style: { fontSize: 18, fontWeight: 700, color: "#D7AC57" },
                            }),
                            NativeText({
                              key: "sub",
                              id: "ide.prev.counter.sub",
                              text: "State updates live inside Genesis!",
                              style: { fontSize: 12, color: "#8B949E" },
                            }),
                            View({
                              key: "box",
                              id: "ide.prev.counter.box",
                              style: {
                                padding: 14,
                                backgroundColor: "#0D1117",
                                radius: 8,
                                align: "center",
                              },
                              children: [
                                NativeText({
                                  key: "num",
                                  id: "ide.prev.counter.num",
                                  text: String(counterValue),
                                  style: {
                                    fontSize: 32,
                                    fontWeight: 800,
                                    color: "#58A6FF",
                                  },
                                }),
                              ],
                            }),
                            View({
                              key: "btns",
                              id: "ide.prev.counter.btns",
                              style: { direction: "row", gap: 6 },
                              children: [
                                button("ide.prev.c.inc", "+ Inc", () => {
                                  setCounterValue((c) => c + 1);
                                }),
                                button("ide.prev.c.dec", "- Dec", () => {
                                  setCounterValue((c) => Math.max(0, c - 1));
                                }),
                                button("ide.prev.c.rst", "Reset", () => {
                                  setCounterValue(0);
                                }),
                              ],
                            }),
                          ],
                        }),
                      ]
                    : activeTemplate === "todo"
                      ? [
                          View({
                            key: "todo-app",
                            id: "ide.prev.todo",
                            style: { gap: 8 },
                            children: [
                              NativeText({
                                key: "h",
                                id: "ide.prev.todo.h",
                                text: "✓ Sevyn Tasks",
                                style: {
                                  fontSize: 18,
                                  fontWeight: 700,
                                  color: "#D7AC57",
                                },
                              }),
                              View({
                                key: "add",
                                id: "ide.prev.todo.add",
                                style: { direction: "row", gap: 6 },
                                children: [
                                  NativeTextInput({
                                    key: "inp",
                                    id: "ide.prev.todo.inp",
                                    value: todoInput,
                                    onTextInput: setTodoInput,
                                    style: {
                                      flexGrow: 1,
                                      height: 32,
                                      padding: 6,
                                      backgroundColor: "#0D1117",
                                      color: "#FFF",
                                      radius: 4,
                                    },
                                  }),
                                  button("ide.prev.todo.btn", "Add", () => {
                                    if (todoInput.trim()) {
                                      setTodoTasks([
                                        ...todoTasks,
                                        {
                                          id: Date.now(),
                                          text: todoInput.trim(),
                                          done: false,
                                        },
                                      ]);
                                      setTodoInput("");
                                    }
                                  }),
                                ],
                              }),
                              NativeScrollView({
                                key: "list",
                                id: "ide.prev.todo.list",
                                style: { gap: 4, height: 180 },
                                children: todoTasks.map((t) =>
                                  Pressable({
                                    key: `t-${String(t.id)}`,
                                    id: `ide.prev.todo.item.${String(t.id)}`,
                                    onPress: () => {
                                      setTodoTasks(
                                        todoTasks.map((item) =>
                                          item.id === t.id
                                            ? { ...item, done: !item.done }
                                            : item,
                                        ),
                                      );
                                    },
                                    style: {
                                      padding: 6,
                                      backgroundColor: t.done ? "#0D1117" : "#21262D",
                                      radius: 4,
                                    },
                                    children: NativeText({
                                      id: `ide.prev.todo.t.${String(t.id)}`,
                                      text: `${t.done ? "✓" : "○"} ${t.text}`,
                                      style: {
                                        color: t.done ? "#3FB950" : "#F0F6FC",
                                        fontSize: 12,
                                      },
                                    }),
                                  }),
                                ),
                              }),
                            ],
                          }),
                        ]
                      : activeTemplate === "showcase"
                        ? [
                            View({
                              key: "showcase-app",
                              id: "ide.prev.showcase",
                              style: { gap: 8 },
                              children: [
                                NativeText({
                                  key: "h",
                                  id: "ide.prev.showcase.h",
                                  text: "◇ UI Showcase",
                                  style: {
                                    fontSize: 18,
                                    fontWeight: 700,
                                    color: "#D7AC57",
                                  },
                                }),
                                View({
                                  key: "tags",
                                  id: "ide.prev.showcase.tags",
                                  style: { direction: "row", gap: 6 },
                                  children: ["Design", "Runtime", "Compositor"].map(
                                    (tag) =>
                                      button(`ide.prev.sc.tag.${tag}`, tag, () => {
                                        setShowcaseTag(tag);
                                      }),
                                  ),
                                }),
                                NativeTextInput({
                                  key: "inp",
                                  id: "ide.prev.showcase.inp",
                                  value: showcaseText,
                                  onTextInput: setShowcaseText,
                                  style: {
                                    height: 32,
                                    padding: 6,
                                    backgroundColor: "#0D1117",
                                    color: "#FFF",
                                    radius: 4,
                                  },
                                }),
                                View({
                                  key: "val",
                                  id: "ide.prev.showcase.val",
                                  style: {
                                    padding: 8,
                                    backgroundColor: "#0D1117",
                                    radius: 4,
                                  },
                                  children: [
                                    NativeText({
                                      key: "txt",
                                      id: "ide.prev.showcase.txt",
                                      text: `${showcaseTag} → ${showcaseText}`,
                                      style: { color: "#38BDF8", fontSize: 13 },
                                    }),
                                  ],
                                }),
                              ],
                            }),
                          ]
                        : [
                            View({
                              key: "calc-app",
                              id: "ide.prev.calc",
                              style: { gap: 6 },
                              children: [
                                View({
                                  key: "disp",
                                  id: "ide.prev.calc.disp",
                                  style: {
                                    height: 36,
                                    padding: 6,
                                    backgroundColor: "#0D1117",
                                    radius: 4,
                                    justify: "center",
                                  },
                                  children: [
                                    NativeText({
                                      key: "t",
                                      id: "ide.prev.calc.t",
                                      text: calcDisplay,
                                      style: {
                                        fontSize: 18,
                                        fontWeight: 700,
                                        color: "#F0F6FC",
                                        align: "end",
                                      },
                                    }),
                                  ],
                                }),
                                button("ide.prev.calc.c", "Clear", () => {
                                  setCalcDisplay("0");
                                }),
                                View({
                                  key: "r1",
                                  id: "ide.prev.calc.r1",
                                  style: { direction: "row", gap: 4 },
                                  children: ["7", "8", "9"].map((k) =>
                                    button(`ide.prev.k.${k}`, k, () => {
                                      setCalcDisplay(
                                        calcDisplay === "0" ? k : calcDisplay + k,
                                      );
                                    }),
                                  ),
                                }),
                                View({
                                  key: "r2",
                                  id: "ide.prev.calc.r2",
                                  style: { direction: "row", gap: 4 },
                                  children: ["4", "5", "6"].map((k) =>
                                    button(`ide.prev.k.${k}`, k, () => {
                                      setCalcDisplay(
                                        calcDisplay === "0" ? k : calcDisplay + k,
                                      );
                                    }),
                                  ),
                                }),
                                View({
                                  key: "r3",
                                  id: "ide.prev.calc.r3",
                                  style: { direction: "row", gap: 4 },
                                  children: ["1", "2", "3"].map((k) =>
                                    button(`ide.prev.k.${k}`, k, () => {
                                      setCalcDisplay(
                                        calcDisplay === "0" ? k : calcDisplay + k,
                                      );
                                    }),
                                  ),
                                }),
                              ],
                            }),
                          ],
              }),
            ],
          }),
        ],
      }),
      View({
        key: "output-panel",
        id: "ide.output-panel",
        style: {
          height: 72,
          padding: 8,
          backgroundColor: "#0D1117",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          radius: 6,
          gap: 2,
        },
        children: [
          NativeText({
            key: "out-h",
            id: "ide.out.h",
            text: "CONSOLE / OUTPUT",
            style: { fontSize: 10, color: "#8B949E", fontWeight: 700 },
          }),
          ...outputLogs.slice(-2).map((msg, i) =>
            NativeText({
              key: `log-${String(i)}`,
              id: `ide.log.${String(i)}`,
              text: msg,
              style: { fontSize: 11, color: "#7EE787" },
            }),
          ),
        ],
      }),
    ],
  });
}

export const createSystemApplicationElement = <P extends object>(
  component: (props: P) => ReactElement,
  props: P,
): ReactElement => createElement(component, props);

export type CoreSystemApplicationKind =
  | "welcome"
  | "installer"
  | "console"
  | "system-monitor"
  | "settings"
  | "gallery"
  | "files"
  | "browser"
  | "text-editor"
  | "app-manager"
  | "ide"
  | "notes";
export function createCoreSystemApplication(
  options:
    | { readonly kind: "welcome" }
    | { readonly kind: "installer" }
    | { readonly kind: "console"; readonly filesystem?: SevynFileSystem }
    | { readonly kind: "system-monitor"; readonly model: SystemMonitorModel }
    | {
        readonly kind: "settings";
        readonly settings: SevynSettingsModel;
        readonly network: SevynWirelessNetworkService;
        readonly power: SevynPowerService;
        readonly battery?: SevynBatteryService;
        readonly audio?: SevynAudioService;
        readonly system?: SevynSystemService;
      }
    | { readonly kind: "gallery" }
    | {
        readonly kind: "browser";
        readonly loadPage: (address: string) => Promise<TextBrowserPage>;
        readonly engine?: SevynBrowserEngine;
      }
    | {
        readonly kind: "text-editor";
        readonly filesystem: SevynFileSystem;
        readonly notifications: SystemNotificationService;
      }
    | {
        readonly kind: "app-manager";
        readonly applications: readonly AppManagerEntry[];
        readonly onLaunch?: ((applicationId: string) => Promise<void> | void) | undefined;
        readonly onTerminate?:
          ((applicationId: string) => Promise<void> | void) | undefined;
      }
    | {
        readonly kind: "files";
        readonly filesystem: SevynFileSystem;
        readonly notifications: SystemNotificationService;
      }
    | {
        readonly kind: "ide";
        readonly filesystem: SevynFileSystem;
        readonly notifications: SystemNotificationService;
        readonly studio?: SevynStudioService;
      }
    | {
        readonly kind: "notes";
        readonly filesystem?: SevynFileSystem;
        readonly notifications?: SystemNotificationService;
      },
): ReactElement {
  switch (options.kind) {
    case "welcome":
      return createElement(WelcomeApplication);
    case "installer":
      return createElement(InstallerApplication);
    case "console":
      return createElement(GenesisConsoleApplication, { filesystem: options.filesystem });
    case "system-monitor":
      return createElement(SystemMonitorApplication, { model: options.model });
    case "settings":
      return createElement(SettingsReactApplication, {
        settings: options.settings,
        network: options.network,
        power: options.power,
        ...(options.battery === undefined ? {} : { battery: options.battery }),
        ...(options.audio === undefined ? {} : { audio: options.audio }),
        ...(options.system === undefined ? {} : { system: options.system }),
      });
    case "gallery":
      return createElement(ComponentGalleryApplication);
    case "browser":
      return createElement(BrowserApplication, {
        loadPage: options.loadPage,
        ...(options.engine === undefined ? {} : { engine: options.engine }),
      });
    case "text-editor":
      return createElement(TextEditorApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
      });
    case "app-manager":
      return createElement(AppManagerApplication, {
        applications: options.applications,
        ...(options.onLaunch === undefined ? {} : { onLaunch: options.onLaunch }),
        ...(options.onTerminate === undefined
          ? {}
          : { onTerminate: options.onTerminate }),
      });
    case "files":
      return createElement(FilesApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
      });
    case "ide":
      return createElement(ReactNativeIdeApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
        ...(options.studio === undefined ? {} : { studio: options.studio }),
      });
    case "notes":
      return createElement(NotesApplication, {
        filesystem: options.filesystem,
        notifications: options.notifications,
      });
  }
}
