import { useCallback, useState, type JSX } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SevynFileSystem,
  type SevynApplicationManifest,
} from "@sevynos/react-native";

export const terminalManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.terminal",
  name: "Terminal",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Terminal",
  developer: "SevynOS",
  icon: "icons/terminal.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["filesystem.read", "filesystem.write"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "multiple",
};

export interface TerminalLine {
  readonly id: string;
  readonly text: string;
  readonly type: "input" | "output" | "error" | "info" | "success";
}

export interface TerminalAppRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly system?: boolean | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly description?: string | undefined;
}

export const DEFAULT_TERMINAL_APPS: readonly TerminalAppRecord[] = [
  {
    id: "org.sevynos.shell",
    name: "Desktop Shell",
    version: "2.0.0",
    system: true,
    permissions: ["runtime:lifecycle", "runtime:windows", "system:power"],
    description: "Core SevynOS desktop workspace and window compositor",
  },
  {
    id: "org.sevynos.terminal",
    name: "Terminal",
    version: "1.0.0",
    system: true,
    permissions: ["filesystem.read", "filesystem.write"],
    description: "SevynOS system command console and recovery interface",
  },
  {
    id: "org.sevynos.browser",
    name: "Browser",
    version: "1.0.0",
    system: false,
    permissions: ["network:http", "storage:cookies"],
    description: "Genesis web browsing surface",
  },
  {
    id: "org.sevynos.files",
    name: "Files",
    version: "1.0.0",
    system: false,
    permissions: ["filesystem:user"],
    description: "File manager and media browser",
  },
  {
    id: "org.sevynos.notes",
    name: "Notes",
    version: "1.0.0",
    system: false,
    permissions: ["storage:local"],
    description: "Personal note taking application",
  },
  {
    id: "org.sevynos.text-editor",
    name: "Text Editor",
    version: "1.0.0",
    system: false,
    permissions: ["filesystem:user"],
    description: "Plain-text document editor",
  },
  {
    id: "org.sevynos.calculator",
    name: "Calculator",
    version: "1.0.0",
    system: false,
    permissions: [],
    description: "Standard calculator with keyboard input",
  },
  {
    id: "org.sevynos.settings",
    name: "Settings",
    version: "1.0.0",
    system: false,
    permissions: ["system:config", "hardware:query"],
    description: "System preferences and appearance settings",
  },
  {
    id: "org.sevynos.system-monitor",
    name: "System Monitor",
    version: "1.0.0",
    system: false,
    permissions: ["process:inspect", "hardware:query"],
    description: "Process inspection and resource monitor",
  },
  {
    id: "org.sevynos.welcome",
    name: "Welcome",
    version: "1.0.0",
    system: false,
    permissions: [],
    description: "SevynOS onboarding guide",
  },
  {
    id: "org.sevynos.camera",
    name: "Camera",
    version: "1.0.0",
    system: false,
    permissions: ["hardware:camera", "filesystem:user"],
    description: "Photo and video capture application",
  },
  {
    id: "org.sevynos.music",
    name: "Music",
    version: "1.0.0",
    system: false,
    permissions: ["hardware:media", "filesystem:user"],
    description: "Audio player and playlist manager",
  },
];

export const PRISTINE_PACKAGES: ReadonlyMap<string, TerminalAppRecord> = new Map(
  DEFAULT_TERMINAL_APPS.map((app) => [app.id, app]),
);

export const LINUX_ESCAPE_COMMANDS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "csh",
  "ksh",
  "tcsh",
  "dash",
  "sudo",
  "su",
  "doas",
  "systemctl",
  "journalctl",
  "chvt",
  "deallocvt",
  "openvt",
  "kbd_mode",
  "apt",
  "apt-get",
  "dpkg",
  "dnf",
  "yum",
  "pacman",
  "zypper",
  "apk",
  "emerge",
  "killall",
  "pkill",
  "kill",
  "passwd",
  "login",
  "reboot",
  "halt",
  "poweroff",
  "shutdown",
  "init",
  "telinit",
  "dmesg",
  "sysctl",
  "iptables",
  "nft",
  "strace",
  "gdb",
  "curl",
  "wget",
  "nc",
  "netcat",
  "socat",
]);

export interface TerminalApplicationProps {
  readonly filesystem?: SevynFileSystem | undefined;
  readonly installedApps?: readonly TerminalAppRecord[] | undefined;
  readonly onInstallApp?:
    ((bundleOrId: string) => Promise<string | TerminalAppRecord>) | undefined;
  readonly onUninstallApp?: ((appId: string) => Promise<void>) | undefined;
  readonly onRestoreApp?:
    ((appId: string) => Promise<string | TerminalAppRecord>) | undefined;
}

const INITIAL_BANNER: readonly TerminalLine[] = [
  { id: "line-1", text: "SevynOS Genesis Terminal v1.0.0", type: "info" },
  {
    id: "line-2",
    text: "Appliance mode active: raw Linux shell access is disabled.",
    type: "info",
  },
  {
    id: "line-3",
    text: "Type 'sevyn help' for OS management or 'help' for built-in utilities.",
    type: "info",
  },
  {
    id: "line-4",
    text: "--------------------------------------------------",
    type: "info",
  },
];

let lineSeq = 0;
function nextLineId(prefix: string): string {
  lineSeq += 1;
  return `${prefix}-${String(Date.now())}-${String(lineSeq)}`;
}

export function TerminalApplication({
  filesystem,
  installedApps: initialInstalledApps,
  onInstallApp,
  onUninstallApp,
  onRestoreApp,
}: TerminalApplicationProps): JSX.Element {
  const [lines, setLines] = useState<readonly TerminalLine[]>(INITIAL_BANNER);
  const [inputCommand, setInputCommand] = useState<string>("");
  const [currentDir, setCurrentDir] = useState<string>("/var/lib/sevynos");
  const [apps, setApps] = useState<readonly TerminalAppRecord[]>(
    initialInstalledApps ?? DEFAULT_TERMINAL_APPS,
  );
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const executeCommand = useCallback(
    async (cmdText: string) => {
      const trimmed = cmdText.trim();
      if (!trimmed) return;

      const inputLine: TerminalLine = {
        id: nextLineId("in"),
        text: `sevynos:${currentDir}$ ${trimmed}`,
        type: "input",
      };

      setHistory((prev) => [...prev, trimmed]);
      setHistoryIndex(-1);

      const parts = trimmed.split(/\s+/).filter(Boolean);
      const command = parts[0]?.toLowerCase() ?? "";
      const args = parts.slice(1);

      let outputLines: TerminalLine[] = [];

      // Check for blocked Linux / POSIX shell commands first
      if (LINUX_ESCAPE_COMMANDS.has(command)) {
        outputLines = [
          {
            id: nextLineId("err"),
            text:
              `Direct Linux/POSIX shell command '${command}' is blocked.\n` +
              `SevynOS is an appliance operating system: all operations must use SevynOS APIs and commands.\n` +
              `Type 'sevyn help' or 'help' for available management commands.`,
            type: "error",
          },
        ];
        setLines((prev) => [...prev, inputLine, ...outputLines]);
        setInputCommand("");
        return;
      }

      switch (command) {
        case "help":
          outputLines = [
            { id: nextLineId("out"), text: "SevynOS Terminal Commands:", type: "info" },
            {
              id: nextLineId("out"),
              text: "  sevyn <subcommand>  - SevynOS management CLI (install, uninstall, list, restore, doctor)",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  help                - Display this help message",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  clear               - Clear terminal screen",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  pwd                 - Print current directory",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  ls [path]           - List directory contents",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  cd <path>           - Change directory",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  cat <file>          - Display file contents",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  mkdir <path>        - Create directory",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  touch <file>        - Create empty file",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  rm <path>           - Remove file",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  uname -a            - System information",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  whoami              - Current user identity",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  date                - Current date and time",
              type: "output",
            },
            {
              id: nextLineId("out"),
              text: "  echo <text>         - Print text to console",
              type: "output",
            },
          ];
          break;

        case "clear":
          setLines([]);
          setInputCommand("");
          return;

        case "pwd":
          outputLines = [{ id: nextLineId("out"), text: currentDir, type: "output" }];
          break;

        case "whoami":
          outputLines = [
            { id: nextLineId("out"), text: "sevyn (uid=1000, gid=1000)", type: "output" },
          ];
          break;

        case "date":
          outputLines = [
            { id: nextLineId("out"), text: new Date().toString(), type: "output" },
          ];
          break;

        case "uname":
          outputLines = [
            {
              id: nextLineId("out"),
              text: "SevynOS 1.0.0-appliance x86_64 (Genesis Compositor & Secure Runtime)",
              type: "output",
            },
          ];
          break;

        case "echo":
          outputLines = [{ id: nextLineId("out"), text: args.join(" "), type: "output" }];
          break;

        // Sevyn CLI implementation
        case "sevyn":
        case "sevynos": {
          const subcmd = args[0]?.toLowerCase();
          const subargs = args.slice(1);

          if (!subcmd || subcmd === "help" || subcmd === "--help" || subcmd === "-h") {
            outputLines = [
              {
                id: nextLineId("out"),
                text: "SevynOS Management CLI (v1.0.0)",
                type: "info",
              },
              {
                id: nextLineId("out"),
                text: "Usage: sevyn <command> [args]",
                type: "output",
              },
              { id: nextLineId("out"), text: "", type: "output" },
              { id: nextLineId("out"), text: "Commands:", type: "output" },
              {
                id: nextLineId("out"),
                text: "  list, apps            List installed applications",
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: "  install <target>      Install application (.sevyn bundle or ID)",
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: "  uninstall <id>        Uninstall application (protected apps blocked)",
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: "  restore <id>          Restore stock application from pristine store",
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: "  info <id>             Show application metadata and permissions",
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: "  doctor                Run system diagnostics and verify security",
                type: "output",
              },
            ];
            break;
          }

          if (subcmd === "list" || subcmd === "apps") {
            outputLines = [
              {
                id: nextLineId("out"),
                text: `Installed Applications (${String(apps.length)}):`,
                type: "info",
              },
              ...apps.map((a) => {
                const badge = a.system ? "[PROTECTED CORE]" : "[deletable stock]";
                const perms =
                  a.permissions && a.permissions.length > 0
                    ? `(${a.permissions.join(", ")})`
                    : "(no permissions)";
                return {
                  id: nextLineId("out"),
                  text: `  • ${a.name} (${a.id} v${a.version}) ${badge} ${perms}`,
                  type: "output" as const,
                };
              }),
            ];
            break;
          }

          if (subcmd === "install") {
            const target = subargs[0];
            if (!target) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: "Usage: sevyn install <bundle-path-or-app-id>",
                  type: "error",
                },
              ];
              break;
            }

            // Check if already installed
            const existing = apps.find((a) => a.id === target);
            if (existing) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `Application '${existing.name}' (${existing.id}) is already installed.`,
                  type: "error",
                },
              ];
              break;
            }

            // Check pristine catalog first
            const pristine = PRISTINE_PACKAGES.get(target);
            if (pristine) {
              if (onInstallApp) {
                try {
                  await onInstallApp(target);
                } catch (e) {
                  outputLines = [
                    {
                      id: nextLineId("err"),
                      text: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
                      type: "error",
                    },
                  ];
                  break;
                }
              }
              setApps((prev) => [...prev, pristine]);
              outputLines = [
                {
                  id: nextLineId("out"),
                  text: `✓ Successfully installed ${pristine.name} (${pristine.id} v${pristine.version}) [protected: ${pristine.system ? "true" : "false"}]`,
                  type: "success",
                },
              ];
              break;
            }

            // External bundle install simulation
            const bundleName =
              target
                .split("/")
                .pop()
                ?.replace(/\.(sevyn|sevynapp)$/, "") ?? target;
            const newRecord: TerminalAppRecord = {
              id: target.includes(".") ? target : `org.sevynos.${target.toLowerCase()}`,
              name: bundleName.charAt(0).toUpperCase() + bundleName.slice(1),
              version: "1.0.0",
              system: false,
              permissions: ["filesystem:user"],
              description: `Sideloaded package from ${target}`,
            };

            if (onInstallApp) {
              try {
                await onInstallApp(target);
              } catch (e) {
                outputLines = [
                  {
                    id: nextLineId("err"),
                    text: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
                    type: "error",
                  },
                ];
                break;
              }
            }

            setApps((prev) => [...prev, newRecord]);
            outputLines = [
              {
                id: nextLineId("out"),
                text: `✓ Successfully installed ${newRecord.name} (${newRecord.id} v${newRecord.version}) [deletable]`,
                type: "success",
              },
            ];
            break;
          }

          if (subcmd === "uninstall") {
            const targetId = subargs[0];
            if (!targetId) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: "Usage: sevyn uninstall <app-id>",
                  type: "error",
                },
              ];
              break;
            }

            const targetApp = apps.find((a) => a.id === targetId);
            if (!targetApp) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `Application '${targetId}' is not installed.`,
                  type: "error",
                },
              ];
              break;
            }

            if (targetApp.system) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text:
                    `Cannot uninstall protected system application '${targetApp.name}' (${targetApp.id}).\n` +
                    `Core system applications are protected to preserve OS stability.`,
                  type: "error",
                },
              ];
              break;
            }

            if (onUninstallApp) {
              try {
                await onUninstallApp(targetId);
              } catch (e) {
                outputLines = [
                  {
                    id: nextLineId("err"),
                    text: `Uninstall failed: ${e instanceof Error ? e.message : String(e)}`,
                    type: "error",
                  },
                ];
                break;
              }
            }

            setApps((prev) => prev.filter((a) => a.id !== targetId));
            outputLines = [
              {
                id: nextLineId("out"),
                text: `✓ Successfully uninstalled ${targetApp.name} (${targetApp.id})`,
                type: "success",
              },
              {
                id: nextLineId("out"),
                text: `Note: Stock applications can be restored at any time with 'sevyn restore ${targetApp.id}'.`,
                type: "info",
              },
            ];
            break;
          }

          if (subcmd === "restore") {
            const targetId = subargs[0];
            if (!targetId) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: "Usage: sevyn restore <app-id>",
                  type: "error",
                },
              ];
              break;
            }

            const pristine = PRISTINE_PACKAGES.get(targetId);
            if (!pristine) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `Pristine package '${targetId}' not found in /usr/share/sevyn/pristine/.`,
                  type: "error",
                },
              ];
              break;
            }

            if (apps.some((a) => a.id === targetId)) {
              outputLines = [
                {
                  id: nextLineId("out"),
                  text: `Application '${pristine.name}' (${pristine.id}) is already active. Reinstalling pristine binary...`,
                  type: "info",
                },
              ];
            }

            if (onRestoreApp) {
              try {
                await onRestoreApp(targetId);
              } catch (e) {
                outputLines = [
                  {
                    id: nextLineId("err"),
                    text: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
                    type: "error",
                  },
                ];
                break;
              }
            }

            setApps((prev) => [...prev.filter((a) => a.id !== targetId), pristine]);
            outputLines = [
              ...outputLines,
              {
                id: nextLineId("out"),
                text: `✓ Successfully restored ${pristine.name} (${pristine.id} v${pristine.version}) from pristine storage.`,
                type: "success",
              },
            ];
            break;
          }

          if (subcmd === "info") {
            const targetId = subargs[0];
            if (!targetId) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: "Usage: sevyn info <app-id>",
                  type: "error",
                },
              ];
              break;
            }

            const app =
              apps.find((a) => a.id === targetId) ?? PRISTINE_PACKAGES.get(targetId);
            if (!app) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `Application '${targetId}' not found.`,
                  type: "error",
                },
              ];
              break;
            }

            outputLines = [
              { id: nextLineId("out"), text: `Application: ${app.name}`, type: "info" },
              {
                id: nextLineId("out"),
                text: `  ID:           ${app.id}`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: `  Version:      v${app.version}`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: `  Status:       ${apps.some((a) => a.id === app.id) ? "Installed" : "Pristine Only"}`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: `  Protection:   ${app.system ? "Protected Core System App" : "Deletable Stock App"}`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: `  Permissions:  ${app.permissions && app.permissions.length > 0 ? app.permissions.join(", ") : "none"}`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: `  Description:  ${app.description ?? "Standard SevynOS application"}`,
                type: "output",
              },
            ];
            break;
          }

          if (subcmd === "doctor") {
            outputLines = [
              {
                id: nextLineId("out"),
                text: "SevynOS System Doctor — Diagnostics",
                type: "info",
              },
              {
                id: nextLineId("out"),
                text: `  • Installed Applications: ${String(apps.length)} apps in catalog`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: `  • Protected System Apps: ${String(apps.filter((a) => a.system).length)} (shell, terminal)`,
                type: "output",
              },
              {
                id: nextLineId("out"),
                text: "  • Note: Full system diagnostics require the host installer service.",
                type: "output",
              },
            ];
            break;
          }

          outputLines = [
            {
              id: nextLineId("err"),
              text: `sevyn: unknown subcommand '${subcmd}'. Type 'sevyn help' for available commands.`,
              type: "error",
            },
          ];
          break;
        }

        // Direct aliases for convenience
        case "install":
        case "uninstall":
        case "restore":
        case "info":
        case "doctor":
        case "apps": {
          const mappedCmd = command === "apps" ? "list" : command;
          await executeCommand(`sevyn ${mappedCmd} ${args.join(" ")}`.trim());
          return;
        }

        // Filesystem commands
        case "ls": {
          const target = args[0]
            ? args[0].startsWith("/")
              ? args[0]
              : `${currentDir}/${args[0]}`
            : currentDir;
          if (filesystem) {
            try {
              const entries = await filesystem.list(target);
              const formatted = entries
                .map((e) =>
                  e.kind === "directory" ? `[DIR]  ${e.name}/` : `[FILE] ${e.name}`,
                )
                .join("\n");
              outputLines = [
                {
                  id: nextLineId("out"),
                  text: formatted || "(empty directory)",
                  type: "output",
                },
              ];
            } catch {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `ls: cannot access '${target}': No such file or directory`,
                  type: "error",
                },
              ];
            }
          } else {
            outputLines = [
              {
                id: nextLineId("out"),
                text: "[DIR]  documents/\n[DIR]  Downloads/\n[DIR]  desktop/\n[FILE] welcome.txt",
                type: "output",
              },
            ];
          }
          break;
        }

        case "cd": {
          const dest = args[0] ?? "/var/lib/sevynos";
          if (dest === "~") {
            setCurrentDir("/var/lib/sevynos");
          } else if (dest === "..") {
            const segs = currentDir.split("/").filter(Boolean);
            segs.pop();
            setCurrentDir("/" + segs.join("/") || "/");
          } else if (dest.startsWith("/")) {
            setCurrentDir(dest);
          } else {
            setCurrentDir(`${currentDir}/${dest}`.replace(/\/\//g, "/"));
          }
          break;
        }

        case "cat": {
          const target = args[0];
          if (!target) {
            outputLines = [
              { id: nextLineId("err"), text: "Usage: cat <file>", type: "error" },
            ];
            break;
          }
          const fullPath = target.startsWith("/") ? target : `${currentDir}/${target}`;
          if (filesystem) {
            try {
              const content = await filesystem.read(fullPath);
              outputLines = [{ id: nextLineId("out"), text: content, type: "output" }];
            } catch {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `cat: ${target}: No such file or directory`,
                  type: "error",
                },
              ];
            }
          } else {
            outputLines = [
              {
                id: nextLineId("out"),
                text: `[SevynOS File Content for ${target}]\nWelcome to SevynOS Appliance Environment.`,
                type: "output",
              },
            ];
          }
          break;
        }

        case "mkdir": {
          const target = args[0];
          if (!target) {
            outputLines = [
              { id: nextLineId("err"), text: "Usage: mkdir <path>", type: "error" },
            ];
            break;
          }
          const fullPath = target.startsWith("/") ? target : `${currentDir}/${target}`;
          if (filesystem) {
            try {
              await filesystem.createDirectory(fullPath);
              outputLines = [
                {
                  id: nextLineId("out"),
                  text: `Created directory: ${target}`,
                  type: "success",
                },
              ];
            } catch (e) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `mkdir: cannot create directory '${target}': ${e instanceof Error ? e.message : String(e)}`,
                  type: "error",
                },
              ];
            }
          } else {
            outputLines = [
              {
                id: nextLineId("out"),
                text: `Created directory: ${target}`,
                type: "success",
              },
            ];
          }
          break;
        }

        case "touch": {
          const target = args[0];
          if (!target) {
            outputLines = [
              { id: nextLineId("err"), text: "Usage: touch <file>", type: "error" },
            ];
            break;
          }
          const fullPath = target.startsWith("/") ? target : `${currentDir}/${target}`;
          if (filesystem) {
            try {
              await filesystem.write(fullPath, "");
              outputLines = [
                {
                  id: nextLineId("out"),
                  text: `Created empty file: ${target}`,
                  type: "success",
                },
              ];
            } catch (e) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `touch: cannot create '${target}': ${e instanceof Error ? e.message : String(e)}`,
                  type: "error",
                },
              ];
            }
          } else {
            outputLines = [
              {
                id: nextLineId("out"),
                text: `Created empty file: ${target}`,
                type: "success",
              },
            ];
          }
          break;
        }

        case "rm": {
          const target = args[0];
          if (!target) {
            outputLines = [
              { id: nextLineId("err"), text: "Usage: rm <file>", type: "error" },
            ];
            break;
          }
          const fullPath = target.startsWith("/") ? target : `${currentDir}/${target}`;
          if (filesystem) {
            try {
              if (filesystem.delete) {
                await filesystem.delete(fullPath);
              }
              outputLines = [
                { id: nextLineId("out"), text: `Removed: ${target}`, type: "success" },
              ];
            } catch (e) {
              outputLines = [
                {
                  id: nextLineId("err"),
                  text: `rm: cannot remove '${target}': ${e instanceof Error ? e.message : String(e)}`,
                  type: "error",
                },
              ];
            }
          } else {
            outputLines = [
              { id: nextLineId("out"), text: `Removed: ${target}`, type: "success" },
            ];
          }
          break;
        }

        default:
          outputLines = [
            {
              id: nextLineId("err"),
              text: `${command}: command not found. Type 'help' or 'sevyn help' for available commands.`,
              type: "error",
            },
          ];
          break;
      }

      setLines((prev) => [...prev, inputLine, ...outputLines]);
      setInputCommand("");
    },
    [currentDir, filesystem, apps, onInstallApp, onUninstallApp, onRestoreApp],
  );

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="Terminal"
      style={styles.container}
    >
      {/* Terminal Title Bar */}
      <View style={styles.header}>
        <View style={styles.headerDots}>
          <View style={styles.dotRed} />
          <View style={styles.dotYellow} />
          <View style={styles.dotGreen} />
        </View>
        <Text style={styles.headerTitle}>sevynos: {currentDir}</Text>
      </View>

      {/* Output Console Log */}
      <ScrollView style={styles.outputArea}>
        {lines.map((line) => {
          let lineStyle = styles.lineOutput;
          if (line.type === "input") lineStyle = styles.lineInput;
          else if (line.type === "error") lineStyle = styles.lineError;
          else if (line.type === "info") lineStyle = styles.lineInfo;
          else if (line.type === "success") lineStyle = styles.lineSuccess;

          return (
            <Text key={line.id} style={lineStyle}>
              {line.text}
            </Text>
          );
        })}
      </ScrollView>

      {/* Input Prompt Row */}
      <View style={styles.inputRow}>
        <Text style={styles.promptLabel}>sevynos:{currentDir}$ </Text>
        <TextInput
          onChangeText={setInputCommand}
          onSubmitEditing={() => void executeCommand(inputCommand)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              if (history.length > 0) {
                const nextIdx =
                  historyIndex === -1
                    ? history.length - 1
                    : Math.max(0, historyIndex - 1);
                setHistoryIndex(nextIdx);
                setInputCommand(history[nextIdx] ?? "");
              }
            } else if (e.key === "ArrowDown") {
              if (historyIndex !== -1) {
                const nextIdx = historyIndex + 1;
                if (nextIdx < history.length) {
                  setHistoryIndex(nextIdx);
                  setInputCommand(history[nextIdx] ?? "");
                } else {
                  setHistoryIndex(-1);
                  setInputCommand("");
                }
              }
            }
          }}
          placeholder=""
          style={styles.promptInput}
          value={inputCommand}
        />
      </View>
    </View>
  );
}

export default TerminalApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0C10",
  },
  header: {
    height: 32,
    backgroundColor: "#12151C",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  headerDots: {
    flexDirection: "row",
    gap: 6,
    marginRight: 12,
  },
  dotRed: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#EF4444",
  },
  dotYellow: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#F59E0B",
  },
  dotGreen: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#10B981",
  },
  headerTitle: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
  },
  outputArea: {
    flex: 1,
    padding: 12,
  },
  lineInput: {
    color: "#D7AC57",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  lineOutput: {
    color: "#E2E8F0",
    fontSize: 12,
    marginBottom: 4,
  },
  lineError: {
    color: "#EF4444",
    fontSize: 12,
    marginBottom: 4,
  },
  lineInfo: {
    color: "#38BDF8",
    fontSize: 12,
    marginBottom: 4,
  },
  lineSuccess: {
    color: "#10B981",
    fontSize: 12,
    marginBottom: 4,
    fontWeight: "600",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#12151C",
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  promptLabel: {
    color: "#10B981",
    fontSize: 12,
    fontWeight: "700",
  },
  promptInput: {
    flex: 1,
    color: "#F3F4F6",
    fontSize: 12,
    height: 28,
  },
});
