import { describe, expect, it } from "vitest";
import {
  LinuxWirelessNetworkService,
  parseNetworkId,
  parseSavedNetworks,
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
      controlSocketAccessible: () => Promise.resolve(true),
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
      controlSocketAccessible: () => Promise.resolve(true),
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

  it("saves the network configuration after a successful connection", async () => {
    const requests: LinuxCommandRequest[] = [];
    let connected = false;
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      if (request.executable.endsWith("udhcpc"))
        return Promise.resolve({ stdout: "lease acquired", stderr: "" });
      const operation = request.arguments[4];
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
      controlSocketAccessible: () => Promise.resolve(true),
    });

    await service.scan();
    await service.connect("Sevyn Home", "test-password");
    expect(requests.some((request) => request.arguments.includes("save_config"))).toBe(
      true,
    );
  });

  it("removes the network when connection fails", async () => {
    const requests: LinuxCommandRequest[] = [];
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      const operation = request.arguments[4];
      if (operation === "status")
        return Promise.resolve({ stdout: "wpa_state=DISCONNECTED\n", stderr: "" });
      if (operation === "scan_results")
        return Promise.resolve({ stdout: scanOutput, stderr: "" });
      if (operation === "add_network")
        return Promise.resolve({ stdout: "5\n", stderr: "" });
      // Simulate connection timeout: never reaches COMPLETED
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    await service.scan();
    const result = await service.connect("Sevyn Home", "wrong-password");
    expect(result.state).toBe("failed");
    expect(
      requests.some(
        (request) =>
          request.arguments.includes("remove_network") && request.arguments.includes("5"),
      ),
    ).toBe(true);
  });

  it("parses saved network listings", () => {
    expect(
      parseSavedNetworks(
        [
          "network id / ssid / bssid / flags",
          "0\tSevyn Home\tany\t[CURRENT]",
          "1\tCoffee Shop\tany\t",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({
        networkId: "0",
        ssid: "Sevyn Home",
        bssid: "any",
        flags: "[CURRENT]",
      }),
      expect.objectContaining({ networkId: "1", ssid: "Coffee Shop" }),
    ]);
    expect(parseSavedNetworks("network id / ssid / bssid / flags\n")).toEqual([]);
  });

  it("lists and forgets saved networks", async () => {
    const requests: LinuxCommandRequest[] = [];
    const listOutput = [
      "network id / ssid / bssid / flags",
      "0\tSevyn Home\tany\t[CURRENT]",
      "1\tCoffee Shop\tany\t",
    ].join("\n");
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      if (request.arguments[4] === "list_networks")
        return Promise.resolve({ stdout: listOutput, stderr: "" });
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    const saved = await service.savedNetworks();
    expect(saved).toEqual([
      expect.objectContaining({ networkId: "0", ssid: "Sevyn Home" }),
      expect.objectContaining({ networkId: "1", ssid: "Coffee Shop" }),
    ]);
    expect(requests.some((request) => request.arguments.includes("list_networks"))).toBe(
      true,
    );

    await service.forgetNetwork("1");
    expect(
      requests.some(
        (request) =>
          request.arguments.includes("remove_network") && request.arguments.includes("1"),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.arguments.includes("save_config"))).toBe(
      true,
    );
    await expect(service.forgetNetwork("bogus")).rejects.toThrow();
  });

  it("reconnects to the strongest in-range saved network", async () => {
    const requests: LinuxCommandRequest[] = [];
    let connected = false;
    const listOutput = [
      "network id / ssid / bssid / flags",
      "0\tSevyn Home\tany\t",
      "1\tCoffee Shop\tany\t",
    ].join("\n");
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      if (request.executable.endsWith("udhcpc"))
        return Promise.resolve({ stdout: "lease acquired", stderr: "" });
      const operation = request.arguments[4];
      if (operation === "status")
        return Promise.resolve({
          stdout: connected
            ? "wpa_state=COMPLETED\nssid=Sevyn Home\n"
            : "wpa_state=DISCONNECTED\n",
          stderr: "",
        });
      if (operation === "list_networks")
        return Promise.resolve({ stdout: listOutput, stderr: "" });
      if (operation === "scan_results")
        return Promise.resolve({ stdout: scanOutput, stderr: "" });
      if (operation === "select_network") connected = true;
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    await expect(service.reconnectToSavedNetwork()).resolves.toBe(true);
    // Sevyn Home scans stronger (-42 dBm) than Coffee Shop (-68 dBm).
    expect(
      requests.some(
        (request) =>
          request.arguments.includes("select_network") && request.arguments.includes("0"),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.executable.endsWith("udhcpc"))).toBe(true);
  });

  it("skips reconnect when no saved network is in range", async () => {
    const requests: LinuxCommandRequest[] = [];
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      const operation = request.arguments[4];
      if (operation === "status")
        return Promise.resolve({ stdout: "wpa_state=DISCONNECTED\n", stderr: "" });
      if (operation === "list_networks")
        return Promise.resolve({
          stdout: "network id / ssid / bssid / flags\n0\tFar Away\tany\t\n",
          stderr: "",
        });
      if (operation === "scan_results")
        return Promise.resolve({ stdout: scanOutput, stderr: "" });
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    await expect(service.reconnectToSavedNetwork()).resolves.toBe(false);
    expect(requests.some((request) => request.arguments.includes("select_network"))).toBe(
      false,
    );
  });

  it("treats an already-associated interface as reconnected", async () => {
    const requests: LinuxCommandRequest[] = [];
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      if (request.executable.endsWith("udhcpc"))
        return Promise.resolve({ stdout: "lease acquired", stderr: "" });
      if (request.arguments[4] === "status")
        return Promise.resolve({
          stdout: "wpa_state=COMPLETED\nssid=Sevyn Home\n",
          stderr: "",
        });
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    await expect(service.reconnectToSavedNetwork()).resolves.toBe(true);
    expect(requests.some((request) => request.executable.endsWith("udhcpc"))).toBe(true);
  });

  it("never throws from reconnect when the adapter is missing", async () => {
    const requests: LinuxCommandRequest[] = [];
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve([]),
      execute: (request) => {
        requests.push(request);
        return Promise.resolve({ stdout: "", stderr: "" });
      },
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    await expect(service.reconnectToSavedNetwork()).resolves.toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("disconnects from the current network", async () => {
    const requests: LinuxCommandRequest[] = [];
    let connected = true;
    const execute: LinuxCommandExecutor = (request) => {
      requests.push(request);
      const operation = request.arguments[4];
      if (operation === "status")
        return Promise.resolve({
          stdout: connected
            ? "wpa_state=COMPLETED\nssid=Sevyn Home\n"
            : "wpa_state=DISCONNECTED\n",
          stderr: "",
        });
      if (operation === "scan_results")
        return Promise.resolve({ stdout: scanOutput, stderr: "" });
      if (operation === "disconnect") connected = false;
      return Promise.resolve({ stdout: "OK\n", stderr: "" });
    };
    const service = new LinuxWirelessNetworkService({
      discoverInterfaces: () => Promise.resolve(["wlan0"]),
      execute,
      delay: () => Promise.resolve(),
      controlSocketAccessible: () => Promise.resolve(true),
    });

    const result = await service.disconnect();
    expect(result.state).toBe("disconnected");
    expect(requests.some((request) => request.arguments.includes("disconnect"))).toBe(
      true,
    );
  });
});
