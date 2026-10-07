import type { AudioInputDevice, AudioPlaybackStream } from "./linux-audio-service.js";

interface ParsedWpctlNode {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/**
 * Parses the "Sources:" section of `wpctl status` output:
 *   │  *   44. Built-in Audio Analog Stereo                  [vol: 1.00]
 *   │      45. Monitor of Built-in Audio Analog Stereo        [vol: 1.00]
 * The `*` marker denotes the default source.
 */
export function parseWpctlSources(status: string): readonly ParsedWpctlNode[] {
  return parseWpctlSection(status, "Sources:");
}

/**
 * Parses the "Streams:" section of `wpctl status` output. Link detail lines
 * (containing `>`) are skipped — only the top-level stream rows carry the
 * application name.
 */
export function parseWpctlStreams(status: string): readonly ParsedWpctlNode[] {
  return parseWpctlSection(status, "Streams:", true);
}

function parseWpctlSection(
  status: string,
  section: string,
  skipLinks = false,
): readonly ParsedWpctlNode[] {
  const nodes: ParsedWpctlNode[] = [];
  const lines = status.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.includes(section)) inSection = true;
      continue;
    }
    // A new section header ends this one (e.g. " ├─ Sinks:", " └─ Streams:").
    if (/[├└]─\s*\S/.test(line)) break;
    if (skipLinks && line.includes(">")) continue;
    // Tree-drawing prefixes vary: rows under a "├─" section carry "│",
    // rows under the final "└─" section are plain indented.
    const match = /^\s*(?:[│|]\s*)?(\*?)\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (match?.[2] !== undefined && match[3] !== undefined) {
      const rawName = match[3]
        .trim()
        .replace(/\s*\[.*\]$/, "")
        .trim();
      if (rawName.length > 0) {
        nodes.push({ id: match[2], name: rawName, isDefault: match[1] === "*" });
      }
    }
  }
  return nodes;
}

/**
 * Parses `pactl list sources short` — one tab/space separated row per source,
 * the source name in the second column.
 */
export function parsePactlSourcesShort(output: string): readonly string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    const name = columns[1];
    if (columns[0] !== undefined && name !== undefined && /^\d+$/.test(columns[0])) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Parses `arecord -l` capture device listings:
 *   card 0: PCH [HDA Intel PCH], device 0: ALC269 Analog [ALC269 Analog]
 */
export function parseArecordList(
  output: string,
): readonly Pick<AudioInputDevice, "id" | "name">[] {
  const devices: Pick<AudioInputDevice, "id" | "name">[] = [];
  const pattern = /^card\s+(\d+):\s*[^[]*?\[(.+?)\],\s*device\s+(\d+):\s*[^[]*?\[(.+?)\]/;
  for (const line of output.split("\n")) {
    const match = pattern.exec(line.trim());
    if (match?.[1] !== undefined && match[3] !== undefined) {
      const cardName = (match[2] ?? "").trim();
      const deviceName = (match[4] ?? "").trim();
      devices.push({
        id: `hw:${match[1]},${match[3]}`,
        name: `${cardName} — ${deviceName}`,
      });
    }
  }
  return devices;
}

/**
 * Returns the `amixer -c <card>` prefix for an ALSA device id (`hw:<card>,<device>`),
 * or an empty array for the default card / unknown ids.
 */
export function alsaCardArgs(deviceId: string | undefined): readonly string[] {
  const match = /^hw:(\d+),/.exec(deviceId ?? "");
  if (match?.[1] !== undefined && match[1] !== "0") return ["-c", match[1]];
  return [];
}

/**
 * Parses `pactl list sink-inputs` into per-application stream rows. Each
 * block starts with "Sink Input #<index>" and carries Mute/Volume lines plus
 * an application.name property.
 */
export function parsePactlSinkInputs(output: string): readonly AudioPlaybackStream[] {
  const streams: AudioPlaybackStream[] = [];
  const blocks = output.split(/(?=^Sink Input #)/m);
  for (const block of blocks) {
    const indexMatch = /^Sink Input #(\d+)/m.exec(block);
    if (indexMatch?.[1] === undefined) continue;
    const muteMatch = /^\s*Mute:\s*(yes|no)/im.exec(block);
    const volumeMatch = /^\s*Volume:.*?\/\s*(\d+)%/ims.exec(block);
    const appMatch = /application\.name\s*=\s*"([^"]*)"/.exec(block);
    const mediaMatch = /media\.name\s*=\s*"([^"]*)"/.exec(block);
    const applicationName = (appMatch?.[1] ?? "").trim();
    const mediaName = (mediaMatch?.[1] ?? "").trim();
    const volume = volumeMatch?.[1] !== undefined ? parseInt(volumeMatch[1], 10) : 0;
    streams.push(
      Object.freeze({
        id: indexMatch[1],
        name: mediaName || applicationName || `Stream ${indexMatch[1]}`,
        applicationName: applicationName || mediaName || `Stream ${indexMatch[1]}`,
        volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 0,
        muted: muteMatch?.[1] !== undefined ? /yes/i.test(muteMatch[1]) : false,
      }),
    );
  }
  return streams;
}
