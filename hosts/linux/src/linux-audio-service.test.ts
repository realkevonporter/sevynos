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
