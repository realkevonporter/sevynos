import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAYLISTS,
  DEFAULT_TRACKS,
  MusicApplication,
  formatTime,
  musicManifest,
} from "./index.js";
import type { MediaPlaybackStatus, MediaService } from "@sevynos/react-native";

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

  it("includes default high-fidelity tracks covering mp3, ogg, flac, wav, and m4a formats", () => {
    expect(DEFAULT_TRACKS.length).toBeGreaterThanOrEqual(5);
    const formats = new Set(DEFAULT_TRACKS.map((t) => t.format.toLowerCase()));
    expect(formats.has("flac")).toBe(true);
    expect(formats.has("mp3")).toBe(true);
    expect(formats.has("ogg")).toBe(true);
    expect(formats.has("wav")).toBe(true);
    expect(formats.has("m4a")).toBe(true);
  });

  it("provides initial default playlists", () => {
    expect(DEFAULT_PLAYLISTS.length).toBeGreaterThanOrEqual(2);
    const names = DEFAULT_PLAYLISTS.map((p) => p.name);
    expect(names).toContain("Favorites");
    expect(names).toContain("Focus & Flow");
  });
});

describe("MusicApplication Component", () => {
  it("mounts and renders initial state with media service", () => {
    const mediaService: MediaService = {
      play: vi.fn().mockResolvedValue({
        playing: true,
        paused: false,
        currentPositionSec: 0,
        durationSec: 214,
        volume: 100,
      } satisfies MediaPlaybackStatus),
      pause: vi.fn().mockResolvedValue({
        playing: true,
        paused: true,
        currentPositionSec: 10,
        durationSec: 214,
        volume: 100,
      } satisfies MediaPlaybackStatus),
      resume: vi.fn().mockResolvedValue({
        playing: true,
        paused: false,
        currentPositionSec: 10,
        durationSec: 214,
        volume: 100,
      } satisfies MediaPlaybackStatus),
      stop: vi.fn().mockResolvedValue({
        playing: false,
        paused: false,
        currentPositionSec: 0,
        durationSec: 214,
        volume: 100,
      } satisfies MediaPlaybackStatus),
      seek: vi.fn((seconds: number) =>
        Promise.resolve({
          playing: true,
          paused: false,
          currentPositionSec: seconds,
          durationSec: 214,
          volume: 100,
        } satisfies MediaPlaybackStatus),
      ),
      status: vi.fn().mockResolvedValue({
        playing: false,
        paused: false,
        currentPositionSec: 0,
        durationSec: 214,
        volume: 100,
      } satisfies MediaPlaybackStatus),
      scan: vi.fn().mockResolvedValue(DEFAULT_TRACKS),
    };

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
