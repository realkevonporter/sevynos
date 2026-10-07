import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxAudioService } from "./linux-audio-service.js";

describe("LinuxAudioService", () => {
  let tempDir: string;
  let cardsPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-audio-test-"));
    cardsPath = join(tempDir, "cards");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("queries ALSA card name, volume, and mute status", async () => {
    await writeFile(cardsPath, " 0 [PCH            ]: HDA-Intel - HDA Intel PCH\n");

    const executedCommands: { command: string; args: readonly string[] }[] = [];
    const service = new LinuxAudioService({
      cardsPath,
      runCommand: (command, args) => {
        executedCommands.push({ command, args });
        if (args[0] === "get" && args[1] === "Master") {
          return Promise.resolve(
            "Simple mixer control 'Master',0\n  Limits: 0 - 65536\n  Front Left: Playback 42598 [65%] [on]\n",
          );
        }
        if (args[0] === "cget" && args[1] === "name=Headphone Jack") {
          return Promise.resolve("numid=1,type=BOOLEAN\n : values=on\n");
        }
        return Promise.resolve("");
      },
    });

    const snapshot = await service.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.outputDevice).toBe("HDA-Intel - HDA Intel PCH");
    expect(snapshot.volume).toBe(65);
    expect(snapshot.muted).toBe(false);
    expect(snapshot.hasHeadphones).toBe(true);
    service.close();
  });

  it("issues amixer commands on setVolume and setMuted", async () => {
    let muteState = false;
    const executedCommands: { command: string; args: readonly string[] }[] = [];
    const service = new LinuxAudioService({
      cardsPath: join(tempDir, "nonexistent"),
      runCommand: (command, args) => {
        executedCommands.push({ command, args });
        if (args[0] === "set" && args[2] === "mute") {
          muteState = true;
          return Promise.resolve(`Playback [85%] [off]`);
        }
        if (args[0] === "set" && args[2] === "unmute") {
          muteState = false;
          return Promise.resolve(`Playback [85%] [on]`);
        }
        return Promise.resolve(`Playback [85%] [${muteState ? "off" : "on"}]`);
      },
    });

    await service.setVolume(85);
    expect(executedCommands).toContainEqual({
      command: "amixer",
      args: ["set", "Master", "85%"],
    });

    await service.setMuted(true);
    expect(executedCommands).toContainEqual({
      command: "amixer",
      args: ["set", "Master", "mute"],
    });
    service.close();
  });
  it("reports unavailable on absent mixers and refuses fake changes", async () => {
    const service = new LinuxAudioService({
      cardsPath,
      runCommand: () => Promise.reject(new Error("No mixer")),
    });
    expect(await service.snapshot()).toMatchObject({
      available: false,
      volume: 0,
      hasHeadphones: false,
    });
    await expect(service.setVolume(60)).rejects.toThrow("No supported audio output");
    await expect(service.setMuted(true)).rejects.toThrow();
    await expect(service.setVolume(NaN)).rejects.toThrow("finite");
    service.close();
  });

  it("retains actual mixer state after failed changes and detects disappearance", async () => {
    let present = true;
    const service = new LinuxAudioService({
      cardsPath,
      runCommand: (_command, args) => {
        if (!present || args[0] === "set")
          return Promise.reject(new Error("Unavailable"));
        return Promise.resolve(args[0] === "get" ? "Playback [42%] [off]" : "values=off");
      },
    });
    await expect(service.setVolume(90)).rejects.toThrow();
    expect(await service.snapshot()).toMatchObject({
      available: true,
      volume: 42,
      muted: true,
      hasHeadphones: false,
    });
    present = false;
    expect((await service.snapshot()).available).toBe(false);
    service.close();
  });

  it("prioritizes PipeWire (wpctl) over ALSA when available", async () => {
    let currentVol = 0.72;
    let currentMuted = true;
    const executedCommands: { command: string; args: readonly string[] }[] = [];
    const service = new LinuxAudioService({
      cardsPath,
      runCommand: (command, args) => {
        executedCommands.push({ command, args });
        if (command === "wpctl" && args[0] === "get-volume") {
          return Promise.resolve(
            `Volume: ${currentVol.toFixed(2)}${currentMuted ? " [MUTED]" : ""}`,
          );
        }
        if (command === "wpctl" && args[0] === "set-volume") {
          currentVol = parseFloat(args[2] ?? "0");
          return Promise.resolve("");
        }
        if (command === "wpctl" && args[0] === "set-mute") {
          currentMuted = args[2] === "1";
          return Promise.resolve("");
        }
        return Promise.reject(new Error("Unknown command"));
      },
    });

    const snapshot = await service.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.outputDevice).toBe("PipeWire Default Output");
    expect(snapshot.volume).toBe(72);
    expect(snapshot.muted).toBe(true);

    await service.setVolume(80);
    expect(executedCommands).toContainEqual({
      command: "wpctl",
      args: ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.80"],
    });

    await service.setMuted(false);
    expect(executedCommands).toContainEqual({
      command: "wpctl",
      args: ["set-mute", "@DEFAULT_AUDIO_SINK@", "0"],
    });
    service.close();
  });

  it("falls back to PulseAudio (pactl) when wpctl is unavailable", async () => {
    let currentVol = 50;
    let currentMuted = false;
    const executedCommands: { command: string; args: readonly string[] }[] = [];
    const service = new LinuxAudioService({
      cardsPath,
      runCommand: (command, args) => {
        executedCommands.push({ command, args });
        if (command === "wpctl") return Promise.reject(new Error("wpctl not found"));
        if (command === "pactl" && args[0] === "get-sink-volume") {
          return Promise.resolve(
            `Volume: front-left: 32768 /  ${String(currentVol)}% / -18.06 dB`,
          );
        }
        if (command === "pactl" && args[0] === "get-sink-mute") {
          return Promise.resolve(currentMuted ? "Mute: yes" : "Mute: no");
        }
        if (command === "pactl" && args[0] === "set-sink-volume") {
          currentVol = parseInt(args[2]?.replace("%", "") ?? "0", 10);
          return Promise.resolve("");
        }
        if (command === "pactl" && args[0] === "set-sink-mute") {
          currentMuted = args[2] === "1";
          return Promise.resolve("");
        }
        return Promise.reject(new Error("Unknown"));
      },
    });

    const snapshot = await service.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.outputDevice).toBe("PulseAudio Default Output");
    expect(snapshot.volume).toBe(50);
    expect(snapshot.muted).toBe(false);

    await service.setVolume(60);
    expect(executedCommands).toContainEqual({
      command: "pactl",
      args: ["set-sink-volume", "@DEFAULT_SINK@", "60%"],
    });
    service.close();
  });

  it("retains last-known volume across failed queries", async () => {
    let queryFails = false;
    const service = new LinuxAudioService({
      cardsPath,
      runCommand: (command, args) => {
        if (command === "wpctl" && args[0] === "get-volume") {
          if (queryFails) return Promise.reject(new Error("Temporary failure"));
          return Promise.resolve("Volume: 0.65");
        }
        return Promise.reject(new Error("Unavailable"));
      },
    });

    const initial = await service.snapshot();
    expect(initial.volume).toBe(65);
    expect(initial.available).toBe(true);

    queryFails = true;
    const failedSnapshot = await service.snapshot();
    expect(failedSnapshot.available).toBe(false);
    expect(failedSnapshot.volume).toBe(65); // Retained, not reset to 0!
    service.close();
  });
});

describe("LinuxAudioService microphone input", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-audio-input-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const WPCTL_STATUS = [
    "PipeWire 'pipewire-0' [1.2.7, root@sevynos, cookie:1234]",
    " └─ Clients:",
    "        31. pipewire                            [1.2.7, root@sevynos, pid:100]",
    "Audio",
    " ├─ Devices:",
    " │      42. Built-in Audio Analog Stereo        [alsa]",
    " ├─ Sinks:",
    " │  *   43. Built-in Audio Analog Stereo        [vol: 0.72]",
    " ├─ Sources:",
    " │  *   44. Built-in Audio Analog Stereo        [vol: 0.80]",
    " │      45. Monitor of Built-in Audio Analog Stereo [vol: 1.00]",
    " └─ Streams:",
    "        56. Chromium",
    "             57. output_FL > Built-in Audio Analog Stereo:playback_FL\t[active]",
    "",
  ].join("\n");

  function pipewireRunCommand(state: {
    volumes: Record<string, number>;
    mutes: Record<string, boolean>;
  }) {
    return (command: string, args: readonly string[]): Promise<string> => {
      if (command === "wpctl" && args[0] === "status")
        return Promise.resolve(WPCTL_STATUS);
      if (command === "wpctl" && args[0] === "get-volume") {
        const id = args[1] ?? "@DEFAULT_AUDIO_SOURCE@";
        const volume =
          state.volumes[id] ?? state.volumes["@DEFAULT_AUDIO_SOURCE@"] ?? 0.8;
        const muted = state.mutes[id] ?? false;
        return Promise.resolve(`Volume: ${volume.toFixed(2)}${muted ? " [MUTED]" : ""}`);
      }
      if (command === "wpctl" && args[0] === "set-volume") {
        state.volumes[args[1] ?? ""] = parseFloat(args[2] ?? "0");
        return Promise.resolve("");
      }
      if (command === "wpctl" && args[0] === "set-mute") {
        state.mutes[args[1] ?? ""] = args[2] === "1";
        return Promise.resolve("");
      }
      return Promise.reject(new Error("Unknown command"));
    };
  }

  it("enumerates PipeWire input sources with the default marked", async () => {
    const service = new LinuxAudioService({
      runCommand: pipewireRunCommand({ volumes: { "44": 0.8, "45": 1 }, mutes: {} }),
    });
    const snapshot = await service.inputSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.devices[0]).toMatchObject({
      id: "44",
      name: "Built-in Audio Analog Stereo",
      isDefault: true,
      volume: 80,
      muted: false,
    });
    expect(snapshot.devices[1]).toMatchObject({
      id: "45",
      isDefault: false,
      volume: 100,
    });
    expect(snapshot.defaultDeviceId).toBe("44");
    expect(snapshot.volume).toBe(80);
    service.close();
  });

  it("sets PipeWire input volume and mute with verify-after-write", async () => {
    const state = {
      volumes: { "44": 0.8 } as Record<string, number>,
      mutes: {} as Record<string, boolean>,
    };
    const executed: string[][] = [];
    const service = new LinuxAudioService({
      runCommand: (command, args) => {
        executed.push([command, ...args]);
        // The default-source alias addresses node 44 on this mock system.
        const aliased = args.map((a) => (a === "@DEFAULT_AUDIO_SOURCE@" ? "44" : a));
        return pipewireRunCommand(state)(command, aliased);
      },
    });
    const afterVolume = await service.setInputVolume(60);
    expect(executed).toContainEqual([
      "wpctl",
      "set-volume",
      "@DEFAULT_AUDIO_SOURCE@",
      "0.60",
    ]);
    expect(afterVolume.volume).toBe(60);

    const afterMute = await service.setInputMuted(true);
    expect(executed).toContainEqual(["wpctl", "set-mute", "@DEFAULT_AUDIO_SOURCE@", "1"]);
    // Mute state is reported per device; the mock reports the default target.
    expect(afterMute.devices[0]?.muted).toBe(true);

    await service.setInputVolume(42, "45");
    expect(executed).toContainEqual(["wpctl", "set-volume", "45", "0.42"]);
    service.close();
  });

  it("selects the default PipeWire input device", async () => {
    let defaultId = "44";
    const volumes: Record<string, number> = { "44": 0.8, "45": 1 };
    const statusFor = (): string =>
      [
        "Audio",
        " ├─ Sources:",
        ` │  ${defaultId === "44" ? "*" : " "}   44. Built-in Audio Analog Stereo        [vol: 0.80]`,
        ` │  ${defaultId === "45" ? "*" : " "}   45. Monitor of Built-in Audio Analog Stereo [vol: 1.00]`,
        "",
      ].join("\n");
    const executed: string[][] = [];
    const service = new LinuxAudioService({
      runCommand: (command, args) => {
        executed.push([command, ...args]);
        if (command === "wpctl" && args[0] === "status")
          return Promise.resolve(statusFor());
        if (command === "wpctl" && args[0] === "get-volume") {
          const id = args[1] ?? "";
          return Promise.resolve(`Volume: ${(volumes[id] ?? 0.8).toFixed(2)}`);
        }
        if (command === "wpctl" && args[0] === "set-default") {
          if (args[1] !== undefined) defaultId = args[1];
          return Promise.resolve("");
        }
        return Promise.reject(new Error("Unknown"));
      },
    });
    const before = await service.inputSnapshot();
    expect(before.defaultDeviceId).toBe("44");
    const after = await service.setDefaultInputDevice("45");
    expect(executed).toContainEqual(["wpctl", "set-default", "45"]);
    expect(after.defaultDeviceId).toBe("45");
    expect(after.devices.find((d) => d.id === "45")?.isDefault).toBe(true);
    service.close();
  });

  it("enumerates PulseAudio sources and sets input volume", async () => {
    let currentVol = 40;
    let currentMuted = false;
    const executed: string[][] = [];
    const service = new LinuxAudioService({
      runCommand: (command, args) => {
        executed.push([command, ...args]);
        if (command === "wpctl") return Promise.reject(new Error("no wpctl"));
        if (command === "pactl" && args[0] === "list" && args[1] === "sources") {
          return Promise.resolve(
            "1\talsa_input.pci-0000_00_1f.3.analog-stereo\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tSUSPENDED\n" +
              "2\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tIDLE\n",
          );
        }
        if (command === "pactl" && args[0] === "get-default-source") {
          return Promise.resolve("alsa_input.pci-0000_00_1f.3.analog-stereo\n");
        }
        if (command === "pactl" && args[0] === "get-source-volume") {
          return Promise.resolve(
            `Volume: front-left: 26214 /  ${String(currentVol)}% / -23.81 dB`,
          );
        }
        if (command === "pactl" && args[0] === "get-source-mute") {
          return Promise.resolve(currentMuted ? "Mute: yes" : "Mute: no");
        }
        if (command === "pactl" && args[0] === "set-source-volume") {
          currentVol = parseInt((args[2] ?? "0").replace("%", ""), 10);
          return Promise.resolve("");
        }
        if (command === "pactl" && args[0] === "set-source-mute") {
          currentMuted = args[2] === "1";
          return Promise.resolve("");
        }
        if (command === "pactl" && args[0] === "set-default-source") {
          return Promise.resolve("");
        }
        return Promise.reject(new Error("Unknown"));
      },
    });
    const snapshot = await service.inputSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.defaultDeviceId).toBe("alsa_input.pci-0000_00_1f.3.analog-stereo");
    expect(snapshot.volume).toBe(40);

    await service.setInputVolume(60);
    expect(executed).toContainEqual([
      "pactl",
      "set-source-volume",
      "@DEFAULT_SOURCE@",
      "60%",
    ]);
    service.close();
  });

  it("falls back to ALSA capture devices and refuses default-source selection", async () => {
    let captureVol = 80;
    const executed: string[][] = [];
    const service = new LinuxAudioService({
      runCommand: (command, args) => {
        executed.push([command, ...args]);
        if (command === "wpctl" || command === "pactl")
          return Promise.reject(new Error("not installed"));
        if (command === "arecord")
          return Promise.resolve(
            "**** List of CAPTURE Hardware Devices ****\n" +
              "card 0: PCH [HDA Intel PCH], device 0: ALC269 Analog [ALC269 Analog]\n" +
              "  Subdevices: 1/1\n" +
              "  Subdevice #0: subdevice #0\n",
          );
        if (command === "amixer" && args[0] === "get")
          return Promise.resolve(
            `  Front Left: Capture 26214 [${String(captureVol)}%] [on]\n`,
          );
        if (command === "amixer" && args[0] === "set") {
          const pct = /(\d+)%/.exec(args[2] ?? "");
          if (pct?.[1] !== undefined) captureVol = parseInt(pct[1], 10);
          return Promise.resolve(
            `  Front Left: Capture 26214 [${String(captureVol)}%] [on]\n`,
          );
        }
        return Promise.reject(new Error("Unknown"));
      },
    });
    const snapshot = await service.inputSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]).toMatchObject({
      id: "hw:0,0",
      name: "HDA Intel PCH — ALC269 Analog",
      isDefault: true,
      volume: 80,
      muted: false,
    });
    await service.setInputVolume(70);
    expect(executed).toContainEqual(["amixer", "set", "Capture", "70%"]);
    await expect(service.setDefaultInputDevice("hw:0,0")).rejects.toThrow(
      "not supported on ALSA",
    );
    service.close();
  });

  it("reports input unavailable when no capture stack exists", async () => {
    const service = new LinuxAudioService({
      runCommand: () => Promise.reject(new Error("No audio stack")),
    });
    const snapshot = await service.inputSnapshot();
    expect(snapshot).toMatchObject({
      available: false,
      devices: [],
      defaultDeviceId: "",
    });
    await expect(service.setInputVolume(50)).rejects.toThrow(
      "No supported audio input is available.",
    );
    await expect(service.setInputMuted(true)).rejects.toThrow(
      "No supported audio input is available.",
    );
    service.close();
  });
});

describe("LinuxAudioService per-app mixer", () => {
  it("lists PipeWire playback streams and adjusts per-stream volume", async () => {
    const state = {
      volumes: { "56": 1 } as Record<string, number>,
      mutes: {} as Record<string, boolean>,
    };
    const executed: string[][] = [];
    const service = new LinuxAudioService({
      runCommand: (command, args) => {
        executed.push([command, ...args]);
        if (command === "wpctl" && args[0] === "status") {
          return Promise.resolve(
            "Audio\n ├─ Sinks:\n │  *   43. Built-in Audio Analog Stereo        [vol: 0.72]\n" +
              " ├─ Sources:\n │  *   44. Built-in Audio Analog Stereo        [vol: 0.80]\n" +
              " └─ Streams:\n        56. Chromium\n             57. output_FL > sink:playback_FL\t[active]\n",
          );
        }
        if (command === "wpctl" && args[0] === "get-volume") {
          const id = args[1] ?? "";
          const volume = state.volumes[id] ?? 1;
          const muted = state.mutes[id] ?? false;
          return Promise.resolve(
            `Volume: ${volume.toFixed(2)}${muted ? " [MUTED]" : ""}`,
          );
        }
        if (command === "wpctl" && args[0] === "set-volume") {
          state.volumes[args[1] ?? ""] = parseFloat(args[2] ?? "0");
          return Promise.resolve("");
        }
        if (command === "wpctl" && args[0] === "set-mute") {
          state.mutes[args[1] ?? ""] = args[2] === "1";
          return Promise.resolve("");
        }
        return Promise.reject(new Error("Unknown"));
      },
    });
    const streams = await service.listPlaybackStreams();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      id: "56",
      name: "Chromium",
      applicationName: "Chromium",
      volume: 100,
      muted: false,
    });

    const after = await service.setStreamVolume("56", 50);
    expect(executed).toContainEqual(["wpctl", "set-volume", "56", "0.50"]);
    expect(after[0]?.volume).toBe(50);

    const afterMute = await service.setStreamMuted("56", true);
    expect(executed).toContainEqual(["wpctl", "set-mute", "56", "1"]);
    expect(afterMute[0]?.muted).toBe(true);
    service.close();
  });

  it("parses PulseAudio sink-inputs into per-app streams", async () => {
    const streamVols: Record<string, number> = { "12": 100, "15": 50 };
    const sinkInputsFor = (): string =>
      "Sink Input #12\n\tDriver: protocol-native.c\n\tMute: no\n" +
      `\tVolume: front-left: 65536 / ${String(streamVols["12"])}% / 0.00 dB,   front-right: 65536 / ${String(streamVols["12"])}% / 0.00 dB\n` +
      '\tProperties:\n\t\tapplication.name = "Chromium"\n\t\tmedia.name = "Playback"\n\n' +
      "Sink Input #15\n\tMute: yes\n" +
      `\tVolume: front-left: 32768 /  ${String(streamVols["15"])}% / -18.06 dB,   front-right: 32768 /  ${String(streamVols["15"])}% / -18.06 dB\n` +
      '\tProperties:\n\t\tapplication.name = "Music"\n\t\tmedia.name = "Audio Stream"\n';
    const service = new LinuxAudioService({
      runCommand: (command, args) => {
        if (command === "wpctl") return Promise.reject(new Error("no wpctl"));
        if (command === "pactl" && args[0] === "list" && args[1] === "sources")
          return Promise.resolve(
            "1\talsa_input.pci.analog-stereo\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tSUSPENDED\n",
          );
        if (command === "pactl" && args[0] === "get-default-source")
          return Promise.resolve("alsa_input.pci.analog-stereo\n");
        if (command === "pactl" && args[0] === "get-source-volume")
          return Promise.resolve("Volume: front-left: 26214 /  80% / -23.81 dB");
        if (command === "pactl" && args[0] === "get-source-mute")
          return Promise.resolve("Mute: no");
        if (command === "pactl" && args[0] === "list" && args[1] === "sink-inputs") {
          return Promise.resolve(sinkInputsFor());
        }
        if (command === "pactl" && args[0] === "set-sink-input-volume") {
          const pct = /(\d+)%/.exec(args[2] ?? "");
          if (pct?.[1] !== undefined && args[1] !== undefined)
            streamVols[args[1]] = parseInt(pct[1], 10);
          return Promise.resolve("");
        }
        return Promise.reject(new Error("Unknown"));
      },
    });
    const streams = await service.listPlaybackStreams();
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({
      id: "12",
      name: "Playback",
      applicationName: "Chromium",
      volume: 100,
      muted: false,
    });
    expect(streams[1]).toMatchObject({
      id: "15",
      name: "Audio Stream",
      applicationName: "Music",
      volume: 50,
      muted: true,
    });
    await service.setStreamVolume("15", 75);
    service.close();
  });

  it("returns an empty stream list on ALSA and refuses per-stream changes", async () => {
    const service = new LinuxAudioService({
      runCommand: (command) => {
        if (command === "wpctl" || command === "pactl")
          return Promise.reject(new Error("not installed"));
        if (command === "arecord")
          return Promise.resolve(
            "**** List of CAPTURE Hardware Devices ****\n" +
              "card 0: PCH [HDA Intel PCH], device 0: ALC269 Analog [ALC269 Analog]\n",
          );
        if (command === "amixer") return Promise.resolve("  Capture [80%] [on]\n");
        return Promise.reject(new Error("Unknown"));
      },
    });
    expect(await service.listPlaybackStreams()).toEqual([]);
    await expect(service.setStreamVolume("0", 50)).rejects.toThrow(
      "Per-application mixing requires PipeWire or PulseAudio.",
    );
    await expect(service.setStreamMuted("0", true)).rejects.toThrow(
      "Per-application mixing requires PipeWire or PulseAudio.",
    );
    service.close();
  });
});

describe("LinuxAudioService recordInput", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-audio-record-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  function pipewireWithSources() {
    return (command: string, args: readonly string[]): Promise<string> => {
      if (command === "wpctl" && args[0] === "status") {
        return Promise.resolve(
          "Audio\n ├─ Sources:\n │  *   44. Built-in Audio Analog Stereo        [vol: 0.80]\n",
        );
      }
      if (command === "wpctl" && args[0] === "get-volume")
        return Promise.resolve("Volume: 0.80");
      return Promise.reject(new Error("Unknown"));
    };
  }

  it("records via pw-record on PipeWire and verifies the file", async () => {
    const recorded: { command: string; args: readonly string[]; durationMs: number }[] =
      [];
    const service = new LinuxAudioService({
      runCommand: pipewireWithSources(),
      runRecorder: (command, args, durationMs) => {
        const target = args[args.length - 1];
        if (target === undefined) return Promise.reject(new Error("no target"));
        recorded.push({ command, args, durationMs });
        return writeFile(target, "fake-wav-bytes").then(() => undefined);
      },
    });
    const target = join(tempDir, "mic-test.wav");
    const result = await service.recordInput(target, { seconds: 3 });
    expect(result).toMatchObject({ path: target, mediaType: "audio/wav", seconds: 3 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.command).toBe("pw-record");
    expect(recorded[0]?.args).toContain(target);
    expect(recorded[0]?.durationMs).toBe(3000);
    service.close();
  });

  it("records via arecord on ALSA with the requested format", async () => {
    const recorded: { command: string; args: readonly string[] }[] = [];
    const service = new LinuxAudioService({
      runCommand: (command) => {
        if (command === "wpctl" || command === "pactl")
          return Promise.reject(new Error("not installed"));
        if (command === "arecord")
          return Promise.resolve(
            "**** List of CAPTURE Hardware Devices ****\n" +
              "card 0: PCH [HDA Intel PCH], device 0: ALC269 Analog [ALC269 Analog]\n",
          );
        if (command === "amixer") return Promise.resolve("  Capture [80%] [on]\n");
        return Promise.reject(new Error("Unknown"));
      },
      runRecorder: (command, args) => {
        const target = args[args.length - 1];
        if (target === undefined) return Promise.reject(new Error("no target"));
        recorded.push({ command, args });
        return writeFile(target, "fake-wav-bytes").then(() => undefined);
      },
    });
    const target = join(tempDir, "alsa-test.wav");
    await service.recordInput(target, { seconds: 2, sampleRate: 44100, channels: 2 });
    expect(recorded[0]?.command).toBe("arecord");
    expect(recorded[0]?.args).toEqual([
      "-q",
      "-f",
      "S16_LE",
      "-r",
      "44100",
      "-c",
      "2",
      target,
    ]);
    service.close();
  });

  it("rejects empty paths and clamps the recording length", async () => {
    const durations: number[] = [];
    const service = new LinuxAudioService({
      runCommand: pipewireWithSources(),
      runRecorder: (_command, args, durationMs) => {
        const target = args[args.length - 1];
        if (target === undefined) return Promise.reject(new Error("no target"));
        durations.push(durationMs);
        return writeFile(target, "x").then(() => undefined);
      },
    });
    await expect(service.recordInput("   ")).rejects.toThrow("must not be empty");
    await service.recordInput(join(tempDir, "clamped.wav"), { seconds: 120 });
    expect(durations[0]).toBe(30_000);
    service.close();
  });

  it("fails honestly when the recorder produces no file", async () => {
    const service = new LinuxAudioService({
      runCommand: pipewireWithSources(),
      runRecorder: () => Promise.resolve(),
    });
    await expect(service.recordInput(join(tempDir, "missing.wav"))).rejects.toThrow(
      "Recording produced no audio file.",
    );
    service.close();
  });
});
