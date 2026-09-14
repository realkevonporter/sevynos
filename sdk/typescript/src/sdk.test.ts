import { describe, expect, it, vi } from "vitest";
import {
  CapabilityError,
  HardwareUnavailableError,
  StorageQuotaError,
  createSevynClient,
  sevyn,
} from "./index.js";

describe("@sevynos/sdk", () => {
  it("exposes default sevyn client namespace with all core and hardware modules", () => {
    expect(sevyn.app).toBeDefined();
    expect(sevyn.notifications).toBeDefined();
    expect(sevyn.clipboard).toBeDefined();
    expect(sevyn.storage).toBeDefined();
    expect(sevyn.files).toBeDefined();
    expect(sevyn.windows).toBeDefined();
    expect(sevyn.events).toBeDefined();

    // Unified hardware surface
    expect(sevyn.camera).toBeDefined();
    expect(sevyn.microphone).toBeDefined();
    expect(sevyn.bluetooth).toBeDefined();
    expect(sevyn.location).toBeDefined();
    expect(sevyn.geolocation).toBeDefined();
    expect(sevyn.sensors).toBeDefined();
    expect(sevyn.biometrics).toBeDefined();
    expect(sevyn.media).toBeDefined();
    expect(sevyn.battery).toBeDefined();
    expect(sevyn.display).toBeDefined();
    expect(sevyn.audio).toBeDefined();
    expect(sevyn.vibration).toBeDefined();
    expect(sevyn.haptics).toBeDefined();
    expect(sevyn.nfc).toBeDefined();
    expect(sevyn.cellular).toBeDefined();
  });

  describe("sevyn.app", () => {
    it("reports application identity and manifest", () => {
      const client = createSevynClient({
        manifest: {
          manifestVersion: 1,
          id: "org.sevynos.notes",
          name: "Notes",
          version: "1.0.0",
          developer: "SevynOS Contributors",
          icon: "icon.svg",
          entrypoint: "dist/index.js",
          minimumSevynOSVersion: "0.1.0",
          permissions: ["filesystem.read", "filesystem.write"],
        },
      });

      expect(client.app.id).toBe("org.sevynos.notes");
      expect(client.app.name).toBe("Notes");
      expect(client.app.version).toBe("1.0.0");
      expect(client.app.state).toBe("running");
    });
  });

  describe("core capabilities & permissions", () => {
    it("throws CapabilityError when invoking unauthorized notifications", async () => {
      const client = createSevynClient({
        permissions: ["filesystem.read"],
      });

      await expect(client.notifications.show({ title: "Hello" })).rejects.toThrow(
        CapabilityError,
      );
    });

    it("allows notifications when permission is granted", async () => {
      const notificationsReceived: string[] = [];
      const client = createSevynClient({
        permissions: ["notifications"],
        notificationHandler: (n) => notificationsReceived.push(n.title),
      });

      await client.notifications.show({ title: "Update Ready" });
      expect(notificationsReceived).toEqual(["Update Ready"]);
    });

    it("gates clipboard access on clipboard.read and clipboard.write", async () => {
      const readOnlyClient = createSevynClient({
        permissions: ["clipboard.read"],
      });

      await expect(readOnlyClient.clipboard.writeText("Secret")).rejects.toThrow(
        CapabilityError,
      );
      await expect(readOnlyClient.clipboard.readText()).resolves.toBe("");

      const writeOnlyClient = createSevynClient({
        permissions: ["clipboard.write"],
      });

      await writeOnlyClient.clipboard.writeText("Hello");
      await expect(writeOnlyClient.clipboard.readText()).rejects.toThrow(CapabilityError);
    });

    it("gates filesystem operations on filesystem.read and filesystem.write", async () => {
      const readOnlyClient = createSevynClient({
        permissions: ["filesystem.read"],
        initialFiles: {
          "/notes/todo.txt": "1. Buy milk",
        },
      });

      expect(await readOnlyClient.files.read("/notes/todo.txt")).toBe("1. Buy milk");
      expect(await readOnlyClient.files.list("/notes")).toEqual(["todo.txt"]);
      await expect(
        readOnlyClient.files.write("/notes/todo.txt", "Updated"),
      ).rejects.toThrow(CapabilityError);
    });
  });

  describe("sevyn.camera", () => {
    it("requires camera permission", async () => {
      const client = createSevynClient({ permissions: ["notifications"] });
      await expect(client.camera.capture()).rejects.toThrow(CapabilityError);
      await expect(client.camera.recordStart()).rejects.toThrow(CapabilityError);
      await expect(client.camera.recordStop()).rejects.toThrow(CapabilityError);
      await expect(client.camera.preview()).rejects.toThrow(CapabilityError);
      await expect(client.camera.status()).rejects.toThrow(CapabilityError);
      await expect(client.camera.setTorch(true)).rejects.toThrow(CapabilityError);
    });

    it("routes to hardwareHandler when camera capability is granted", async () => {
      const client = createSevynClient({
        permissions: ["camera"],
        hardwareHandler: {
          camera: {
            capture: vi
              .fn()
              .mockResolvedValue({ uri: "sevyn://photo.jpg", width: 1920, height: 1080 }),
            status: vi.fn().mockResolvedValue({
              available: true,
              active: true,
              recording: false,
              torch: false,
            }),
            setTorch: vi.fn().mockResolvedValue(undefined),
          },
        },
      });

      const photo = await client.camera.capture();
      expect(photo.uri).toBe("sevyn://photo.jpg");
      const status = await client.camera.status();
      expect(status.available).toBe(true);
      await expect(client.camera.setTorch(true)).resolves.toBeUndefined();
    });

    it("degrades gracefully with HardwareUnavailableError or status when hardware is absent", async () => {
      const client = createSevynClient({ permissions: ["camera"] });
      const status = await client.camera.status();
      expect(status.available).toBe(false);
      await expect(client.camera.capture()).rejects.toThrow(HardwareUnavailableError);
      await expect(client.camera.setTorch(true)).rejects.toThrow(
        HardwareUnavailableError,
      );
    });
  });

  describe("sevyn.microphone", () => {
    it("requires microphone permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.microphone.start()).rejects.toThrow(CapabilityError);
      await expect(client.microphone.stop()).rejects.toThrow(CapabilityError);
      await expect(client.microphone.record({ durationSec: 5 })).rejects.toThrow(
        CapabilityError,
      );
    });

    it("executes recording via hardwareHandler when authorized", async () => {
      const client = createSevynClient({
        permissions: ["microphone"],
        hardwareHandler: {
          microphone: {
            record: vi
              .fn()
              .mockResolvedValue({ uri: "sevyn://audio.wav", durationSec: 3 }),
          },
        },
      });

      const result = await client.microphone.record({ durationSec: 3 });
      expect(result.uri).toBe("sevyn://audio.wav");
    });
  });

  describe("sevyn.bluetooth", () => {
    it("requires bluetooth permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.bluetooth.scan()).rejects.toThrow(CapabilityError);
      await expect(client.bluetooth.isEnabled()).rejects.toThrow(CapabilityError);
      await expect(client.bluetooth.requestEnable()).rejects.toThrow(CapabilityError);
    });

    it("scans and reports devices when authorized", async () => {
      const client = createSevynClient({
        permissions: ["bluetooth"],
        hardwareHandler: {
          bluetooth: {
            scan: vi
              .fn()
              .mockResolvedValue([
                { id: "bt-1", name: "Sevyn Earphones", connected: true },
              ]),
            isEnabled: vi.fn().mockResolvedValue(true),
          },
        },
      });

      expect(await client.bluetooth.isEnabled()).toBe(true);
      const devices = await client.bluetooth.scan();
      expect(devices).toHaveLength(1);
      expect(devices[0]?.name).toBe("Sevyn Earphones");
    });
  });

  describe("sevyn.location / sevyn.geolocation", () => {
    it("requires location permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.location.getCurrentPosition()).rejects.toThrow(CapabilityError);
      await expect(client.geolocation.getCurrentPosition()).rejects.toThrow(
        CapabilityError,
      );
    });

    it("retrieves position when location is granted", async () => {
      const client = createSevynClient({
        permissions: ["location"],
        hardwareHandler: {
          location: {
            getCurrentPosition: vi.fn().mockResolvedValue({
              coords: { latitude: 37.7749, longitude: -122.4194 },
              timestamp: 1700000000,
            }),
          },
        },
      });

      const pos = await client.geolocation.getCurrentPosition();
      expect(pos.coords.latitude).toBeCloseTo(37.7749);
    });
  });

  describe("sevyn.sensors", () => {
    it("requires sensors permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.sensors.read("accelerometer")).rejects.toThrow(CapabilityError);
      await expect(client.sensors.list()).rejects.toThrow(CapabilityError);
      expect(() => client.sensors.subscribe("accelerometer", () => undefined)).toThrow(
        CapabilityError,
      );
    });

    it("reads sensor readings with normalized SI units when authorized", async () => {
      const client = createSevynClient({
        permissions: ["sensors"],
        hardwareHandler: {
          sensors: {
            read: vi.fn().mockResolvedValue({
              sensor: "accelerometer",
              timestamp: Date.now(),
              values: { x: 0, y: 9.81, z: 0 },
              unit: "m/s^2",
            }),
            list: vi
              .fn()
              .mockResolvedValue(["accelerometer", "gyroscope", "ambientLight"]),
          },
        },
      });

      const reading = await client.sensors.read("accelerometer");
      expect(reading.values).toEqual({ x: 0, y: 9.81, z: 0 });
      expect(reading.unit).toBe("m/s^2");
      expect(await client.sensors.list()).toContain("gyroscope");
    });

    it("subscribes to sensor stream with sampling rate options", () => {
      const unsubscribe = vi.fn();
      const mockSubscribe = vi.fn().mockReturnValue(unsubscribe);
      const client = createSevynClient({
        permissions: ["sensors"],
        hardwareHandler: {
          sensors: {
            subscribe: mockSubscribe,
          },
        },
      });

      const listener = vi.fn();
      const unsub = client.sensors.subscribe("ambientLight", listener, {
        samplingRateHz: 20,
      });

      expect(mockSubscribe).toHaveBeenCalledWith("ambientLight", listener, {
        samplingRateHz: 20,
      });
      unsub();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe("sevyn.biometrics", () => {
    it("requires biometrics permission for all operations", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.biometrics.authenticate("Unlock")).rejects.toThrow(
        CapabilityError,
      );
      await expect(client.biometrics.isAvailable()).rejects.toThrow(CapabilityError);
      await expect(client.biometrics.getEnrolledType()).rejects.toThrow(CapabilityError);
      await expect(client.biometrics.enroll("fingerprint")).rejects.toThrow(
        CapabilityError,
      );
      await expect(
        client.biometrics.deleteEnrolled("fingerprint", "fp-1"),
      ).rejects.toThrow(CapabilityError);
      await expect(client.biometrics.listEnrolled()).rejects.toThrow(CapabilityError);
      await expect(client.biometrics.verifyPin("1234")).rejects.toThrow(CapabilityError);
      await expect(
        client.biometrics.keystore.setKey("vault-token", "secret"),
      ).rejects.toThrow(CapabilityError);
      await expect(client.biometrics.keystore.getKey("vault-token")).rejects.toThrow(
        CapabilityError,
      );
      await expect(client.biometrics.keystore.deleteKey("vault-token")).rejects.toThrow(
        CapabilityError,
      );
      await expect(client.biometrics.keystore.listKeys()).rejects.toThrow(
        CapabilityError,
      );
    });

    it("authenticates via biometrics when authorized", async () => {
      const client = createSevynClient({
        permissions: ["biometrics"],
        hardwareHandler: {
          biometrics: {
            authenticate: vi
              .fn()
              .mockResolvedValue({ success: true, type: "fingerprint" }),
            isAvailable: vi.fn().mockResolvedValue(true),
            getEnrolledType: vi.fn().mockResolvedValue("fingerprint"),
          },
        },
      });

      expect(await client.biometrics.isAvailable()).toBe(true);
      expect(await client.biometrics.getEnrolledType()).toBe("fingerprint");
      const auth = await client.biometrics.authenticate();
      expect(auth.success).toBe(true);
    });

    it("supports enrollment, PIN fallback, and keystore operations when authorized", async () => {
      const mockEnroll = vi.fn().mockResolvedValue({
        success: true,
        credential: {
          id: "fp-1",
          type: "fingerprint",
          label: "Right Index",
          enrolledAt: 1700000000,
        },
      });
      const mockList = vi.fn().mockResolvedValue([
        {
          id: "fp-1",
          type: "fingerprint",
          label: "Right Index",
          enrolledAt: 1700000000,
        },
      ]);
      const mockDelete = vi.fn().mockResolvedValue({ success: true });
      const mockVerifyPin = vi
        .fn()
        .mockImplementation((pin: string) => Promise.resolve(pin === "4321"));

      const client = createSevynClient({
        permissions: ["biometrics"],
        hardwareHandler: {
          biometrics: {
            enroll: mockEnroll,
            listEnrolled: mockList,
            deleteEnrolled: mockDelete,
            verifyPin: mockVerifyPin,
          },
        },
      });

      const enrollRes = await client.biometrics.enroll("fingerprint", "Right Index");
      expect(enrollRes.success).toBe(true);
      expect(enrollRes.credential?.label).toBe("Right Index");

      const enrolled = await client.biometrics.listEnrolled();
      expect(enrolled).toHaveLength(1);

      const delRes = await client.biometrics.deleteEnrolled("fingerprint", "fp-1");
      expect(delRes.success).toBe(true);

      expect(await client.biometrics.verifyPin("4321")).toBe(true);
      expect(await client.biometrics.verifyPin("0000")).toBe(false);

      // Default client-side biometric keystore
      await client.biometrics.keystore.setKey("session-key", "top-secret-val");
      expect(await client.biometrics.keystore.getKey("session-key")).toBe(
        "top-secret-val",
      );
      expect(await client.biometrics.keystore.listKeys()).toContain("session-key");
      expect(await client.biometrics.keystore.deleteKey("session-key")).toBe(true);
      expect(await client.biometrics.keystore.getKey("session-key")).toBeNull();
    });
  });

  describe("sevyn.media", () => {
    it("requires media permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.media.play("track.mp3")).rejects.toThrow(CapabilityError);
      await expect(client.media.pause()).rejects.toThrow(CapabilityError);
      await expect(client.media.status()).rejects.toThrow(CapabilityError);
      await expect(client.media.scan()).rejects.toThrow(CapabilityError);
    });

    it("controls playback and queries library when authorized", async () => {
      const client = createSevynClient({
        permissions: ["media"],
        hardwareHandler: {
          media: {
            play: vi.fn().mockResolvedValue(undefined),
            status: vi.fn().mockResolvedValue({
              isPlaying: true,
              isPaused: false,
              positionSec: 42,
              durationSec: 180,
              volume: 80,
            }),
            scan: vi.fn().mockResolvedValue([
              {
                id: "t1",
                title: "Genesis Horizon",
                artist: "Sevyn",
                durationSec: 180,
                source: "/music/track.flac",
              },
            ]),
          },
        },
      });

      await expect(client.media.play("/music/track.flac")).resolves.toBeUndefined();
      const status = await client.media.status();
      expect(status.isPlaying).toBe(true);
      expect(status.positionSec).toBe(42);
      const tracks = await client.media.scan();
      expect(tracks).toHaveLength(1);
    });
  });

  describe("sevyn.battery", () => {
    it("requires battery permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.battery.getStatus()).rejects.toThrow(CapabilityError);
      expect(() => client.battery.onStatusChange(() => undefined)).toThrow(
        CapabilityError,
      );
    });

    it("returns battery status when authorized", async () => {
      const client = createSevynClient({
        permissions: ["battery"],
        hardwareHandler: {
          battery: {
            getStatus: vi.fn().mockResolvedValue({
              available: true,
              percent: 88,
              charging: true,
              state: "charging",
            }),
          },
        },
      });

      const bat = await client.battery.getStatus();
      expect(bat.percent).toBe(88);
      expect(bat.charging).toBe(true);
    });
  });

  describe("sevyn.display", () => {
    it("requires display permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.display.getBrightness()).rejects.toThrow(CapabilityError);
      await expect(client.display.setBrightness(0.5)).rejects.toThrow(CapabilityError);
      await expect(client.display.getAutoBrightness()).rejects.toThrow(CapabilityError);
      await expect(client.display.setAutoBrightness(true)).rejects.toThrow(
        CapabilityError,
      );
      await expect(client.display.getOrientation()).rejects.toThrow(CapabilityError);
      await expect(client.display.lockOrientation("landscape-left")).rejects.toThrow(
        CapabilityError,
      );
      expect(() => client.display.onOrientationChange(() => undefined)).toThrow(
        CapabilityError,
      );
      await expect(client.display.acquireWakeLock()).rejects.toThrow(CapabilityError);
    });

    it("controls brightness, orientation lock, and wake lock when authorized", async () => {
      const releaseLock = vi.fn();
      const client = createSevynClient({
        permissions: ["display"],
        hardwareHandler: {
          display: {
            getBrightness: vi.fn().mockResolvedValue(0.75),
            setBrightness: vi.fn().mockResolvedValue(undefined),
            acquireWakeLock: vi.fn().mockResolvedValue(releaseLock),
          },
        },
      });

      expect(await client.display.getBrightness()).toBe(0.75);
      await expect(client.display.setBrightness(0.9)).resolves.toBeUndefined();

      // Auto-brightness
      expect(await client.display.getAutoBrightness()).toBe(false);
      await client.display.setAutoBrightness(true);
      expect(await client.display.getAutoBrightness()).toBe(true);

      // Orientation & listeners
      expect(await client.display.getOrientation()).toBe("portrait");
      const orientationSpy = vi.fn();
      const unsubOrientation = client.display.onOrientationChange(orientationSpy);
      await client.display.lockOrientation("landscape-left");
      expect(await client.display.getOrientation()).toBe("landscape-left");
      expect(orientationSpy).toHaveBeenCalledWith("landscape-left");
      unsubOrientation();

      // Wake lock
      const release = await client.display.acquireWakeLock();
      expect(typeof release).toBe("function");
    });

    it("tracks wake lock status with default client tracker", async () => {
      const client = createSevynClient({
        permissions: ["display"],
      });

      expect(client.display.isWakeLocked()).toBe(false);
      const release1 = await client.display.acquireWakeLock();
      expect(client.display.isWakeLocked()).toBe(true);
      const release2 = await client.display.acquireWakeLock();
      expect(client.display.isWakeLocked()).toBe(true);

      release1();
      expect(client.display.isWakeLocked()).toBe(true);
      release2();
      expect(client.display.isWakeLocked()).toBe(false);
    });
  });

  describe("sevyn.audio", () => {
    it("requires audio permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.audio.getOutputs()).rejects.toThrow(CapabilityError);
      await expect(client.audio.setOutput("headphones")).rejects.toThrow(CapabilityError);
      await expect(client.audio.getVolume()).rejects.toThrow(CapabilityError);
      await expect(client.audio.setVolume(50)).rejects.toThrow(CapabilityError);
    });

    it("enumerates sinks and controls volume when authorized", async () => {
      const client = createSevynClient({
        permissions: ["audio"],
        hardwareHandler: {
          audio: {
            getOutputs: vi.fn().mockResolvedValue([
              { id: "sink-1", name: "Speakers", isDefault: true, type: "speaker" },
              { id: "sink-2", name: "Headphones", isDefault: false, type: "headphones" },
            ]),
            getVolume: vi.fn().mockResolvedValue(65),
          },
        },
      });

      const outputs = await client.audio.getOutputs();
      expect(outputs).toHaveLength(2);
      expect(await client.audio.getVolume()).toBe(65);
    });
  });

  describe("sevyn.vibration / sevyn.haptics", () => {
    it("requires vibration permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.vibration.vibrate(200)).rejects.toThrow(CapabilityError);
      await expect(client.haptics.vibrate(200)).rejects.toThrow(CapabilityError);
      await expect(client.vibration.cancel()).rejects.toThrow(CapabilityError);
    });

    it("triggers haptic vibration when authorized", async () => {
      const client = createSevynClient({
        permissions: ["vibration"],
        hardwareHandler: {
          vibration: {
            vibrate: vi.fn().mockResolvedValue(undefined),
            cancel: vi.fn().mockResolvedValue(undefined),
          },
        },
      });

      await expect(client.haptics.vibrate([100, 50, 100])).resolves.toBeUndefined();
      await expect(client.vibration.cancel()).resolves.toBeUndefined();
    });
  });

  describe("sevyn.nfc", () => {
    it("requires nfc permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.nfc.isAvailable()).rejects.toThrow(CapabilityError);
      await expect(client.nfc.scan()).rejects.toThrow(CapabilityError);
      await expect(client.nfc.write("tag")).rejects.toThrow(CapabilityError);
    });

    it("scans NFC tags when authorized", async () => {
      const client = createSevynClient({
        permissions: ["nfc"],
        hardwareHandler: {
          nfc: {
            isAvailable: vi.fn().mockResolvedValue(true),
            scan: vi.fn().mockResolvedValue({
              id: "nfc-tag-01",
              standard: "NFC-A",
              payload: "https://sevynos.org",
            }),
          },
        },
      });

      expect(await client.nfc.isAvailable()).toBe(true);
      const tag = await client.nfc.scan();
      expect(tag.payload).toBe("https://sevynos.org");
    });
  });

  describe("sevyn.cellular", () => {
    it("requires cellular permission", async () => {
      const client = createSevynClient({ permissions: [] });
      await expect(client.cellular.getModemStatus()).rejects.toThrow(CapabilityError);
      await expect(client.cellular.getSignal()).rejects.toThrow(CapabilityError);
      await expect(client.cellular.getBearer()).rejects.toThrow(CapabilityError);
      await expect(client.cellular.dial("5550199")).rejects.toThrow(CapabilityError);
      await expect(client.cellular.answer()).rejects.toThrow(CapabilityError);
      await expect(client.cellular.hangup()).rejects.toThrow(CapabilityError);
      await expect(client.cellular.sendSms("5550199", "Hello")).rejects.toThrow(
        CapabilityError,
      );
      await expect(client.cellular.listSms()).rejects.toThrow(CapabilityError);
    });

    it("interacts with cellular modem and SMS when authorized", async () => {
      const client = createSevynClient({
        permissions: ["cellular"],
        hardwareHandler: {
          cellular: {
            getModemStatus: vi.fn().mockResolvedValue({
              available: true,
              state: "registered",
              simPresent: true,
              operatorName: "Sevyn Mobile",
            }),
            getSignal: vi.fn().mockResolvedValue({ signalPercent: 92, technology: "5G" }),
            dial: vi.fn().mockResolvedValue({
              callId: "call-1",
              number: "5550199",
              state: "dialing",
            }),
            sendSms: vi.fn().mockResolvedValue({ messageId: "msg-1", sent: true }),
            listSms: vi.fn().mockResolvedValue([
              {
                id: "sms-1",
                sender: "+15551234",
                timestamp: Date.now(),
                text: "Welcome to Sevyn",
                unread: false,
              },
            ]),
          },
        },
      });

      const modem = await client.cellular.getModemStatus();
      expect(modem.available).toBe(true);
      expect(modem.operatorName).toBe("Sevyn Mobile");

      const signal = await client.cellular.getSignal();
      expect(signal.technology).toBe("5G");

      const call = await client.cellular.dial("5550199");
      expect(call.state).toBe("dialing");

      const sms = await client.cellular.sendSms("5550199", "Hello");
      expect(sms.sent).toBe(true);

      const messages = await client.cellular.listSms();
      expect(messages).toHaveLength(1);
    });

    it("returns graceful unavailable modem status on non-cellular devices", async () => {
      const client = createSevynClient({ permissions: ["cellular"] });
      const modem = await client.cellular.getModemStatus();
      expect(modem.available).toBe(false);
      await expect(client.cellular.dial("5550199")).rejects.toThrow(
        HardwareUnavailableError,
      );
    });
  });

  describe("sevyn.storage", () => {
    it("stores, retrieves, and removes isolated key-value entries", async () => {
      const client = createSevynClient();

      expect(await client.storage.get("theme")).toBeUndefined();
      await client.storage.set("theme", "dark");
      expect(await client.storage.get("theme")).toBe("dark");

      await client.storage.remove("theme");
      expect(await client.storage.get("theme")).toBeUndefined();
    });

    it("enforces storage quotas", async () => {
      const client = createSevynClient({
        storageQuotaBytes: 50,
      });

      await client.storage.set("key", "short value");
      await expect(client.storage.set("overflow", "x".repeat(60))).rejects.toThrow(
        StorageQuotaError,
      );
    });
  });

  describe("sevyn.events", () => {
    it("delivers messages across pub/sub channels", async () => {
      const client = createSevynClient();
      const messages: unknown[] = [];

      const unsubscribe = client.events.on("custom:ping", (payload) => {
        messages.push(payload);
      });

      client.events.emit("custom:ping", { value: 42 });
      await client.events.send("custom:ping", { value: 43 });

      expect(messages).toEqual([{ value: 42 }, { value: 43 }]);

      unsubscribe();
      client.events.emit("custom:ping", { value: 44 });
      expect(messages).toHaveLength(2);
    });
  });

  describe("sevyn.windows", () => {
    it("routes window operations to handler", async () => {
      const actions: string[] = [];
      const client = createSevynClient({
        windowHandler: {
          setTitle: (title) => actions.push(`title:${title}`),
          minimize: () => actions.push("minimize"),
          close: () => actions.push("close"),
        },
      });

      await client.windows.setTitle("Document 1");
      await client.windows.minimize();
      await client.windows.close();

      expect(actions).toEqual(["title:Document 1", "minimize", "close"]);
    });
  });
});
