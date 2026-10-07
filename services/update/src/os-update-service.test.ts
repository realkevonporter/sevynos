import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OsUpdateService,
  resolveCurrentVersion,
  type OsUpdateServiceOptions,
} from "./os-update-service.js";
import { parseUpdateFeed } from "./update-feed.js";
import { signFeedManifest, type TrustedUpdateKey } from "./feed-signing.js";

const PAYLOAD = Buffer.from("fake-squashfs-payload");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

// Test trust anchor: every fixture feed is signed with this key, and the
// service under test trusts its public half — the enforced path.
const TEST_KEY_ID = "test-key";
const { publicKey: testPublicKey, privateKey: testPrivateKey } =
  generateKeyPairSync("ed25519");
const TEST_TRUSTED_KEYS: TrustedUpdateKey[] = [
  {
    keyId: TEST_KEY_ID,
    publicKeyJwk: testPublicKey.export({ format: "jwk" }),
  },
];
const TEST_PRIVATE_JWK = testPrivateKey.export({ format: "jwk" });

function feedJson(version = "0.1.0-nightly.20261007.abc1234"): string {
  const unsigned = JSON.stringify({
    version,
    publishedAt: "2026-10-07T10:00:00.000Z",
    releaseNotes: "Nightly build.",
    artifacts: [
      {
        kind: "rootfs-squashfs",
        url: "https://example.com/rootfs.squashfs",
        sha256: PAYLOAD_SHA,
        sizeBytes: PAYLOAD.byteLength,
      },
    ],
  });
  const signed = signFeedManifest(
    parseUpdateFeed(unsigned),
    TEST_KEY_ID,
    TEST_PRIVATE_JWK,
  );
  return JSON.stringify(signed);
}

function stubFetch(
  routes: Record<string, { status: number; body: string | Uint8Array }>,
): typeof fetch {
  const impl = (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (route === undefined)
      return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(route.body, { status: route.status }));
  };
  return impl;
}

const FEED_URL = "https://example.com/updates.json";

function options(
  stateDirectory: string,
  overrides: Partial<OsUpdateServiceOptions> = {},
): OsUpdateServiceOptions {
  return {
    currentVersion: "0.1.0",
    feedUrl: FEED_URL,
    stateDirectory,
    trustedKeys: TEST_TRUSTED_KEYS,
    fetchImpl: stubFetch({
      [FEED_URL]: { status: 200, body: feedJson() },
      "https://example.com/rootfs.squashfs": { status: 200, body: PAYLOAD },
    }),
    autoCheckDelayMs: 60_000,
    ...overrides,
  };
}

describe("OsUpdateService", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sevyn-update-test-"));
    dirs.push(dir);
    return dir;
  }

  it("rejects a non-https feed URL and an invalid current version", () => {
    expect(
      () =>
        new OsUpdateService({
          currentVersion: "0.1.0",
          feedUrl: "http://example.com/updates.json",
          stateDirectory: "/tmp",
        }),
    ).toThrow("https");
    expect(
      () =>
        new OsUpdateService({
          currentVersion: "bogus",
          feedUrl: FEED_URL,
          stateDirectory: "/tmp",
        }),
    ).toThrow();
  });

  it("reports an available update when the feed is newer", async () => {
    const service = new OsUpdateService(options(await tempDir()));
    const result = await service.checkNow();
    expect(result.status).toBe("update-available");
    expect(result.latestVersion).toBe("0.1.0-nightly.20261007.abc1234");
    expect(result.artifact?.kind).toBe("rootfs-squashfs");
    expect(service.status).toBe("update-available");
    service.dispose();
  });

  it("reports up-to-date when versions match", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(
      options(dir, {
        currentVersion: "0.1.0-nightly.20261007.abc1234",
        fetchImpl: stubFetch({
          [FEED_URL]: { status: 200, body: feedJson("0.1.0-nightly.20261007.abc1234") },
        }),
      }),
    );
    const result = await service.checkNow();
    expect(result.status).toBe("up-to-date");
    service.dispose();
  });

  it("surfaces feed errors without throwing", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(
      options(dir, {
        fetchImpl: stubFetch({ [FEED_URL]: { status: 500, body: "boom" } }),
      }),
    );
    const result = await service.checkNow();
    expect(result.status).toBe("error");
    expect(result.error).toContain("500");
    service.dispose();
  });

  it("surfaces an invalid feed body as an error", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(
      options(dir, {
        fetchImpl: stubFetch({ [FEED_URL]: { status: 200, body: "{oops" } }),
      }),
    );
    const result = await service.checkNow();
    expect(result.status).toBe("error");
    expect(result.error).toContain("not valid JSON");
    service.dispose();
  });

  function unsignedFeedJson(): string {
    return JSON.stringify({
      version: "0.1.0-nightly.20261007.abc1234",
      publishedAt: "2026-10-07T10:00:00.000Z",
      releaseNotes: "Nightly build.",
      artifacts: [
        {
          kind: "rootfs-squashfs",
          url: "https://example.com/rootfs.squashfs",
          sha256: PAYLOAD_SHA,
          sizeBytes: PAYLOAD.byteLength,
        },
      ],
    });
  }

  it("refuses an unsigned feed with a clear error", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(
      options(dir, {
        fetchImpl: stubFetch({ [FEED_URL]: { status: 200, body: unsignedFeedJson() } }),
      }),
    );
    const result = await service.checkNow();
    expect(result.status).toBe("error");
    expect(result.error).toContain("not signed");
    expect(service.status).toBe("error");
    service.dispose();
  });

  it("refuses a feed signed by an untrusted key", async () => {
    const { privateKey: roguePrivate } = generateKeyPairSync("ed25519");
    const rogueSigned = JSON.stringify(
      signFeedManifest(
        parseUpdateFeed(unsignedFeedJson()),
        "rogue-key",
        roguePrivate.export({ format: "jwk" }),
      ),
    );
    const dir = await tempDir();
    const service = new OsUpdateService(
      options(dir, {
        fetchImpl: stubFetch({ [FEED_URL]: { status: 200, body: rogueSigned } }),
      }),
    );
    const result = await service.checkNow();
    expect(result.status).toBe("error");
    expect(result.error).toContain("no signature from a trusted key");
    service.dispose();
  });

  it("fails closed when no trusted keys are configured", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(
      options(dir, {
        trustedKeys: [],
        fetchImpl: stubFetch({ [FEED_URL]: { status: 200, body: feedJson() } }),
      }),
    );
    const result = await service.checkNow();
    expect(result.status).toBe("error");
    expect(result.error).toContain("no trusted update keys");
    service.dispose();
  });

  it("downloads, verifies, and stages the payload with progress", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(options(dir));
    await service.checkNow();
    const seen: { received: number; total: number }[] = [];
    const staged = await service.downloadUpdate((received, total) => {
      seen.push({ received, total });
    });
    expect(staged.version).toBe("0.1.0-nightly.20261007.abc1234");
    expect(await readFile(staged.path)).toEqual(PAYLOAD);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({
      received: PAYLOAD.byteLength,
      total: PAYLOAD.byteLength,
    });
    expect(service.status).toBe("downloaded");
    service.dispose();
  });

  it("rejects a download whose bytes do not match the feed hash", async () => {
    const dir = await tempDir();
    const tampered = Buffer.from("tampered-payload!");
    const service = new OsUpdateService(
      options(dir, {
        fetchImpl: stubFetch({
          [FEED_URL]: { status: 200, body: feedJson() },
          "https://example.com/rootfs.squashfs": { status: 200, body: tampered },
        }),
      }),
    );
    await service.checkNow();
    await expect(service.downloadUpdate()).rejects.toThrow("sha256");
    expect(service.status).toBe("error");
    service.dispose();
  });

  it("refuses to download before a check found an update", async () => {
    const service = new OsUpdateService(options(await tempDir()));
    await expect(service.downloadUpdate()).rejects.toThrow("Check for updates");
    service.dispose();
  });

  it("applyUpdate writes a pending record the boot applier can consume", async () => {
    const dir = await tempDir();
    const service = new OsUpdateService(options(dir));
    await service.checkNow();
    const staged = await service.downloadUpdate();
    await service.applyUpdate(staged);
    expect(service.status).toBe("pending-reboot");
    const pending = await service.pendingUpdate();
    expect(pending?.version).toBe(staged.version);
    expect(pending?.payloadPath).toBe(staged.path);
    expect(pending?.sha256).toBe(PAYLOAD_SHA);
    const onDisk = JSON.parse(
      await readFile(join(dir, "updates", "pending.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk["version"]).toBe(staged.version);
    await service.clearPendingUpdate();
    expect(await service.pendingUpdate()).toBeUndefined();
    service.dispose();
  });

  it("notifies subscribers on status changes", async () => {
    const service = new OsUpdateService(options(await tempDir()));
    const seen: string[] = [];
    const unsubscribe = service.subscribe(() => {
      seen.push(service.status);
    });
    await service.checkNow();
    expect(seen).toContain("checking");
    expect(seen).toContain("update-available");
    unsubscribe();
    service.dispose();
  });
});

describe("resolveCurrentVersion", () => {
  it("prefers /etc/sevynos-release, then the environment, then a dev fallback", async () => {
    await expect(
      resolveCurrentVersion(() =>
        Promise.resolve('VERSION_ID="0.1.0-nightly.20261007"\n'),
      ),
    ).resolves.toBe("0.1.0-nightly.20261007");
    await expect(
      resolveCurrentVersion(() => Promise.reject(new Error("no file"))),
    ).resolves.toBe(process.env["SEVYN_OS_VERSION"] ?? "0.0.0-dev");
  });
});
