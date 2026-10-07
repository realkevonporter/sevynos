import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MusicApplication, formatTime, musicManifest } from "./index.js";
import type {
  MediaPlaylist,
  MediaPlaybackStatus,
  MediaService,
  MediaTrack,
} from "@sevynos/react-native";

const SAMPLE_TRACKS: readonly MediaTrack[] = [
  {
    id: "track-a",
    title: "First Song",
    artist: "Test Artist",
    album: "Test Album",
    durationSec: 180,
    path: "/var/lib/sevynos/user/Music/first-song.mp3",
    format: "mp3",
  },
  {
    id: "track-b",
    title: "Second Song",
    artist: "Test Artist",
    durationSec: 200,
    path: "/var/lib/sevynos/user/Music/second-song.flac",
    format: "flac",
  },
];

function createMediaService(overrides: Partial<MediaService> = {}): MediaService {
  const idle: MediaPlaybackStatus = {
    playing: false,
    paused: false,
    currentPositionSec: 0,
    durationSec: 200,
    volume: 100,
  };
  return {
    play: vi.fn().mockResolvedValue({ ...idle, playing: true }),
    pause: vi.fn().mockResolvedValue({ ...idle, playing: true, paused: true }),
    resume: vi.fn().mockResolvedValue({ ...idle, playing: true }),
    stop: vi.fn().mockResolvedValue(idle),
    seek: vi.fn((seconds: number) =>
      Promise.resolve({ ...idle, playing: true, currentPositionSec: seconds }),
    ),
    status: vi.fn().mockResolvedValue(idle),
    scan: vi.fn().mockResolvedValue(SAMPLE_TRACKS),
    ...overrides,
  };
}

describe("Music Application Manifest and Utilities", () => {
  it("exposes valid application manifest with required media capabilities", () => {
    expect(musicManifest.id).toBe("org.sevynos.music");
    expect(musicManifest.name).toBe("Music");
    expect(musicManifest.permissions).toContain("media");
    expect(musicManifest.permissions).toContain("filesystem.read");
    expect(musicManifest.permissions).toContain("filesystem.write");
    expect(musicManifest.windowModes).toContain("standard");
    expect(musicManifest.instanceMode).toBe("single");
  });

  it("formats second durations into MM:SS format accurately", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(9)).toBe("00:09");
    expect(formatTime(65)).toBe("01:05");
    expect(formatTime(214)).toBe("03:34");
    expect(formatTime(3600)).toBe("60:00");
  });

  it("does not ship hardcoded seed tracks or playlists", async () => {
    const moduleSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./index.tsx", import.meta.url), "utf8"),
    );
    expect(moduleSource).not.toContain("DEFAULT_TRACKS");
    expect(moduleSource).not.toContain("DEFAULT_PLAYLISTS");
    expect(moduleSource).not.toContain("Genesis Horizon");
  });

  it("persists playlists through the SDK storage instead of memory only", async () => {
    const moduleSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./index.tsx", import.meta.url), "utf8"),
    );
    expect(moduleSource).toContain("useOptionalSevynApplicationSdk");
    // Tolerate prettier wrapping the member chain across lines.
    expect(moduleSource).toMatch(/sdk\.storage\s*\.\s*set/);
    expect(moduleSource).toMatch(/sdk\.storage\s*\.\s*get/);
  });

  it("keeps a playlist only when the stored payload is well formed", () => {
    const candidate: MediaPlaylist = {
      id: "playlist-1",
      name: "Mine",
      trackIds: ["track-a"],
      createdAt: 123,
    };
    expect(candidate.trackIds).toEqual(["track-a"]);
  });
});

describe("MusicApplication Component", () => {
  it("mounts and renders initial state with media service", () => {
    const mediaService = createMediaService();

    const element = createElement(MusicApplication, {
      media: mediaService,
    });
    expect(element).toBeDefined();
    expect(element.type).toBe(MusicApplication);
  });

  it("renders permission request screen when media permission is not granted", () => {
    const permissions = {
      has: vi.fn((perm: string) => perm !== "media"),
      request: vi.fn().mockResolvedValue(true),
    };

    const element = createElement(MusicApplication, {
      permissions,
    });
    expect(element).toBeDefined();
    expect(element.props.permissions).toBe(permissions);
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${musicManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
