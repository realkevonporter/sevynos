/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * LinuxDisplayService — real display enumeration and mode management for the
 * Weston compositor (the SevynOS compositor; drm-backend / kiosk-shell).
 *
 * - Enumeration reads the kernel's DRM sysfs directly
 *   (/sys/class/drm/card*-*): connector status and the real mode list. No
 *   fake modes are ever synthesized.
 * - Refresh rates come from the connector's EDID (parsed locally); when no
 *   EDID is present (e.g. virtual GPU) only resolutions are offered.
 * - Weston has no runtime mode-set protocol, so applying a mode/rotation
 *   rewrites the [output] section of weston.ini and persists the choice; the
 *   compositor picks it up on the next restart (the Settings UI says so).
 * - There is no gamma/color-temperature control on this stack (weston holds
 *   the DRM master and exposes no gamma API), so night light reports
 *   available:false instead of a fake slider.
 *
 * Sysfs root, weston.ini path, and state directory are injected for tests.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DisplayMode {
  readonly width: number;
  readonly height: number;
  /** Refresh rate in Hz; undefined when the connector exposes no EDID. */
  readonly refreshHz: number | undefined;
}

export interface DisplayOutput {
  readonly id: string;
  readonly connected: boolean;
  readonly modes: readonly DisplayMode[];
  /** Mode weston will use (from weston.ini), if one is pinned. */
  readonly configuredMode: DisplayMode | undefined;
  /** Physical size in millimetres from EDID, when available. */
  readonly physicalMm: { readonly width: number; readonly height: number } | undefined;
}

export interface DisplayModeChange {
  /** Weston only reads its config at startup, so a restart is required. */
  readonly restartRequired: true;
  readonly outputId: string;
  readonly mode: DisplayMode;
}

export interface NightLightState {
  readonly available: false;
  readonly reason: string;
}

const DEFAULT_WESTON_INI = "/etc/xdg/weston/weston.ini";

function defaultStateDirectory(): string {
  return process.env["SEVYN_STATE_DIRECTORY"] ?? "/var/lib/sevynos";
}

function parseModeLine(line: string): DisplayMode | undefined {
  const match = /^(\d+)x(\d+)$/.exec(line.trim());
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined;
  if (width < 320 || height < 200 || width > 16384 || height > 16384) return undefined;
  return { width, height, refreshHz: undefined };
}

/**
 * Parse refresh rates (Hz) for width×height from a raw EDID blob using the
 * detailed timing descriptors (18 bytes each at offset 54, four of them).
 * Returns a map keyed by "WxH". Returns an empty map when the EDID is
 * missing or malformed — never throws for bad input.
 */
export function parseEdidRefreshRates(edid: Buffer): ReadonlyMap<string, number> {
  const rates = new Map<string, number>();
  try {
    if (edid.length < 128) return rates;
    if (edid[0] !== 0x00 || edid[7] !== 0x00) return rates;
    for (let block = 0; block < 4; block++) {
      const base = 54 + block * 18;
      if (base + 18 > edid.length) break;
      const pixelClock = edid.readUInt16LE(base); // 10 kHz units
      if (pixelClock === 0) continue; // Not a detailed timing descriptor.
      const b2 = edid[base + 2] ?? 0;
      const b3 = edid[base + 3] ?? 0;
      const b4 = edid[base + 4] ?? 0;
      const b5 = edid[base + 5] ?? 0;
      const b6 = edid[base + 6] ?? 0;
      const b7 = edid[base + 7] ?? 0;
      const hActive = b2 | ((b4 & 0xf0) << 4);
      const hBlank = b3 | ((b4 & 0x0f) << 8);
      const vActive = b5 | ((b7 & 0xf0) << 4);
      const vBlank = b6 | ((b7 & 0x0f) << 8);
      const hTotal = hActive + hBlank;
      const vTotal = vActive + vBlank;
      if (hTotal <= 0 || vTotal <= 0 || hActive <= 0 || vActive <= 0) continue;
      const refreshHz = (pixelClock * 10_000) / (hTotal * vTotal);
      if (!Number.isFinite(refreshHz) || refreshHz < 20 || refreshHz > 480) continue;
      const key = `${String(hActive)}x${String(vActive)}`;
      const rounded = Math.round(refreshHz * 100) / 100;
      const existing = rates.get(key);
      if (existing === undefined || rounded > existing) rates.set(key, rounded);
    }
  } catch {
    // Malformed EDID: no refresh rates.
  }
  return rates;
}

interface IniSection {
  readonly name: string;
  lines: string[];
}

/** Parse an INI file into ordered sections, preserving comments/blank lines. */
function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | undefined;
  for (const rawLine of text.split("\n")) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(rawLine);
    if (header?.[1] !== undefined) {
      current = { name: header[1], lines: [] };
      sections.push(current);
    } else if (current !== undefined) {
      current.lines.push(rawLine);
    } else if (rawLine.trim() !== "") {
      // Stray content before the first section: keep it in a pseudo-section.
      current = { name: "", lines: [rawLine] };
      sections.push(current);
    }
  }
  return sections;
}

function renderIni(sections: readonly IniSection[]): string {
  return sections
    .map((section) =>
      section.name === ""
        ? section.lines.join("\n")
        : `[${section.name}]\n${section.lines.join("\n")}`,
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

function sectionValue(section: IniSection, key: string): string | undefined {
  for (const line of section.lines) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function setSectionValue(section: IniSection, key: string, value: string): void {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const index = section.lines.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    const updated = [...section.lines];
    updated[index] = `${key}=${value}`;
    section.lines = updated;
    return;
  }
  const lines = section.lines;
  const isBlank = (line: string | undefined): boolean => line?.trim() === "";
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end -= 1;
  section.lines = [...lines.slice(0, end), `${key}=${value}`];
}

export class LinuxDisplayService {
  readonly #drmRoot: string;
  readonly #westonIniPath: string;
  readonly #stateDirectory: string;

  public constructor(
    drmRoot = "/sys/class/drm",
    westonIniPath = DEFAULT_WESTON_INI,
    stateDirectory = defaultStateDirectory(),
  ) {
    this.#drmRoot = drmRoot;
    this.#westonIniPath = westonIniPath;
    this.#stateDirectory = stateDirectory;
  }

  /** Real outputs from DRM sysfs. Never synthesizes modes. */
  public async getOutputs(): Promise<readonly DisplayOutput[]> {
    const entries = await readdir(this.#drmRoot).catch(() => []);
    const outputs: DisplayOutput[] = [];
    for (const entry of entries.sort()) {
      if (!/^card\d+-/.test(entry)) continue;
      const dir = join(this.#drmRoot, entry);
      const status = (await readFile(join(dir, "status"), "utf8").catch(() => ""))
        .trim()
        .toLowerCase();
      const connected = status === "connected";
      const modes = await this.#readModes(dir);
      const configuredMode = await this.#readConfiguredMode(entry, modes);
      outputs.push({
        id: entry,
        connected,
        modes,
        configuredMode,
        physicalMm: await this.#readPhysicalSize(dir),
      });
    }
    return outputs;
  }

  /**
   * Pin a mode for an output in weston.ini. Weston has no runtime mode-set
   * protocol, so the mode applies on the next compositor restart.
   */
  public async setMode(
    outputId: string,
    mode: { width: number; height: number; refreshHz?: number },
  ): Promise<DisplayModeChange> {
    const outputs = await this.getOutputs();
    const output = outputs.find((o) => o.id === outputId);
    if (output === undefined) throw new Error(`Unknown display output: ${outputId}`);
    if (!output.connected)
      throw new Error(`Display output ${outputId} is not connected.`);
    const match = output.modes.find(
      (m) =>
        m.width === mode.width &&
        m.height === mode.height &&
        (mode.refreshHz === undefined ||
          m.refreshHz === undefined ||
          Math.abs(m.refreshHz - mode.refreshHz) < 0.51),
    );
    if (match === undefined) {
      throw new Error(
        `Mode ${String(mode.width)}x${String(mode.height)} is not offered by ${outputId}.`,
      );
    }
    const resolved: DisplayMode = {
      width: match.width,
      height: match.height,
      refreshHz: mode.refreshHz ?? match.refreshHz,
    };
    await this.#writeOutputConfig(outputId, {
      mode: westonModeString(resolved),
    });
    await this.#persistChoice(outputId, { mode: resolved });
    return { restartRequired: true, outputId, mode: resolved };
  }

  /**
   * Rotate an output via weston's transform. Applies on next restart.
   * degrees must be one of 0, 90, 180, 270.
   */
  public async setRotation(
    outputId: string,
    degrees: 0 | 90 | 180 | 270,
  ): Promise<DisplayModeChange & { readonly rotation: number }> {
    const outputs = await this.getOutputs();
    const output = outputs.find((o) => o.id === outputId);
    if (output === undefined) throw new Error(`Unknown display output: ${outputId}`);
    const transform =
      degrees === 0 ? "normal" : degrees === 90 ? "90" : degrees === 180 ? "180" : "270";
    await this.#writeOutputConfig(outputId, { transform });
    const persisted = await this.#readPersisted(outputId);
    await this.#persistChoice(outputId, { ...persisted, rotation: degrees });
    const mode = output.configuredMode ??
      output.modes[0] ?? { width: 0, height: 0, refreshHz: undefined };
    return { restartRequired: true, outputId, mode, rotation: degrees };
  }

  public async getRotation(outputId: string): Promise<0 | 90 | 180 | 270> {
    const persisted = await this.#readPersisted(outputId);
    const rotation = persisted?.["rotation"];
    return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
  }

  /** Night light has no real mechanism on the weston stack: report honestly. */
  public getNightLight(): NightLightState {
    return {
      available: false,
      reason:
        "Night light is not available: weston (the SevynOS compositor) holds the " +
        "DRM master and exposes no gamma / color-temperature control.",
    };
  }

  async #readModes(dir: string): Promise<DisplayMode[]> {
    const text = await readFile(join(dir, "modes"), "utf8").catch(() => "");
    const modes = new Map<string, DisplayMode>();
    for (const line of text.split("\n")) {
      const mode = parseModeLine(line);
      if (mode !== undefined)
        modes.set(`${String(mode.width)}x${String(mode.height)}`, mode);
    }
    // Attach refresh rates from EDID when present.
    const edid = await readFile(join(dir, "edid"), null).catch(() => null);
    if (edid !== null) {
      const rates = parseEdidRefreshRates(edid);
      for (const [key, mode] of modes) {
        const hz = rates.get(key);
        if (hz !== undefined) modes.set(key, { ...mode, refreshHz: hz });
      }
    }
    return [...modes.values()];
  }

  async #readPhysicalSize(
    dir: string,
  ): Promise<{ width: number; height: number } | undefined> {
    const edid = await readFile(join(dir, "edid"), null).catch(() => null);
    if (edid === null || edid.length < 128) return undefined;
    const widthMm = edid[21];
    const heightMm = edid[22];
    if (
      widthMm === undefined ||
      heightMm === undefined ||
      widthMm === 0 ||
      heightMm === 0
    ) {
      return undefined;
    }
    return { width: widthMm * 10, height: heightMm * 10 };
  }

  async #readConfiguredMode(
    outputId: string,
    modes: readonly DisplayMode[],
  ): Promise<DisplayMode | undefined> {
    const text = await readFile(this.#westonIniPath, "utf8").catch(() => "");
    if (text === "") return undefined;
    for (const section of parseIni(text)) {
      if (section.name !== "output") continue;
      if (sectionValue(section, "name") !== outputId) continue;
      const raw = sectionValue(section, "mode");
      if (raw === undefined) return undefined;
      const match = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(raw);
      if (match === null) return undefined;
      const width = Number(match[1]);
      const height = Number(match[2]);
      const refreshHz = match[3] === undefined ? undefined : Number(match[3]);
      const known = modes.find((m) => m.width === width && m.height === height);
      return {
        width,
        height,
        refreshHz: refreshHz ?? known?.refreshHz,
      };
    }
    return undefined;
  }

  async #writeOutputConfig(
    outputId: string,
    values: { mode?: string; transform?: string },
  ): Promise<void> {
    const text = await readFile(this.#westonIniPath, "utf8").catch(() => "");
    const sections = parseIni(text);
    let target = sections.find(
      (s) => s.name === "output" && sectionValue(s, "name") === outputId,
    );
    if (target === undefined) {
      target = { name: "output", lines: [`name=${outputId}`] };
      sections.push(target);
    }
    if (values.mode !== undefined) setSectionValue(target, "mode", values.mode);
    if (values.transform !== undefined)
      setSectionValue(target, "transform", values.transform);
    await writeFile(this.#westonIniPath, renderIni(sections), "utf8");
  }

  async #persistChoice(outputId: string, choice: Record<string, unknown>): Promise<void> {
    const path = join(this.#stateDirectory, "display.json");
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const previous: Record<string, unknown> = {};
    const stored = current[outputId];
    if (typeof stored === "object" && stored !== null) {
      Object.assign(previous, stored);
    }
    current[outputId] = { ...previous, ...choice };
    await mkdir(this.#stateDirectory, { recursive: true });
    await writeFile(path, JSON.stringify(current, null, 2), "utf8");
  }

  async #readPersisted(outputId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const current = JSON.parse(
        await readFile(join(this.#stateDirectory, "display.json"), "utf8"),
      ) as Record<string, unknown>;
      const entry = current[outputId];
      return typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function westonModeString(mode: DisplayMode): string {
  const base = `${String(mode.width)}x${String(mode.height)}`;
  return mode.refreshHz === undefined
    ? base
    : `${base}@${String(Math.round(mode.refreshHz))}`;
}
