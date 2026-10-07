import { describe, expect, it } from "vitest";
import { parseUpdateFeed, selectRootfsArtifact } from "./update-feed.js";

const SHA = "a".repeat(64);

function feed(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "0.1.0-nightly.20261007.abc1234",
    publishedAt: "2026-10-07T10:00:00.000Z",
    releaseNotes: "Nightly build.",
    artifacts: [
      {
        kind: "rootfs-squashfs",
        url: "https://github.com/realkevonporter/sevynos/releases/download/nightly/rootfs.squashfs",
        sha256: SHA,
        sizeBytes: 123456,
      },
      {
        kind: "iso",
        url: "https://github.com/realkevonporter/sevynos/releases/download/nightly/sevynos-live.iso",
        sha256: "b".repeat(64),
        sizeBytes: 234567,
      },
    ],
    ...overrides,
  });
}

describe("parseUpdateFeed", () => {
  it("parses a valid feed", () => {
    const manifest = parseUpdateFeed(feed());
    expect(manifest.version).toBe("0.1.0-nightly.20261007.abc1234");
    expect(manifest.artifacts).toHaveLength(2);
    expect(selectRootfsArtifact(manifest)?.url).toContain("rootfs.squashfs");
  });

  it("rejects malformed feeds with descriptive errors", () => {
    expect(() => parseUpdateFeed("not json")).toThrow("not valid JSON");
    expect(() => parseUpdateFeed(feed({ version: 42 }))).toThrow('"version"');
    expect(() => parseUpdateFeed(feed({ publishedAt: "yesterday" }))).toThrow(
      '"publishedAt"',
    );
    expect(() => parseUpdateFeed(feed({ artifacts: [] }))).toThrow('"artifacts"');
    expect(() =>
      parseUpdateFeed(
        feed({
          artifacts: [
            {
              kind: "rootfs-squashfs",
              url: "http://insecure/x",
              sha256: SHA,
              sizeBytes: 1,
            },
          ],
        }),
      ),
    ).toThrow("https");
    expect(() =>
      parseUpdateFeed(
        feed({
          artifacts: [
            {
              kind: "rootfs-squashfs",
              url: "https://example.com/x",
              sha256: "xyz",
              sizeBytes: 1,
            },
          ],
        }),
      ),
    ).toThrow("sha256");
    expect(() =>
      parseUpdateFeed(
        feed({
          artifacts: [
            {
              kind: "tarball",
              url: "https://example.com/x",
              sha256: SHA,
              sizeBytes: 1,
            },
          ],
        }),
      ),
    ).toThrow("kind");
  });

  it("returns undefined when no rootfs artifact exists", () => {
    const manifest = parseUpdateFeed(
      feed({
        artifacts: [
          {
            kind: "iso",
            url: "https://example.com/sevynos-live.iso",
            sha256: SHA,
            sizeBytes: 10,
          },
        ],
      }),
    );
    expect(selectRootfsArtifact(manifest)).toBeUndefined();
  });

  it("parses a signed feed and carries the signatures through", () => {
    const manifest = parseUpdateFeed(feed({ signatures: { nightly: "aGVsbG8=" } }));
    expect(manifest.signatures).toEqual({ nightly: "aGVsbG8=" });
  });

  it("rejects malformed signatures", () => {
    expect(() => parseUpdateFeed(feed({ signatures: "nope" }))).toThrow('"signatures"');
    expect(() => parseUpdateFeed(feed({ signatures: { nightly: "" } }))).toThrow(
      '"signatures"',
    );
    expect(() => parseUpdateFeed(feed({ signatures: { nightly: "!!!" } }))).toThrow(
      '"signatures"',
    );
  });
});
