import { describe, expect, it } from "vitest";
import {
  APP_CATALOG_FEED_FORMAT,
  defaultAppCatalogFeedUrl,
  parseAppCatalogFeed,
} from "./app-catalog-feed.js";

const VALID_FEED = JSON.stringify({
  format: "sevynos-app-catalog/1",
  generatedAt: "2026-10-07T12:00:00.000Z",
  apps: [
    {
      id: "org.example.notes",
      name: "Notes",
      version: "1.2.0",
      summary: "Take notes, organised in folders.",
      developer: "Example",
      bundleUrl: "https://example.com/notes-1.2.0.sevyn",
      sha256: "a".repeat(64),
      sizeBytes: 123456,
      permissions: ["filesystem:user"],
    },
    {
      id: "org.example.clock",
      name: "Clock",
      version: "0.9.0",
      summary: "Alarms and timers.",
      bundleUrl: "https://example.com/clock-0.9.0.sevyn",
      sha256: "B".repeat(64),
      sizeBytes: 654321,
      permissions: [],
    },
  ],
});

describe("parseAppCatalogFeed", () => {
  it("parses a valid feed and normalises sha256 to lowercase", () => {
    const feed = parseAppCatalogFeed(VALID_FEED);
    expect(feed.format).toBe(APP_CATALOG_FEED_FORMAT);
    expect(feed.apps).toHaveLength(2);
    expect(feed.apps[0]?.id).toBe("org.example.notes");
    expect(feed.apps[0]?.developer).toBe("Example");
    expect(feed.apps[1]?.sha256).toBe("b".repeat(64));
    expect(feed.apps[1]?.permissions).toEqual([]);
    expect(feed.signature).toBeUndefined();
  });

  it("accepts an empty app list (honest empty catalog)", () => {
    const feed = parseAppCatalogFeed(
      JSON.stringify({
        format: "sevynos-app-catalog/1",
        generatedAt: "2026-10-07T12:00:00.000Z",
        apps: [],
      }),
    );
    expect(feed.apps).toEqual([]);
  });

  it("carries a Phase 3 signature field through without verifying it", () => {
    const feed = parseAppCatalogFeed(
      JSON.stringify({
        format: "sevynos-app-catalog/1",
        generatedAt: "2026-10-07T12:00:00.000Z",
        apps: [],
        signature: { algorithm: "ed25519", value: "not-a-real-signature" },
      }),
    );
    expect(feed.signature).toEqual({
      algorithm: "ed25519",
      value: "not-a-real-signature",
    });
  });

  it("rejects a wrong format marker", () => {
    expect(() =>
      parseAppCatalogFeed(
        JSON.stringify({
          format: "something-else/9",
          generatedAt: "2026-10-07T12:00:00.000Z",
          apps: [],
        }),
      ),
    ).toThrow(/format/);
  });

  it("rejects non-https bundle URLs", () => {
    const tampered = JSON.parse(VALID_FEED) as {
      apps: Record<string, unknown>[];
    };
    const first = tampered.apps[0];
    if (first !== undefined) first["bundleUrl"] = "http://example.com/notes.sevyn";
    expect(() => parseAppCatalogFeed(JSON.stringify(tampered))).toThrow(/https/);
  });

  it("rejects malformed sha256 digests", () => {
    const tampered = JSON.parse(VALID_FEED) as {
      apps: Record<string, unknown>[];
    };
    const first = tampered.apps[0];
    if (first !== undefined) first["sha256"] = "zzz";
    expect(() => parseAppCatalogFeed(JSON.stringify(tampered))).toThrow(/sha256/);
  });

  it("rejects duplicate app ids", () => {
    const tampered = JSON.parse(VALID_FEED) as {
      apps: Record<string, unknown>[];
    };
    const first = tampered.apps[0];
    if (first !== undefined) tampered.apps.push({ ...first });
    expect(() => parseAppCatalogFeed(JSON.stringify(tampered))).toThrow(/duplicate/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseAppCatalogFeed("not json")).toThrow(/not valid JSON/);
  });
});

describe("defaultAppCatalogFeedUrl", () => {
  it("returns a real https URL next to the OS update feed", () => {
    const url = defaultAppCatalogFeedUrl();
    expect(url.startsWith("https://")).toBe(true);
    expect(url.endsWith("app-catalog.json")).toBe(true);
  });
});
