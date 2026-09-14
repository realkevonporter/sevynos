import { describe, expect, it } from "vitest";
import {
  LinuxWirelessNetworkService,
  parseNetworkId,
  parseScanResults,
  type LinuxCommandExecutor,
  type LinuxCommandRequest,
} from "./linux-wireless-network-service.js";

const scanOutput = [
  "bssid / frequency / signal level / flags / ssid",
  "00:11:22:33:44:55\t2412\t-42\t[WPA2-PSK-CCMP][ESS]\tSevyn Home",
  "00:11:22:33:44:66\t5180\t-70\t[WPA2-PSK-CCMP][ESS]\tSevyn Home",
  "00:11:22:33:44:77\t2437\t-68\t[ESS]\tCoffee Shop",
  "00:11:22:33:44:88\t5200\t-55\t[WPA2-EAP-CCMP][ESS]\tOffice",
].join("\n");

describe("LinuxWirelessNetworkService", () => {
  it("accepts the interface banner printed before a new network id", () => {
    expect(parseNetworkId("Selected interface 'wlan0'\n0\n")).toBe("0");
  });
  it("parses, classifies, de-duplicates, and sorts scan results", () => {
    expect(parseScanResults(scanOutput, "Sevyn Home")).toEqual([
      expect.objectContaining({
        ssid: "Sevyn Home",
        signal: 100,
        security: "personal",
        supported: true,
        connected: true,
      }),
      expect.objectContaining({
        ssid: "Office",
        signal: 90,
        security: "enterprise",
        supported: false,
      }),
      expect.objectContaining({
        ssid: "Coffee Shop",
        signal: 64,
        security: "open",
        requiresPassword: false,
      }),
    ]);
  });

  it("reports unavailable without invoking system commands", async () => {
    const requests: LinuxCommandRequest[] = [];
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve([]),
      execute: (request) => {
        requests.push(request);
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    });

    await expect(service.snapshot()).resolves.toMatchObject({
      available: false,
      state: "unavailable",
    });
    expect(requests).toHaveLength(0);
  });

  it("scans and connects without placing the password in process arguments", async () => {
    const requests: LinuxCommandRequest[] = [];
    let connected = false;
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      if (request.executable.endsWith("udhcpc"))
        return Promise.resolve({ stdout: "lease acquired", stderr: "" });
      const operation = request.arguments[4];
      if (operation === undefined && request.input !== undefined)
        return Promise.resolve({ stdout: "> OK\n> OK\n", stderr: "" });
      if (operation === "status")
        return Promise.resolve({
          stdout: connected
            ? "wpa_state=COMPLETED\nssid=Sevyn Home\nip_address=192.168.1.20\n"
            : "wpa_state=DISCONNECTED\n",
          stderr: "",
        });
      if (operation === "scan_results")
        return Promise.resolve({ stdout: scanOutput, stderr: "" });
      if (operation === "add_network")
        return Promise.resolve({ stdout: "0\n", stderr: "" });
      if (operation === "select_network") connected = true;
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
    });

    const scanned = await service.scan();
    expect(scanned.networks.map((network) => network.ssid)).toContain("Sevyn Home");
    const result = await service.connect("Sevyn Home", "not-a-real-password");
    expect(result).toMatchObject({
      state: "connected",
      connectedSsid: "Sevyn Home",
      ipAddress: "192.168.1.20",
    });
    expect(
      requests.some((request) => request.arguments.includes("not-a-real-password")),
    ).toBe(false);
    expect(
      requests.some((request) => request.input?.includes("not-a-real-password") === true),
    ).toBe(true);
  });

  it("powers the physical adapter on and off through rfkill and ip", async () => {
    const requests: LinuxCommandRequest[] = [];
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute: (request) => {
        requests.push(request);
        if (request.arguments.includes("status"))
          return Promise.resolve({ stdout: "wpa_state=DISCONNECTED\n", stderr: "" });
        if (request.arguments.includes("scan_results"))
          return Promise.resolve({ stdout: "", stderr: "" });
        return Promise.resolve({ stdout: "OK\n", stderr: "" });
      },
      delay: () => Promise.resolve(),
    });

    await expect(service.setEnabled(false)).resolves.toMatchObject({
      available: true,
      enabled: false,
    });
    await expect(service.setEnabled(true)).resolves.toMatchObject({ enabled: true });
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executable: "/usr/sbin/rfkill",
          arguments: ["block", "wifi"],
        }),
        expect.objectContaining({
          executable: "/sbin/ip",
          arguments: ["link", "set", "wlan0", "up"],
        }),
      ]),
    );
  });
});
