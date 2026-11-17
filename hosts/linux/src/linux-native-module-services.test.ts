import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { LinuxNativeModuleServices } from "./linux-native-module-services.js";
import { LinuxAudiodClient, type AudiodTransport } from "./linux-audiod-client.js";

const servers: ReturnType<typeof createServer>[] = [];
const websocketServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    ),
  );
  await Promise.all(
    websocketServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** Fake audiod transport for the services tests (same daemon semantics). */
class FakeAudiodTransport implements AudiodTransport {
  readonly calls: string[] = [];
  #playing = false;
  #paused = false;
  #positionSec = 0;
  #durationSec = 0;
  #volume = 100;
  #track: Record<string, unknown> | null = null;
  #durations = new Map<string, number>([
    ["/data/song.mp3", 240],
    ["/dev/null", 180],
  ]);

  public async roundtrip(line: string): Promise<Record<string, unknown>> {
    this.calls.push(line);
    const [command, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    const status = (): Record<string, unknown> => ({
      ok: true,
      available: true,
      playing: this.#playing,
      paused: this.#paused,
      positionSec: this.#positionSec,
      durationSec: this.#durationSec,
      volume: this.#volume,
      track: this.#track,
      error: "",
    });
    switch (command) {
      case "STATUS":
        return status();
      case "PLAY": {
        if (arg === "/tmp/sevynos-audio-file-that-does-not-exist.wav")
          return { ok: false, error: "audio file not found", code: "not-found" };
        this.#playing = true;
        this.#paused = false;
        this.#positionSec = 0;
        this.#durationSec = this.#durations.get(arg) ?? 60;
        this.#track = {
          path: arg,
          format: arg.endsWith(".mp3") ? "mp3" : "wav",
          durationSec: this.#durationSec,
        };
        return status();
      }
      case "PAUSE":
        if (!this.#playing)
          return { ok: false, error: "nothing is playing", code: "idle" };
        this.#paused = true;
        return status();
      case "RESUME":
        if (!this.#playing)
          return { ok: false, error: "nothing is playing", code: "idle" };
        this.#paused = false;
        return status();
      case "STOP":
        this.#playing = false;
        this.#paused = false;
        this.#positionSec = 0;
        this.#track = null;
        return status();
      case "SEEK": {
        if (!this.#playing)
          return { ok: false, error: "nothing is playing", code: "idle" };
        const seconds = Number(arg);
        if (seconds > this.#durationSec)
          return { ok: false, error: "seek is outside the track", code: "out-of-range" };
        this.#positionSec = seconds;
        return status();
      }
      case "VOLUME":
        this.#volume = Math.max(0, Math.min(100, Math.round(Number(arg))));
        return status();
      case "SCAN": {
        if (arg === "/tmp/non-existent-music-test-folder")
          return { ok: false, error: "cannot list that directory", code: "not-found" };
        return {
          ok: true,
          tracks: [
            {
              id: "/data/song.mp3",
              title: "song",
              artist: "Unknown Artist",
              album: "Local Library",
              durationSec: 240,
              path: "/data/song.mp3",
              format: "mp3",
            },
          ],
        };
      }
      default:
        return { ok: false, error: "unknown command", code: "bad-argument" };
    }
  }
}

function servicesWithFakeAudio(): {
  services: LinuxNativeModuleServices;
  fake: FakeAudiodTransport;
} {
  const fake = new FakeAudiodTransport();
  const services = new LinuxNativeModuleServices(
    "/tmp/sevynos-native-test",
    "/tmp/sevynos-native-modules-test",
    new LinuxAudiodClient(fake),
  );
  return { services, fake };
}

describe("Linux native module services", () => {
  it("brokers bounded HTTP responses for Hermes fetch", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ready: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server did not bind.");

    const services = new LinuxNativeModuleServices();
    const result = await services.request("network.request", {
      url: `http://127.0.0.1:${String(address.port)}/status`,
      method: "GET",
      headers: { accept: "application/json" },
      body: null,
    });
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new Error("Network response was not an object.");

    const record = result as Readonly<Record<string, unknown>>;
    expect(record["status"]).toBe(200);
    expect(Buffer.from(String(record["bodyBase64"]), "base64").toString("utf8")).toBe(
      '{"ready":true}',
    );
  });

  it("decodes image URIs into an RGBA surface for React Native Image", async () => {
    const services = new LinuxNativeModuleServices();
    const result = await services.request(
      "image.load",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAAAAAADUlEQVR4nGP4z8DwHwAFAAH/AAAAAAAAAABJRU5EAAAAAA==",
    );
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new Error("Image response was not an object.");
    expect(result).toMatchObject({ width: 1, height: 1 });
  });

  it("brokers WebSocket text and binary frames through the network service", async () => {
    const server = new WebSocketServer({ port: 0 });
    websocketServers.push(server);
    server.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        const text =
          data instanceof Buffer
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8");
        socket.send(isBinary ? data : `echo:${text}`);
      });
    });
    await new Promise<void>((resolve) =>
      server.once("listening", () => {
        resolve();
      }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("WebSocket server did not bind.");
    const services = new LinuxNativeModuleServices();
    const opened = await services.request("websocket.open", {
      id: "test-socket",
      url: `ws://127.0.0.1:${String(address.port)}`,
      protocols: null,
    });
    expect(opened).toMatchObject({ id: "test-socket", protocol: "" });
    await services.request("websocket.send", {
      id: "test-socket",
      text: "ping",
      base64: null,
    });
    await expect(
      services.request("websocket.receive", "test-socket"),
    ).resolves.toMatchObject({
      type: "message",
      text: "echo:ping",
    });
    await services.request("websocket.send", {
      id: "test-socket",
      text: null,
      base64: "AQID",
    });
    await expect(
      services.request("websocket.receive", "test-socket"),
    ).resolves.toMatchObject({
      type: "message",
      base64: "AQID",
    });
    await services.request("websocket.close", {
      id: "test-socket",
      code: 1000,
      reason: "done",
    });
    services.close();
  });

  it("handles media playback lifecycle, seeking, and status tracking", async () => {
    const { services, fake } = servicesWithFakeAudio();
    const played = await services.request("media.play", {
      path: "/data/song.mp3",
      track: {
        id: "track-1",
        title: "Genesis Horizon",
        artist: "SevynOS Sound Team",
        album: "Genesis Horizon",
        durationSec: 240,
        path: "/data/song.mp3",
        format: "mp3",
      },
      durationSec: 240,
    });
    // The duration is the daemon's probe (240 for this file), not a
    // hardcoded 180 — and the caller-supplied track wins for display.
    expect(played).toMatchObject({
      playing: true,
      paused: false,
      durationSec: 240,
      track: { title: "Genesis Horizon", artist: "SevynOS Sound Team" },
    });
    expect(fake.calls[0]).toBe("PLAY /data/song.mp3");

    const paused = await services.request("media.pause", null);
    expect(paused).toMatchObject({
      playing: true,
      paused: true,
    });

    const resumed = await services.request("media.resume", null);
    expect(resumed).toMatchObject({
      playing: true,
      paused: false,
    });

    const sought = await services.request("media.seek", 60);
    expect(sought).toMatchObject({
      playing: true,
      currentPositionSec: 60,
    });

    const status = await services.request("media.status", null);
    expect(status).toMatchObject({
      playing: true,
      durationSec: 240,
      currentPositionSec: 60,
    });

    const stopped = await services.request("media.stop", null);
    expect(stopped).toMatchObject({
      playing: false,
      paused: false,
    });

    // A missing directory is a clean rejection now, not a silent []:
    // the old scan swallowed the error and returned nothing.
    await expect(
      services.request("media.scan", {
        directory: "/tmp/non-existent-music-test-folder",
      }),
    ).rejects.toThrow("cannot list that directory");
    const scanned = await services.request("media.scan", { directory: "/data" });
    expect(Array.isArray(scanned)).toBe(true);
    expect(scanned).toMatchObject([
      { path: "/data/song.mp3", durationSec: 240, format: "mp3" },
    ]);

    services.close();
  });

  it("does not report playback when the requested audio file is missing", async () => {
    const { services } = servicesWithFakeAudio();
    await expect(
      services.request("media.play", "/tmp/sevynos-audio-file-that-does-not-exist.wav"),
    ).rejects.toThrow("audio file not found");
    await expect(services.request("media.status", null)).resolves.toMatchObject({
      playing: false,
    });
  });

  it("rejects bad media calls instead of crashing the host", async () => {
    const { services } = servicesWithFakeAudio();
    // The old bug: a volume-up rejection escaped into Genesis and
    // killed it. Every one of these must reject cleanly and leave
    // the services object usable afterwards.
    await expect(services.request("media.play", "")).rejects.toThrow(
      "Audio playback requires a file path.",
    );
    await expect(services.request("media.play", "relative/path.wav")).rejects.toThrow(
      "Audio playback requires an absolute path.",
    );
    await expect(services.request("media.seek", -1)).rejects.toThrow(
      "Seek requires a finite number",
    );
    await expect(services.request("media.seek", Number.NaN)).rejects.toThrow(
      "Seek requires a finite number",
    );
    await expect(services.request("media.volume", Number.NaN)).rejects.toThrow(
      "Volume requires a finite number",
    );
    await expect(services.request("media.pause", null)).rejects.toThrow(
      "nothing is playing",
    );
    const played = await services.request("media.play", "/data/song.mp3");
    expect(played).toMatchObject({ playing: true, durationSec: 240 });
    // Out-of-range seek and clamped volume edges, still alive after.
    await expect(services.request("media.seek", 9999)).rejects.toThrow(
      "seek is outside the track",
    );
    const loud = await services.request("media.volume", 150);
    expect(loud).toMatchObject({ volume: 100 });
    const quiet = await services.request("media.volume", -5);
    expect(quiet).toMatchObject({ volume: 0 });
    await expect(services.request("media.status", null)).resolves.toMatchObject({
      playing: true,
    });
    services.close();
  });

  it("handles new hardware services gracefully (battery, display, audio, vibration, nfc, cellular, torch, volume)", async () => {
    // The media calls below go through a fake audiod: there is no
    // daemon socket in the test env, and a missing daemon must be a
    // rejection the caller sees — not a fake "playing" state.
    const { services } = servicesWithFakeAudio();

    // Battery status
    const battery = await services.request("battery.status", null);
    expect(battery).toBeDefined();
    expect(typeof (battery as Record<string, unknown>)["level"]).toBe("number");
    expect(typeof (battery as Record<string, unknown>)["charging"]).toBe("boolean");

    // Display brightness get & set
    const initialBrightness = await services.request("display.brightness.get", null);
    expect(typeof initialBrightness).toBe("number");
    const setBrightness = await services.request("display.brightness.set", 0.75);
    expect(setBrightness).toBeNull();

    // Audio outputs get & set
    const outputs = await services.request("audio.outputs.get", null);
    expect(Array.isArray(outputs)).toBe(true);
    await expect(services.request("audio.output.set", "default")).resolves.toBeDefined();

    // Vibration vibrate & cancel
    const vib = (await services.request("vibration.vibrate", 200)) as Record<
      string,
      unknown
    >;
    expect(vib["success"] === true || vib["available"] === false).toBe(true);
    const cancelVib = await services.request("vibration.cancel", null);
    expect(cancelVib).toBeNull();

    // NFC status, scan, write
    const nfcStatus = await services.request("nfc.status", null);
    expect(nfcStatus).toMatchObject({ available: false });
    await expect(services.request("nfc.scan", null)).rejects.toThrow(
      "NFC reader not detected on this device.",
    );
    await expect(services.request("nfc.write", { data: "test" })).rejects.toThrow(
      "NFC writer not detected on this device.",
    );

    // Cellular status, signal, bearer, dial, hangup, sms
    const cellStatus = await services.request("cellular.status", null);
    expect(cellStatus).toMatchObject({ available: false });
    await expect(services.request("cellular.dial", "5551234")).rejects.toThrow(
      "No cellular modem detected on this device.",
    );
    await expect(
      services.request("cellular.sms.send", { recipient: "555", message: "hi" }),
    ).rejects.toThrow("No cellular modem detected on this device.");
    const smsList = await services.request("cellular.sms.list", null);
    expect(smsList).toEqual([]);

    // Camera torch
    const torch = (await services.request("camera.torch", true)) as Record<
      string,
      unknown
    >;
    expect(typeof torch["success"]).toBe("boolean");

    // Media volume
    const vol = await services.request("media.volume", 80);
    expect(vol).toMatchObject({ volume: 80 });

    // Display mobile behaviors: orientation lock, auto-brightness, wake lock
    const orientationInit = (await services.request(
      "display.orientation.get",
      null,
    )) as Record<string, unknown>;
    expect(orientationInit["orientation"]).toBe("portrait");

    const orientationLocked = (await services.request("display.orientation.lock", {
      orientation: "landscape-left",
    })) as Record<string, unknown>;
    expect(orientationLocked["orientation"]).toBe("landscape-left");

    const autoBrightness = (await services.request("display.autoBrightness.set", {
      enabled: true,
    })) as Record<string, unknown>;
    expect(autoBrightness["enabled"]).toBe(true);
    expect(await services.request("display.autoBrightness.get", null)).toMatchObject({
      enabled: true,
    });

    const wakeLock = (await services.request("display.wakeLock.acquire", null)) as Record<
      string,
      unknown
    >;
    expect(typeof wakeLock["lockId"]).toBe("string");
    const wakeLockReleased = (await services.request("display.wakeLock.release", {
      lockId: String(wakeLock["lockId"]),
    })) as Record<string, unknown>;
    expect(wakeLockReleased["released"]).toBe(true);

    // Sensors: normalized SI units and streaming subscriptions
    const accel = (await services.request("sensors.read", "accelerometer")) as Record<
      string,
      unknown
    >;
    expect(accel["sensor"]).toBe("accelerometer");
    expect(accel["unit"]).toBe("m/s^2");
    expect(typeof (accel["values"] as Record<string, unknown>)["y"]).toBe("number");

    const light = (await services.request("sensors.read", "ambientLight")) as Record<
      string,
      unknown
    >;
    expect(light["unit"]).toBe("lux");

    const prox = (await services.request("sensors.read", "proximity")) as Record<
      string,
      unknown
    >;
    expect(prox["unit"]).toBe("cm");
    expect(typeof prox["near"]).toBe("boolean");

    const baro = (await services.request("sensors.read", "barometer")) as Record<
      string,
      unknown
    >;
    expect(baro["unit"]).toBe("hPa");

    const sensorSub = (await services.request("sensors.subscribe", {
      sensor: "ambientLight",
      samplingRateHz: 50,
    })) as Record<string, unknown>;
    expect(typeof sensorSub["subscriptionId"]).toBe("string");

    const sensorUnsub = (await services.request("sensors.unsubscribe", {
      subscriptionId: String(sensorSub["subscriptionId"]),
    })) as Record<string, unknown>;
    expect(sensorUnsub["success"]).toBe(true);

    // Biometrics: enrollment, delete, list, PIN fallback, keystore vault
    const enrollResult = (await services.request("biometrics.enroll", {
      type: "fingerprint",
      label: "Left Thumb",
    })) as Record<string, unknown>;
    expect(enrollResult["success"]).toBe(true);
    const cred = enrollResult["credential"] as Record<string, unknown>;
    expect(cred["label"]).toBe("Left Thumb");

    const listResult = (await services.request(
      "biometrics.list",
      null,
    )) as readonly Record<string, unknown>[];
    expect(listResult.some((c) => c["label"] === "Left Thumb")).toBe(true);

    const pinOk = (await services.request("biometrics.pin.verify", {
      pin: "1234",
    })) as Record<string, unknown>;
    expect(pinOk["verified"]).toBe(true);

    const pinBad = (await services.request("biometrics.pin.verify", {
      pin: "wrong-pin",
    })) as Record<string, unknown>;
    expect(pinBad["verified"]).toBe(false);

    // Biometric keystore vault operations
    await services.request("biometrics.keystore.set", {
      key: "user-session-token",
      secret: "encrypted-val-999",
    });
    const keyVal = (await services.request("biometrics.keystore.get", {
      key: "user-session-token",
    })) as Record<string, unknown>;
    expect(keyVal["value"]).toBe("encrypted-val-999");

    const keysList = (await services.request("biometrics.keystore.list", null)) as Record<
      string,
      unknown
    >;
    expect((keysList["keys"] as string[]).includes("user-session-token")).toBe(true);

    const keyDel = (await services.request("biometrics.keystore.delete", {
      key: "user-session-token",
    })) as Record<string, unknown>;
    expect(keyDel["success"]).toBe(true);

    const keyValAfter = (await services.request("biometrics.keystore.get", {
      key: "user-session-token",
    })) as Record<string, unknown>;
    expect(keyValAfter["value"]).toBeNull();

    // Verification of supports()
    expect(services.supports("sensors.read")).toBe(true);
    expect(services.supports("biometrics.enroll")).toBe(true);
    expect(services.supports("display.orientation.lock")).toBe(true);
    expect(services.supports("nonexistent.service")).toBe(false);

    services.close();
  });
});

describe("Linux native module services: bluetooth/display/power dispatch", () => {
  it("advertises the Phase 2 bluetooth and display worker services", () => {
    const services = new LinuxNativeModuleServices();
    for (const name of [
      "bluetooth.scan",
      "bluetooth.state",
      "bluetooth.power.set",
      "bluetooth.devices",
      "bluetooth.pair",
      "bluetooth.pairRespond",
      "bluetooth.connect",
      "bluetooth.disconnect",
      "bluetooth.remove",
      "bluetooth.trust",
      "display.outputs.get",
      "display.mode.set",
      "display.rotation.set",
    ]) {
      expect(services.supports(name)).toBe(true);
    }
    expect(services.supports("bluetooth.nonexistent")).toBe(false);
    services.close();
  });

  it("reports bluetooth unavailable without throwing when no adapter exists", async () => {
    const services = new LinuxNativeModuleServices();
    const state = (await services.request("bluetooth.state", null)) as Record<
      string,
      unknown
    >;
    expect(typeof state["available"]).toBe("boolean");
    // Actions without an adapter fail with a clear error, not a crash.
    await expect(
      services.request("bluetooth.pair", { address: "AA:BB:CC:DD:EE:FF" }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      services.request("bluetooth.pair", { address: "not-a-mac" }),
    ).rejects.toThrow(/invalid bluetooth address/i);
    services.close();
  });

  it("enumerates display outputs without throwing", async () => {
    const services = new LinuxNativeModuleServices();
    const outputs = await services.request("display.outputs.get", null);
    expect(Array.isArray(outputs)).toBe(true);
    await expect(
      services.request("display.mode.set", {
        outputId: "card9-Nope-1",
        width: 1280,
        height: 720,
      }),
    ).rejects.toThrow(/unknown display output/i);
    await expect(
      services.request("display.rotation.set", { outputId: "card0-x", degrees: 45 }),
    ).rejects.toThrow(/must be one of/);
    services.close();
  });
});
