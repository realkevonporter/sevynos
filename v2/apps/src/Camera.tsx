// SevynOS v2 — the Camera system app.
//
// Thin UI over camd, the native V4L2 daemon (PR 1), through
// `sevyn camera` (cli.exec permission). No Chromium anywhere in
// this path: the preview is a PNG camd writes, the shutter is a
// real JPEG straight from the sensor, and the gallery reads the
// same /data/photos store Photos counts (App.tsx countPhotos()).
//
//   camera view  — live preview (polls `sevyn camera preview`,
//                  one frame a second — the shell has no push
//                  channel for frames, so the app polls; the
//                  interval is created in useEffect and cleared on
//                  unmount/view change, the same pattern as the
//                  video-frame pump in applications/camera),
//                  shutter saves to /data/photos.
//   gallery      — the photos in /data/photos, newest first.
//   viewer       — one photo full-size (`sevyn camera decode`
//                  renders the JPEG to a PNG the shell can draw).
//
// First use: the bundle manifest declares the `camera`
// permission, and the app itself asks once more on first launch —
// an Allow screen whose grant is recorded as
// /data/camera/.consent (the same persist-via-files precedent as
// Notes). Declining still leaves the gallery usable. There is no
// delete here: `sevyn files` has no delete verb (follow-up with
// the File Explorer delete path).
//
// Reads happen synchronously on mount (the established v2/apps
// pattern — Files/Notes/Comms all read in useState initializers);
// the preview poll and the shutter/decode are async (a frame grab
// can take ~a second on first stream start, and a sync exec would
// freeze the UI — the M9 wifi precedent).

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { WindowButtons, useWindowActive } from "./window-buttons";
import { tokens } from "../../rn/renderer/tokens";
import { runCli, runCliAsync } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";

const PHOTOS_DIR = "/data/photos";
const CAMERA_DIR = "/data/camera";
const CONSENT_FILE = ".consent";
const PREVIEW_POLL_MS = 1000;

type Photo = { name: string; path: string };
type ViewMode = "camera" | "gallery" | "viewer";
type CamStatus = {
  available: boolean;
  device: string | null;
  message: string;
};

function parseJson(out: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function isImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".webp")
  );
}

function readStatus(): CamStatus {
  let code: number;
  let out: string;
  try {
    ({ code, out } = runCli("sevyn camera status"));
  } catch (e) {
    // A throw here used to blank the whole window: the reconciler
    // swallows a first-render throw and mounts an empty tree (the
    // GF65 blank Camera — the poll never ran because mount never
    // finished). Degrade to the honest no-camera state instead, and
    // log the throw so the host log names it.
    Sevyn.log(
      "CAMERA status read failed: " + (e instanceof Error ? e.message : String(e)),
    );
    return {
      available: false,
      device: null,
      message: "Could not reach the camera daemon.",
    };
  }
  if (code !== 0)
    return {
      available: false,
      device: null,
      message: out.trim() || "Could not reach the camera daemon.",
    };
  const data = parseJson(out);
  if (data === null)
    return {
      available: false,
      device: null,
      message: "Camera daemon sent an invalid reply.",
    };
  if (data["ok"] === false)
    return {
      available: false,
      device: null,
      message:
        typeof data["error"] === "string"
          ? data["error"]
          : "Camera daemon rejected the command.",
    };
  return {
    available: data["available"] === true,
    device: typeof data["device"] === "string" ? data["device"] : null,
    message:
      data["available"] === true
        ? ""
        : "No usable Video4Linux capture device was detected.",
  };
}

function readPhotos(): Photo[] {
  let code: number;
  let out: string;
  try {
    ({ code, out } = runCli("sevyn files list " + PHOTOS_DIR));
  } catch (e) {
    // See readStatus: a throw at mount used to blank the window.
    // An empty gallery is the safe degradation — the app still paints.
    Sevyn.log(
      "CAMERA photos read failed: " + (e instanceof Error ? e.message : String(e)),
    );
    return [];
  }
  if (code !== 0) return [];
  const photos: Photo[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("f ")) continue;
    const name = line.slice(2);
    if (isImageName(name)) photos.push({ name, path: PHOTOS_DIR + "/" + name });
  }
  // `sevyn files list` prints in directory order; newest first is
  // what a gallery wants — camera-*.jpg names carry a millisecond
  // timestamp, so a reverse sort is newest first.
  photos.sort((a, b) => (a.name < b.name ? 1 : -1));
  return photos;
}

function readConsent(): boolean {
  let code: number;
  let out: string;
  try {
    ({ code, out } = runCli("sevyn files list " + CAMERA_DIR));
  } catch (e) {
    // See readStatus: a throw at mount used to blank the window.
    // No consent is the safe degradation — the app shows the Allow
    // screen instead of nothing.
    Sevyn.log(
      "CAMERA consent read failed: " + (e instanceof Error ? e.message : String(e)),
    );
    return false;
  }
  if (code !== 0) return false;
  for (const line of out.split("\n")) {
    if (line === "f " + CONSENT_FILE) return true;
  }
  return false;
}

function previewSize(): { width: number; height: number } {
  const width = Math.max(320, (Sevyn.width || 800) - 32);
  return { width, height: Math.round((width * 9) / 16) };
}

export function Camera(): React.ReactElement {
  const color = Sevyn.appColor;
  // Polish surface (b): the title bar dims when the window loses
  // keyboard focus. header() below closes over this.
  const windowActive = useWindowActive();
  const permitted = Sevyn.hasPermission("camera");
  const [consent, setConsent] = React.useState<boolean>(() => readConsent());
  const [status, setStatus] = React.useState<CamStatus>(() => readStatus());
  const [photos, setPhotos] = React.useState<Photo[]>(() => readPhotos());
  const [view, setView] = React.useState<ViewMode>("camera");
  const [previewPng, setPreviewPng] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string>("");
  const [capturing, setCapturing] = React.useState<boolean>(false);
  const [saved, setSaved] = React.useState<string>("");
  const [selected, setSelected] = React.useState<Photo | null>(null);
  const [viewerPng, setViewerPng] = React.useState<string | null>(null);
  const [viewerDims, setViewerDims] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewerState, setViewerState] = React.useState<string>("");
  const pollRef = React.useRef<boolean>(false);

  async function fetchPreview(): Promise<void> {
    if (pollRef.current) return;
    pollRef.current = true;
    try {
      const { code, out } = await runCliAsync("sevyn camera preview");
      if (code !== 0) {
        setPreviewError(out.trim() || "Preview failed.");
        return;
      }
      const data = parseJson(out);
      if (data === null || data["ok"] !== true) {
        setPreviewError("Preview failed.");
        return;
      }
      if (data["available"] !== true) {
        setPreviewError("No camera available.");
        return;
      }
      if (typeof data["png"] === "string") {
        setPreviewPng(data["png"]);
        setPreviewError("");
      }
    } finally {
      pollRef.current = false;
    }
  }

  // Live preview: one frame a second while the camera view is up.
  // (The shell has no push channel for frames, so the app polls —
  // the interval is cleared on unmount/view change.)
  React.useEffect(() => {
    if (view !== "camera" || !consent || !permitted || !status.available)
      return undefined;
    void fetchPreview();
    const timer = setInterval(() => {
      void fetchPreview();
    }, PREVIEW_POLL_MS);
    return () => {
      clearInterval(timer);
    };
    // fetchPreview is stable by construction (no deps); the effect
    // re-runs only when the view/consent/permission/status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, consent, permitted, status.available]);

  async function capture(): Promise<void> {
    if (capturing || !status.available) return;
    setCapturing(true);
    setSaved("");
    try {
      const name = "camera-" + String(Date.now()) + ".jpg";
      const { code, out } = await runCliAsync(
        "sevyn camera capture " + PHOTOS_DIR + "/" + name,
      );
      if (code !== 0) {
        setPreviewError(out.trim() || "Capture failed.");
        return;
      }
      const data = parseJson(out);
      if (data === null || data["ok"] !== true) {
        setPreviewError("Capture failed.");
        return;
      }
      const path =
        typeof data["path"] === "string" ? data["path"] : PHOTOS_DIR + "/" + name;
      Sevyn.log("CAMERA capture " + path);
      setPhotos(readPhotos());
      setSaved("Saved to Photos");
      void fetchPreview();
    } finally {
      setCapturing(false);
    }
  }

  async function openViewer(photo: Photo): Promise<void> {
    setSelected(photo);
    setViewerPng(null);
    setViewerDims(null);
    setViewerState("Loading…");
    setView("viewer");
    const rgba = CAMERA_DIR + "/view-" + String(Date.now()) + ".rgba";
    const { code, out } = await runCliAsync(
      "sevyn camera decode " + photo.path + " " + rgba,
    );
    if (code !== 0) {
      setViewerState(out.trim() || "Could not open this photo.");
      return;
    }
    const data = parseJson(out);
    if (data === null || data["available"] !== true) {
      setViewerState("Could not open this photo.");
      return;
    }
    if (typeof data["png"] === "string") {
      setViewerPng(data["png"]);
      if (typeof data["width"] === "number" && typeof data["height"] === "number")
        setViewerDims({
          width: data["width"],
          height: data["height"],
        });
      setViewerState("");
      Sevyn.log("CAMERA view " + photo.path);
    } else {
      setViewerState("Could not open this photo.");
    }
  }

  function grantConsent(): void {
    const { code } = runCli(
      "sevyn files write " + CAMERA_DIR + "/" + CONSENT_FILE + " granted",
    );
    if (code === 0) {
      setConsent(true);
      Sevyn.log("CAMERA consent granted");
    }
  }

  function retryStatus(): void {
    const next = readStatus();
    setStatus(next);
    Sevyn.log("CAMERA status available=" + (next.available ? "yes" : "no"));
  }

  const size = previewSize();

  function header(title: string): React.ReactElement {
    return (
      <View
        style={{
          flexDirection: "row",
          height: tokens.window.titleBarHeight,
          backgroundColor: color,
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 12,
        }}
      >
        <Image
          source={appIconTitlePath("camera")}
          style={{ width: 20, height: 20, marginRight: 8 }}
        />
        <Text
          style={{
            fontSize: 16,
            fontWeight: "bold",
            color: windowActive ? "#ffffff" : tokens.color.dark.textSecondary,
            flex: 1,
          }}
        >
          {title}
        </Text>
        <WindowButtons />
        <Pressable
          onPress={() => {
            Sevyn.closeApp();
          }}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Image source={symbolPath("close")} style={{ width: 16, height: 16 }} />
        </Pressable>
      </View>
    );
  }

  function button(
    label: string,
    onPress: () => void,
    opts?: { primary?: boolean; disabled?: boolean },
  ): React.ReactElement {
    return (
      <Pressable
        onPress={opts?.disabled ? undefined : onPress}
        style={{
          backgroundColor: opts?.primary ? color : "#e5e7eb",
          borderRadius: 10,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 10,
          paddingBottom: 10,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: opts?.primary ? "#ffffff" : "#111827",
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  function centeredNote(title: string, body: string): React.ReactElement {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        <Text
          style={{
            fontSize: 18,
            fontWeight: "bold",
            color: "#111827",
            textAlign: "center",
          }}
        >
          {title}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: "#6b7280",
            textAlign: "center",
            marginTop: 8,
          }}
        >
          {body}
        </Text>
      </View>
    );
  }

  let body: React.ReactElement;
  if (!permitted) {
    body = (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Camera")}
        {centeredNote(
          "Camera permission is not granted",
          "This app needs the camera permission in its manifest to open the camera.",
        )}
      </View>
    );
  } else if (!consent) {
    body = (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Camera")}
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            paddingLeft: 24,
            paddingRight: 24,
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: "bold", color: "#111827" }}>
            Allow Camera to use your camera?
          </Text>
          <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
            The preview and the shutter use this device&apos;s camera through the system
            camera service. Photos you take are saved on this device, in Photos.
          </Text>
          <View style={{ flexDirection: "row", marginTop: 20 }}>
            <View style={{ marginRight: 12 }}>
              {button("Allow camera", grantConsent, { primary: true })}
            </View>
            {button("Not now", () => setView("gallery"))}
          </View>
        </View>
      </View>
    );
  } else if (view === "gallery") {
    body = (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Photos")}
        <ScrollView
          style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 12 }}
        >
          {photos.length === 0 ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 24 }}>
              No photos yet. Take one with the camera and it will appear here.
            </Text>
          ) : (
            photos.map((photo) => (
              <Pressable
                key={photo.path}
                onPress={() => {
                  void openViewer(photo);
                }}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: 12,
                  paddingLeft: 16,
                  paddingRight: 16,
                  paddingTop: 12,
                  paddingBottom: 12,
                  marginBottom: 8,
                }}
              >
                <Text style={{ fontSize: 15, color: "#111827" }}>{photo.name}</Text>
                <Text style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {photo.path}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 12,
            paddingBottom: 16,
          }}
        >
          {button("Back to camera", () => setView("camera"), { primary: true })}
        </View>
      </View>
    );
  } else if (view === "viewer" && selected !== null) {
    // Fit the decoded photo to the window width, keeping its aspect
    // (test photos are not all 16:9 — a fixed 9/16 box would stretch
    // them).
    const viewerSize =
      viewerDims !== null && viewerDims.width > 0
        ? {
            width: size.width,
            height: Math.round((size.width * viewerDims.height) / viewerDims.width),
          }
        : size;
    body = (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Photos")}
        <ScrollView
          style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 12 }}
        >
          <Text style={{ fontSize: 15, color: "#111827" }}>{selected.name}</Text>
          <Text style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {selected.path}
          </Text>
          {viewerState !== "" ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 24 }}>
              {viewerState}
            </Text>
          ) : viewerPng !== null ? (
            <Image
              source={viewerPng}
              style={{
                width: viewerSize.width,
                height: viewerSize.height,
                marginTop: 12,
                borderRadius: 12,
              }}
            />
          ) : null}
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 12,
            paddingBottom: 16,
          }}
        >
          {button("Back to photos", () => setView("gallery"), { primary: true })}
        </View>
      </View>
    );
  } else if (!status.available) {
    body = (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Camera")}
        {centeredNote("No camera yet", status.message)}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            paddingBottom: 24,
          }}
        >
          <View style={{ marginRight: 12 }}>
            {button("Retry", retryStatus, { primary: true })}
          </View>
          {button("View photos", () => setView("gallery"))}
        </View>
      </View>
    );
  } else {
    body = (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Camera")}
        <View style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 12 }}>
          {previewPng !== null ? (
            <Image
              source={previewPng}
              style={{ width: size.width, height: size.height, borderRadius: 12 }}
            />
          ) : (
            <View
              style={{
                width: size.width,
                height: size.height,
                borderRadius: 12,
                backgroundColor: "#111827",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 14, color: "#9ca3af", textAlign: "center" }}>
                {previewError !== "" ? previewError : "Starting preview…"}
              </Text>
            </View>
          )}
          {saved !== "" ? (
            <Text
              style={{
                fontSize: 14,
                color: "#059669",
                textAlign: "center",
                marginTop: 8,
              }}
            >
              {saved}
            </Text>
          ) : null}
          {previewError !== "" && previewPng !== null ? (
            <Text
              style={{
                fontSize: 13,
                color: "#dc2626",
                textAlign: "center",
                marginTop: 8,
              }}
            >
              {previewError}
            </Text>
          ) : null}
        </View>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 12,
            paddingBottom: 16,
          }}
        >
          <View style={{ marginRight: 12 }}>
            {button(
              capturing ? "Taking photo…" : "Take photo",
              () => {
                void capture();
              },
              { primary: true, disabled: capturing },
            )}
          </View>
          {button("Photos (" + String(photos.length) + ")", () => setView("gallery"))}
        </View>
      </View>
    );
  }

  return body;
}
