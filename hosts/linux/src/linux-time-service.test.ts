import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:dgram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxTimeService, parseNtpOffsetMs } from "./linux-time-service.js";

const NTP_EPOCH_OFFSET_SECONDS = 2208988800;

function unixMsToNtpParts(unixMs: number): { seconds: number; fraction: number } {
  const totalSeconds = unixMs / 1000 + NTP_EPOCH_OFFSET_SECONDS;
  const seconds = Math.floor(totalSeconds);
  const fraction = Math.round((totalSeconds - seconds) * 2 ** 32);
  return { seconds, fraction };
}

function buildNtpResponse(t2: number, t3: number): Buffer {
  const packet = Buffer.alloc(48);
  packet[0] = 0x1c;
  const r = unixMsToNtpParts(t2);
  const x = unixMsToNtpParts(t3);
  packet.writeUInt32BE(r.seconds, 32);
  packet.writeUInt32BE(r.fraction, 36);
  packet.writeUInt32BE(x.seconds, 40);
  packet.writeUInt32BE(x.fraction, 44);
  return packet;
}

class FakeSocket extends EventEmitter {
  public sent: { host: string; port: number }[] = [];
  public closed = false;

  public send(
    _msg: Buffer,
    port: number,
    host: string,
    callback?: (error: Error | null) => void,
  ): void {
    this.sent.push({ host, port });
    callback?.(null);
  }

  public close(): void {
    this.closed = true;
  }
}

function createHarness(
  options: {
    responseDelayMs?: number;
    failHosts?: readonly string[];
    nowValue?: number;
  } = {},
): {
  service: LinuxTimeService;
  sockets: FakeSocket[];
  setTimeCalls: number[];
} {
  const sockets: FakeSocket[] = [];
  const setTimeCalls: number[] = [];
  let nowValue = options.nowValue ?? 1_000_000;
  const failHosts = new Set(options.failHosts ?? []);
  const respond = (socket: FakeSocket, host: string): void => {
    if (failHosts.has(host)) {
      socket.emit("error", new Error("unreachable"));
      return;
    }
    const t2 = nowValue + 5000;
    const t3 = nowValue + 5010;
    setTimeout(() => {
      nowValue += options.responseDelayMs ?? 20;
      socket.emit("message", buildNtpResponse(t2, t3));
    }, 0);
  };
  const service = new LinuxTimeService({
    autoStart: false,
    ntpTimeoutMs: 200,
    resyncIntervalMs: 60_000,
    createUdpSocket: () => {
      const socket = new FakeSocket();
      const originalSend = socket.send.bind(socket);
      socket.send = (
        msg: Buffer,
        port: number,
        host: string,
        callback?: (error: Error | null) => void,
      ): void => {
        originalSend(msg, port, host, callback);
        setTimeout(() => {
          respond(socket, host);
        }, 0);
      };
      sockets.push(socket);
      return socket as unknown as Socket;
    },
    setSystemTime: (epochMs: number) => {
      setTimeCalls.push(epochMs);
      return Promise.resolve();
    },
    now: () => nowValue,
    ntpHosts: ["ntp-a.example", "ntp-b.example"],
  });
  return { service, sockets, setTimeCalls };
}

describe("parseNtpOffsetMs", () => {
  it("computes the four-timestamp NTP offset", () => {
    const t1 = 1_000_000;
    const t4 = 1_000_020;
    const packet = buildNtpResponse(1_005_000, 1_005_010);
    expect(parseNtpOffsetMs(packet, t1, t4)).toBeCloseTo(4995, 0);
  });

  it("rejects truncated packets", () => {
    expect(() => parseNtpOffsetMs(Buffer.alloc(10), 0, 0)).toThrow(
      "Truncated NTP response.",
    );
  });
});

describe("LinuxTimeService", () => {
  let tempDir: string;
  const services: LinuxTimeService[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-time-test-"));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("syncs the clock from the first reachable NTP host", async () => {
    const { service, sockets, setTimeCalls } = createHarness();
    services.push(service);
    const state = await service.syncNow();
    expect(sockets).toHaveLength(1);
    const firstSocket = sockets[0];
    expect(firstSocket).toBeDefined();
    expect(firstSocket?.sent[0]).toMatchObject({ host: "ntp-a.example", port: 123 });
    expect(firstSocket?.closed).toBe(true);
    expect(setTimeCalls).toHaveLength(1);
    // Server is ~5s ahead; the clock is set forward by the measured offset.
    const setTime = setTimeCalls[0];
    expect(setTime).toBeGreaterThan(1_004_000);
    expect(setTime).toBeLessThan(1_006_000);
    expect(state.syncing).toBe(false);
    expect(state.error).toBeUndefined();
    expect(state.lastSyncAt).toBeDefined();
    expect(state.offsetMs).toBeDefined();
  });

  it("falls through to the next host when the first fails", async () => {
    const { service, sockets } = createHarness({ failHosts: ["ntp-a.example"] });
    services.push(service);
    const state = await service.syncNow();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.sent[0]).toMatchObject({ host: "ntp-b.example" });
    expect(state.error).toBeUndefined();
    expect(state.lastSyncAt).toBeDefined();
  });

  it("records an error when every host fails", async () => {
    const { service } = createHarness({ failHosts: ["ntp-a.example", "ntp-b.example"] });
    services.push(service);
    const state = await service.syncNow();
    expect(state.syncing).toBe(false);
    expect(state.error).toBeDefined();
    expect(state.lastSyncAt).toBeUndefined();
  });

  it("deduplicates concurrent syncNow calls", async () => {
    const { service, sockets } = createHarness({ responseDelayMs: 30 });
    services.push(service);
    const [a, b] = await Promise.all([service.syncNow(), service.syncNow()]);
    expect(sockets).toHaveLength(1);
    expect(a.lastSyncAt).toBe(b.lastSyncAt);
  });

  it("notifies subscribers on state changes", async () => {
    const { service } = createHarness();
    services.push(service);
    let notifications = 0;
    const unsubscribe = service.subscribe(() => {
      notifications += 1;
    });
    await service.syncNow();
    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
  });

  it("sets and persists a valid timezone", async () => {
    const zoneinfoDir = join(tempDir, "zoneinfo", "America");
    await mkdir(zoneinfoDir, { recursive: true });
    await writeFile(join(zoneinfoDir, "New_York"), "fake-tzdata");
    const service = new LinuxTimeService({
      autoStart: false,
      timezoneFile: join(tempDir, "timezone"),
      localtimePath: join(tempDir, "localtime"),
      zoneinfoDir: join(tempDir, "zoneinfo"),
      createUdpSocket: () => new FakeSocket() as unknown as Socket,
      setSystemTime: () => Promise.resolve(),
    });
    services.push(service);
    const state = await service.setTimezone("America/New_York");
    expect(state.timezone).toBe("America/New_York");
    const snapshot = await service.snapshot();
    expect(snapshot.timezone).toBe("America/New_York");
  });

  it("rejects malformed and unknown timezones", async () => {
    const service = new LinuxTimeService({
      autoStart: false,
      timezoneFile: join(tempDir, "timezone"),
      localtimePath: join(tempDir, "localtime"),
      zoneinfoDir: join(tempDir, "zoneinfo"),
      createUdpSocket: () => new FakeSocket() as unknown as Socket,
      setSystemTime: () => Promise.resolve(),
    });
    services.push(service);
    await expect(service.setTimezone("../etc/passwd")).rejects.toThrow(
      "Invalid timezone",
    );
    await expect(service.setTimezone("Mars/Olympus_Mons")).rejects.toThrow(
      "Unknown timezone",
    );
  });
});
