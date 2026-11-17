/**
 * SevynOS v2 — audiod client guards.
 *
 * This file is the proof for the old Music bug: a bad audio call
 * (missing file, non-audio file, bad seek, volume edge) must return a
 * clean, coded rejection and can NEVER kill Genesis. Every test here
 * drives the client against a fake audiod transport — no real daemon,
 * no socket — except the SocketAudiodTransport tests at the bottom,
 * which speak to a real local Unix socket server.
 *
 * The fake daemon mirrors the real one's semantics (same stable
 * codes, clamping volume, real durations from its script): if the
 * client ever invents a duration, a position, or a fake "playing",
 * these tests catch it.
 */

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AudiodError,
  LinuxAudiodClient,
  SocketAudiodTransport,
  type AudiodTransport,
} from "./linux-audiod-client.js";

type Reply = Record<string, unknown>;

function statusReply(overrides: Reply = {}): Reply {
  return {
    ok: true,
    available: true,
    playing: false,
    paused: false,
    positionSec: 0,
    durationSec: 0,
    volume: 100,
    track: null,
    error: "",
    ...overrides,
  };
}

function failReply(code: string, error: string): Reply {
  return { ok: false, error, code };
}

/** A fake audiod: stateful, scripted durations, daemon-faithful codes. */
class FakeAudiod implements AudiodTransport {
  readonly calls: string[] = [];
  #playing = false;
  #paused = false;
  #positionSec = 0;
  #durationSec = 0;
  #volume = 100;
  #track: Reply | null = null;
  #throwNext: Error | null = null;

  /** The next roundtrip throws this transport error instead of answering. */
  public failNextWith(error: Error): void {
    this.#throwNext = error;
  }

  public roundtrip(line: string): Promise<Reply> {
    try {
      return Promise.resolve(this.#handle(line));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Fake audiod failed."),
      );
    }
  }

  #handle(line: string): Reply {
    this.calls.push(line);
    if (this.#throwNext !== null) {
      const error = this.#throwNext;
      this.#throwNext = null;
      throw error;
    }
    const [command, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    switch (command) {
      case "STATUS":
        return this.#status();
      case "PLAY": {
        if (arg === "/data/missing.wav")
          return failReply("not-found", "audio file not found");
        if (arg === "/data/not-audio.wav")
          return failReply("unsupported-format", "unsupported audio format");
        if (arg === "/data/boom.wav")
          return failReply("decode-error", "not a decodable MP3 file");
        this.#playing = true;
        this.#paused = false;
        this.#positionSec = 0;
        this.#durationSec = arg.endsWith(".mp3") ? 200 : 21.5;
        this.#track = {
          path: arg,
          format: arg.endsWith(".mp3") ? "mp3" : "wav",
          durationSec: this.#durationSec,
        };
        return this.#status();
      }
      case "PAUSE":
        if (!this.#playing) return failReply("idle", "nothing is playing");
        this.#paused = true;
        return this.#status();
      case "RESUME":
        if (!this.#playing) return failReply("idle", "nothing is playing");
        this.#paused = false;
        return this.#status();
      case "STOP":
        this.#playing = false;
        this.#paused = false;
        this.#positionSec = 0;
        this.#track = null;
        return this.#status();
      case "SEEK": {
        if (!this.#playing) return failReply("idle", "nothing is playing");
        const seconds = Number(arg);
        if (seconds > this.#durationSec)
          return failReply(
            "out-of-range",
            `seek ${arg} is outside 0..${String(this.#durationSec)}`,
          );
        this.#positionSec = seconds;
        return this.#status();
      }
      case "VOLUME": {
        const volume = Math.max(0, Math.min(100, Math.round(Number(arg))));
        this.#volume = volume;
        return this.#status();
      }
      case "SCAN": {
        if (arg === "/data/no-such-dir")
          return failReply("not-found", "cannot list /data/no-such-dir");
        return {
          ok: true,
          tracks: [
            {
              id: "/data/01-sunrise-acoustic.wav",
              title: "01-sunrise-acoustic",
              artist: "Unknown Artist",
              album: "Local Library",
              durationSec: 21.5,
              path: "/data/01-sunrise-acoustic.wav",
              format: "wav",
            },
            {
              id: "/data/song.mp3",
              title: "song",
              artist: "Unknown Artist",
              album: "Local Library",
              durationSec: 200,
              path: "/data/song.mp3",
              format: "mp3",
            },
          ],
        };
      }
      default:
        return failReply("bad-argument", "unknown command");
    }
  }

  #status(): Reply {
    return statusReply({
      playing: this.#playing,
      paused: this.#paused,
      positionSec: this.#positionSec,
      durationSec: this.#durationSec,
      volume: this.#volume,
      track: this.#track,
    });
  }

  /** Test hook: move the fake's position (playback advancing). */
  public advance(seconds: number): void {
    this.#positionSec = Math.min(this.#durationSec, this.#positionSec + seconds);
  }
}

describe("LinuxAudiodClient guards", () => {
  it("plays a file and reports the daemon's real duration and position", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    const status = await client.play("/data/01-sunrise-acoustic.wav");
    expect(status.playing).toBe(true);
    expect(status.durationSec).toBe(21.5);
    expect(status.currentPositionSec).toBe(0);
    expect(status.track?.format).toBe("wav");
    fake.advance(1.5);
    const later = await client.status();
    expect(later.currentPositionSec).toBe(1.5);
    // Position comes from the daemon, not a client clock: two status
    // calls with no advance in between report the same position.
    const again = await client.status();
    expect(again.currentPositionSec).toBe(1.5);
  });

  it("rejects a missing file with the daemon's not-found code", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    await expect(client.play("/data/missing.wav")).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(client.status()).resolves.toMatchObject({ playing: false });
  });

  it("rejects a non-audio file and an undecodable file cleanly", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    await expect(client.play("/data/not-audio.wav")).rejects.toMatchObject({
      code: "unsupported-format",
    });
    await expect(client.play("/data/boom.wav")).rejects.toMatchObject({
      code: "decode-error",
    });
    await expect(client.status()).resolves.toMatchObject({ playing: false });
  });

  it("rejects bad play arguments before any I/O", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    for (const bad of ["", "relative/path.wav", "   "]) {
      await expect(client.play(bad)).rejects.toMatchObject({ code: "bad-argument" });
    }
    await expect(client.play({ path: "" })).rejects.toMatchObject({
      code: "bad-argument",
    });
    await expect(client.play(null as unknown as string)).rejects.toMatchObject({
      code: "bad-argument",
    });
    expect(fake.calls).toEqual([]);
  });

  it("rejects pause/resume/seek while idle with the idle code", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    await expect(client.pause()).rejects.toMatchObject({ code: "idle" });
    await expect(client.resume()).rejects.toMatchObject({ code: "idle" });
    await expect(client.seek(5)).rejects.toMatchObject({ code: "idle" });
    await expect(client.stop()).resolves.toMatchObject({ playing: false });
  });

  it("pauses, resumes, and seeks with daemon positions", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    await client.play("/data/01-sunrise-acoustic.wav");
    fake.advance(3);
    const paused = await client.pause();
    expect(paused.paused).toBe(true);
    expect(paused.currentPositionSec).toBe(3);
    const resumed = await client.resume();
    expect(resumed.paused).toBe(false);
    const sought = await client.seek(10);
    expect(sought.currentPositionSec).toBe(10);
    const stopped = await client.stop();
    expect(stopped.playing).toBe(false);
    expect(stopped.currentPositionSec).toBe(0);
  });

  it("rejects bad seeks before any I/O and out-of-range seeks from the daemon", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    await client.play("/data/01-sunrise-acoustic.wav");
    const before = fake.calls.length;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(client.seek(bad)).rejects.toMatchObject({ code: "bad-argument" });
    }
    await expect(client.seek("60" as unknown as number)).rejects.toMatchObject({
      code: "bad-argument",
    });
    expect(fake.calls.length).toBe(before);
    await expect(client.seek(9999)).rejects.toMatchObject({ code: "out-of-range" });
    await expect(client.status()).resolves.toMatchObject({ playing: true });
  });

  it("clamps volume edges like the daemon and rejects non-numbers", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    await client.play("/data/01-sunrise-acoustic.wav");
    await expect(client.setVolume(50)).resolves.toMatchObject({ volume: 50 });
    await expect(client.setVolume(150)).resolves.toMatchObject({ volume: 100 });
    await expect(client.setVolume(-5)).resolves.toMatchObject({ volume: 0 });
    const before = fake.calls.length;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(client.setVolume(bad)).rejects.toMatchObject({
        code: "bad-argument",
      });
    }
    await expect(client.setVolume("loud" as unknown as number)).rejects.toMatchObject({
      code: "bad-argument",
    });
    expect(fake.calls.length).toBe(before);
    await expect(client.status()).resolves.toMatchObject({ playing: true, volume: 0 });
  });

  it("scans with the daemon's real durations, never hardcoded ones", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    const tracks = await client.scan("/data");
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.durationSec).toBe(21.5);
    expect(tracks[1]?.durationSec).toBe(200);
    expect(tracks.map((t) => t.durationSec)).not.toContain(210);
    await expect(client.scan("/data/no-such-dir")).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(client.scan("")).rejects.toMatchObject({ code: "bad-argument" });
  });

  it("converts transport failures to audio-unavailable and stays usable", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    fake.failNextWith(new Error("connect ENOENT /run/sevyn-audio.sock"));
    await expect(client.status()).rejects.toMatchObject({ code: "audio-unavailable" });
    await expect(client.play("/data/01-sunrise-acoustic.wav")).resolves.toMatchObject({
      playing: true,
    });
  });

  it("survives a storm of bad calls: all settle, none hang, playback still works", async () => {
    const fake = new FakeAudiod();
    const client = new LinuxAudiodClient(fake);
    const badCalls = [
      client.play(""),
      client.play("/data/missing.wav"),
      client.play("/data/not-audio.wav"),
      client.seek(Number.NaN),
      client.seek(-1),
      client.setVolume(Number.NaN),
      client.setVolume("loud" as unknown as number),
      client.pause(),
      client.resume(),
      client.scan(""),
      client.scan("/data/no-such-dir"),
    ];
    // Repeat the storm five times concurrently: 55 bad calls at once.
    const storm = await Promise.allSettled([
      ...badCalls,
      ...badCalls,
      ...badCalls,
      ...badCalls,
      ...badCalls,
    ]);
    expect(storm).toHaveLength(55);
    for (const result of storm) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        const reason = result.reason as AudiodError;
        expect(reason).toBeInstanceOf(AudiodError);
        expect(typeof reason.code).toBe("string");
      }
    }
    // The client is still alive and the daemon still answers.
    const status = await client.play("/data/01-sunrise-acoustic.wav");
    expect(status.playing).toBe(true);
    expect(status.durationSec).toBe(21.5);
  });
});

describe("SocketAudiodTransport", () => {
  const sockets: net.Server[] = [];
  const paths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      sockets.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
    const fs = await import("node:fs/promises");
    await Promise.all(paths.splice(0).map((p) => fs.rm(p, { force: true })));
  });

  async function serveSocket(
    path: string,
    onLine: (line: string, socket: net.Socket) => void,
  ): Promise<net.Server> {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const idx = buffer.indexOf("\n");
        if (idx >= 0) onLine(buffer.slice(0, idx), socket);
      });
    });
    sockets.push(server);
    paths.push(path);
    await new Promise<void>((resolve) => {
      server.listen(path, resolve);
    });
    return server;
  }

  it("rejects when no daemon is listening", async () => {
    const transport = new SocketAudiodTransport("/tmp/sevyn-audiod-no-such.sock", 1000);
    await expect(transport.roundtrip("STATUS")).rejects.toMatchObject({
      code: "audio-unavailable",
    });
  });

  it("rejects a malformed reply instead of crashing on JSON.parse", async () => {
    const path = "/tmp/sevyn-audiod-garbage.sock";
    await serveSocket(path, (_line, socket) => {
      socket.write("this is not json\n");
    });
    const transport = new SocketAudiodTransport(path, 1000);
    await expect(transport.roundtrip("STATUS")).rejects.toMatchObject({
      code: "audio-unavailable",
    });
  });

  it("rejects when the daemon closes without answering", async () => {
    const path = "/tmp/sevyn-audiod-silent.sock";
    await serveSocket(path, (_line, socket) => {
      socket.end();
    });
    const transport = new SocketAudiodTransport(path, 1000);
    await expect(transport.roundtrip("STATUS")).rejects.toMatchObject({
      code: "audio-unavailable",
    });
  });

  it("times out instead of hanging on a silent daemon", async () => {
    const path = "/tmp/sevyn-audiod-slow.sock";
    await serveSocket(path, () => {
      // Never answers.
    });
    const transport = new SocketAudiodTransport(path, 200);
    await expect(transport.roundtrip("STATUS")).rejects.toMatchObject({
      code: "audio-unavailable",
    });
  });

  it("round-trips a real reply over a real socket", async () => {
    const path = "/tmp/sevyn-audiod-ok.sock";
    await serveSocket(path, (line, socket) => {
      expect(line).toBe("STATUS");
      socket.write(`${JSON.stringify(statusReply({ playing: true }))}\n`);
    });
    const transport = new SocketAudiodTransport(path, 1000);
    const reply = await transport.roundtrip("STATUS");
    expect(reply["playing"]).toBe(true);
  });
});
