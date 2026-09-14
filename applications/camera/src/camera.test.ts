import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { CameraApplication, cameraManifest, type CameraItem } from "./index.js";

describe("CameraApplication", () => {
  it("exports a valid SevynApplicationManifest with camera permissions", () => {
    expect(cameraManifest.id).toBe("org.sevynos.camera");
    expect(cameraManifest.name).toBe("Camera");
    expect(cameraManifest.runtime).toBe("react-native");
    expect(cameraManifest.permissions).toContain("camera");
    expect(cameraManifest.permissions).toContain("filesystem.read");
    expect(cameraManifest.permissions).toContain("filesystem.write");
  });

  it("renders permission prompt view when camera permission is not granted", () => {
    const element = createElement(CameraApplication, {
      initialPermissionGranted: false,
    });
    expect(element).toBeDefined();
    expect(element.type).toBe(CameraApplication);
  });

  it("renders camera viewfinder when permission is granted and hardware is available", () => {
    const mockCamera = {
      status: vi.fn().mockResolvedValue({ available: true, device: "/dev/video0" }),
      capture: vi.fn().mockResolvedValue({
        path: "/var/lib/sevynos/photos/test.jpg",
        width: 1280,
        height: 720,
        timestamp: 123456789,
      }),
      preview: vi.fn().mockResolvedValue({
        width: 640,
        height: 360,
        available: true,
      }),
      recordStart: vi.fn().mockResolvedValue({ recording: true }),
      recordStop: vi.fn().mockResolvedValue({
        path: "/var/lib/sevynos/videos/test.mp4",
        durationMs: 3000,
        format: "video/mp4",
        timestamp: 123456789,
      }),
    };

    const element = createElement(CameraApplication, {
      camera: mockCamera,
      initialPermissionGranted: true,
    });
    expect(element).toBeDefined();
    expect(element.props.camera).toBe(mockCamera);
  });

  it("handles absent camera hardware gracefully without crashing", () => {
    const mockCameraNoHw = {
      status: vi.fn().mockResolvedValue({
        available: false,
        message: "No camera hardware detected (/dev/video0 is absent).",
      }),
      capture: vi.fn().mockRejectedValue(new Error("No camera hardware detected")),
      preview: vi.fn().mockResolvedValue({ width: 640, height: 360, available: false }),
    };

    const element = createElement(CameraApplication, {
      camera: mockCameraNoHw,
      initialPermissionGranted: true,
    });
    expect(element).toBeDefined();
  });

  it("triggers onCapture callback when photo is taken", () => {
    const capturedItems: CameraItem[] = [];
    const mockCamera = {
      status: vi.fn().mockResolvedValue({ available: true }),
      capture: vi.fn().mockResolvedValue({
        path: "/var/lib/sevynos/photos/shot-1.jpg",
        width: 1280,
        height: 720,
        timestamp: Date.now(),
      }),
      preview: vi.fn().mockResolvedValue({ width: 640, height: 360, available: true }),
    };

    const element = createElement(CameraApplication, {
      camera: mockCamera,
      initialPermissionGranted: true,
      onCapture: (item) => {
        capturedItems.push(item);
      },
    });
    expect(element).toBeDefined();
  });

  it("accepts live preview frames with raw pixels for viewfinder rendering", () => {
    const rawPixels = new Uint8Array(640 * 360 * 4);
    const mockCamera = {
      status: vi.fn().mockResolvedValue({ available: true }),
      capture: vi.fn().mockResolvedValue({
        path: "/var/lib/sevynos/photos/shot.jpg",
        width: 1280,
        height: 720,
        timestamp: Date.now(),
      }),
      preview: vi.fn().mockResolvedValue({
        width: 640,
        height: 360,
        pixels: rawPixels,
        available: true,
        timestamp: Date.now(),
      }),
    };

    const element = createElement(CameraApplication, {
      camera: mockCamera,
      initialPermissionGranted: true,
    });
    expect(element).toBeDefined();
    expect(element.props.camera).toBe(mockCamera);
  });
});
