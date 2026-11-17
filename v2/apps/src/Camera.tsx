// SevynOS v2 Camera v1 — the Camera system app (stills).
//
// The preview is a Chromium content window, not an RN view: the app
// drives it through `sevyn camera ...` (cli.exec permission) exactly
// like the Browser app drives its Chromium — `camera preview` opens
// camera.html as a chromeless --app window (800x348) under this
// window's 152px of chrome (title 44 + shutter 44 + mode 36 +
// status 28 — the Browser app's geometry, so the content window
// lands in the same place). The RN window holds the chrome: title,
// shutter, mode strip, status line. The <video> in the page IS the
// live preview (real webcam on hardware, Chromium's synthetic camera
// with --fake-media in the check).
//
// The shutter runs `sevyn camera capture` (the Node helper grabs the
// current frame over CDP): a REAL JPEG lands in /data (IMG_*.jpg —
// where Photos already looks, so Photos sees it with no second
// feature) plus a PNG viewer preview in /data/.camera (the RN host's
// image loader is PNG-only, so the gallery shows the PNG sidecar;
// the JPEG is the photo).
//
// Permissions: the manifest declares `camera`; first use shows an
// in-app consent screen, and Allow persists `granted` to
// /data/.camera/consent so later launches go straight to the
// preview. A missing `camera` permission (old manifest) shows an
// honest error instead of a dead shutter.
//
// The app logs markers the harness reads off the serial:
//   CAMERA preview ready            (preview page reports ready)
//   CAMERA preview error <detail>   (getUserMedia failed)
//   CAMERA captured <path>          (shutter wrote a JPEG)
//   CAMERA gallery <n> photos       (gallery opened)
// Video recording is NOT in v1 — the follow-up (see the PR body).

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli, runCliAsync, parseField } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";

// One host tick, off the render path (Browser.tsx uses the same
// setTimeout shape for its settle poll).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full rest of a `key: value` line (parseField stops at the first
// space — the preview-error detail is a sentence).
function parseLine(out: string, key: string): string | null {
  for (const line of out.split("\n")) {
    if (line.startsWith(key)) return line.slice(key.length).trim();
  }
  return null;
}

function isJpeg(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg");
}

function baseOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(0, i) : name;
}

function readConsent(): boolean {
  const { code, out } = runCli("sevyn files cat /data/.camera/consent");
  return code === 0 && out.trim() === "granted";
}

// Newest first: IMG_YYYYMMDD_HHMMSS names sort chronologically.
function listPhotos(): { names: string[]; previews: Set<string> } {
  const names: string[] = [];
  const r = runCli("sevyn files list /data");
  if (r.code === 0) {
    for (const line of r.out.split("\n")) {
      if (!line.startsWith("f ")) continue;
      const name = line.slice(2);
      if (isJpeg(name)) names.push(name);
    }
  }
  names.sort().reverse();
  const previews = new Set<string>();
  const p = runCli("sevyn files list /data/.camera");
  if (p.code === 0) {
    for (const line of p.out.split("\n")) {
      if (!line.startsWith("f ")) continue;
      const name = line.slice(2);
      if (name.toLowerCase().endsWith(".png")) previews.add(baseOf(name));
    }
  }
  return { names, previews };
}

type PreviewState = "idle" | "starting" | "ready" | "error";
type ViewState = "camera" | "gallery" | "viewer";

// Poll `camera status` until the preview page reports ready (or
// errors). Bounded: 45 attempts (~90 s — a cold Chromium under TCG
// takes most of that to reach a first frame; on hardware it is a
// few seconds).
const POLL_ATTEMPTS = 45;
const POLL_STEP_MS = 2000;

export function Camera(): React.ReactElement {
  const [consent, setConsent] = React.useState<boolean>(() => readConsent());
  const [permitted] = React.useState<boolean>(() => Sevyn.hasPermission("camera"));
  const [preview, setPreview] = React.useState<PreviewState>("idle");
  const [previewError, setPreviewError] = React.useState<string>("");
  const [capturing, setCapturing] = React.useState(false);
  const [lastSaved, setLastSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<ViewState>("camera");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [photos, setPhotos] = React.useState<{ names: string[]; previews: Set<string> }>(
    () => listPhotos(),
  );
  const color = Sevyn.appColor;

  async function pollPreview(): Promise<void> {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const { code, out } = await runCliAsync("sevyn camera status");
      if (code === 0) {
        const state = parseField(out, "preview");
        if (state === "ready") {
          setPreview("ready");
          setPreviewError("");
          Sevyn.log("CAMERA preview ready");
          return;
        }
        if (state === "error") {
          const detail = parseLine(out, "preview-error: ") || "camera unavailable";
          setPreview("error");
          setPreviewError(detail);
          Sevyn.log("CAMERA preview error " + detail);
          return;
        }
      }
      await sleep(POLL_STEP_MS);
    }
    setPreview("error");
    setPreviewError("preview did not become ready");
    Sevyn.log("CAMERA preview error preview did not become ready");
  }

  async function startPreview(fake: boolean): Promise<void> {
    setPreview("starting");
    setPreviewError("");
    setError(null);
    // Kill any stale preview first: a preview Chromium launched
    // before this window mapped sits UNDER it (its window never
    // re-maps on top), so only a fresh launch guarantees the video
    // is visible. Idempotent — a no-op when nothing is running.
    await runCliAsync("sevyn camera quit");
    const { code, out } = await runCliAsync(
      "sevyn camera preview" + (fake ? " --fake-media" : ""),
    );
    if (code !== 0) {
      setPreview("error");
      setPreviewError(out.trim() || "could not start the preview");
      return;
    }
    await pollPreview();
  }

  // First launch with consent goes straight to the preview (the
  // mount initializer cannot await, so the async start is
  // fire-and-forget — the same shape as the other apps' mount-time
  // CLI calls, which run synchronously in their initializers).
  const [booted] = React.useState<boolean>(() => {
    if (consent) {
      void startPreview(false);
    }
    return true;
  });
  void booted;

  async function grantConsent(): Promise<void> {
    // Best-effort mkdir: it errors when /data/.camera already
    // exists, which is fine — the write below is the real step.
    runCli("sevyn files mkdir /data/.camera");
    const { code } = runCli("sevyn files write /data/.camera/consent granted");
    if (code !== 0) {
      setError("could not save camera permission");
      return;
    }
    setConsent(true);
    await startPreview(false);
  }

  function refreshPhotos(): void {
    setPhotos(listPhotos());
  }

  async function capture(): Promise<void> {
    if (capturing || preview !== "ready") return;
    setCapturing(true);
    setError(null);
    const { code, out } = await runCliAsync("sevyn camera capture");
    setCapturing(false);
    if (code !== 0) {
      setError(out.trim() || "capture failed");
      Sevyn.log("CAMERA capture failed");
      return;
    }
    const saved = parseLine(out, "saved: ");
    setLastSaved(saved);
    Sevyn.log("CAMERA captured " + (saved ?? ""));
    refreshPhotos();
  }

  async function openGallery(): Promise<void> {
    // The preview is its own Wayland window on top of this one: it
    // must die before the gallery can be seen. Relaunching on the
    // way back is a cold start (slow under TCG, fast on hardware).
    await runCliAsync("sevyn camera quit");
    setPreview("idle");
    const fresh = listPhotos();
    setPhotos(fresh);
    setView("gallery");
    Sevyn.log("CAMERA gallery " + fresh.names.length + " photos");
  }

  async function backToCamera(): Promise<void> {
    setSelected(null);
    setView("camera");
    await startPreview(false);
  }

  function close(): void {
    // Quit the preview first so no Chromium outlives the app (the
    // lifecycle the harness gates on); the result is ignored — the
    // app closes regardless.
    runCli("sevyn camera quit");
    Sevyn.closeApp();
  }

  const previewText =
    preview === "ready"
      ? "Preview ready — tap the shutter to take a photo."
      : preview === "starting"
        ? "Starting preview…"
        : preview === "error"
          ? "No camera: " + previewError
          : "Preview not started.";

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "column",
        backgroundColor: "#f9fafb",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          height: 44,
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
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          Camera
        </Text>
        <WindowButtons />
        <Pressable
          onPress={close}
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
      <View
        style={{
          flexDirection: "row",
          height: 44,
          backgroundColor: "#ccfbf1",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 16,
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: "bold", color: "#0f766e", flex: 1 }}>
          Photo
        </Text>
        <Pressable
          onPress={() => {
            if (view === "camera") void capture();
          }}
          style={{
            width: 56,
            height: 36,
            borderRadius: 18,
            backgroundColor: preview === "ready" && !capturing ? "#ffffff" : "#e5e7eb",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "bold", color: "#0f766e" }}>
            {capturing ? "…" : "◎"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (view === "camera") void openGallery();
          }}
          style={{
            flex: 1,
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "bold", color: "#0f766e" }}>
            Photos ({photos.names.length})
          </Text>
        </Pressable>
      </View>
      <View
        style={{
          height: 36,
          backgroundColor: "#f0fdfa",
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 16,
        }}
      >
        <Text style={{ fontSize: 13, color: "#134e4a", flex: 1 }}>{previewText}</Text>
        {preview === "error" ? (
          <Pressable
            onPress={() => {
              void startPreview(true);
            }}
            style={{
              height: 26,
              borderRadius: 6,
              backgroundColor: "#14b8a6",
              justifyContent: "center",
              paddingLeft: 10,
              paddingRight: 10,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "bold", color: "#ffffff" }}>
              Use test camera
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View
        style={{
          height: 28,
          backgroundColor: "#e5e7eb",
          justifyContent: "center",
          paddingLeft: 12,
        }}
      >
        <Text style={{ fontSize: 13, color: "#374151" }}>
          {error ??
            (lastSaved
              ? "Saved " + lastSaved
              : photos.names.length + " photo(s) on this device.")}
        </Text>
      </View>
      {view === "camera" ? (
        <View
          style={{
            flex: 1,
            backgroundColor: "#000000",
            justifyContent: "center",
            alignItems: "center",
            paddingLeft: 16,
            paddingRight: 16,
          }}
        >
          {!permitted ? (
            <Text style={{ fontSize: 15, color: "#fca5a5", textAlign: "center" }}>
              Camera permission not granted — reinstall the Camera app.
            </Text>
          ) : !consent ? (
            <View style={{ alignItems: "center" }}>
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                Allow Camera to use your camera?
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  color: "#9ca3af",
                  textAlign: "center",
                  marginTop: 8,
                }}
              >
                Photos are saved on this device only.
              </Text>
              <Pressable
                onPress={() => {
                  void grantConsent();
                }}
                style={{
                  marginTop: 16,
                  height: 40,
                  borderRadius: 8,
                  backgroundColor: "#14b8a6",
                  justifyContent: "center",
                  paddingLeft: 24,
                  paddingRight: 24,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: "bold", color: "#ffffff" }}>
                  Allow camera
                </Text>
              </Pressable>
            </View>
          ) : (
            <Text style={{ fontSize: 15, color: "#9ca3af", textAlign: "center" }}>
              {preview === "ready"
                ? "Live preview is in the window below the controls."
                : preview === "error"
                  ? "Preview unavailable — check the message above."
                  : "Starting the camera…"}
            </Text>
          )}
        </View>
      ) : view === "gallery" ? (
        <ScrollView
          style={{ flex: 1, paddingLeft: 12, paddingRight: 12, paddingTop: 12 }}
        >
          <Pressable
            onPress={() => {
              void backToCamera();
            }}
            style={{
              height: 36,
              borderRadius: 6,
              backgroundColor: "#ccfbf1",
              justifyContent: "center",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "bold", color: "#0f766e" }}>
              ← Back to camera
            </Text>
          </Pressable>
          {photos.names.length === 0 ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              No photos yet — take one with the shutter.
            </Text>
          ) : null}
          {photos.names.map((name) => (
            <Pressable
              key={name}
              onPress={() => {
                setSelected(name);
                setView("viewer");
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingTop: 6,
                paddingBottom: 6,
              }}
            >
              {photos.previews.has(baseOf(name)) ? (
                <Image
                  source={"/data/.camera/" + baseOf(name) + ".png"}
                  style={{ width: 96, height: 54, marginRight: 12 }}
                />
              ) : (
                <View
                  style={{
                    width: 96,
                    height: 54,
                    marginRight: 12,
                    backgroundColor: "#e5e7eb",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontSize: 12, color: "#6b7280" }}>No preview</Text>
                </View>
              )}
              <Text style={{ fontSize: 14, color: "#111827", flex: 1 }}>{name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <ScrollView
          style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 12 }}
        >
          <Pressable
            onPress={() => {
              setView("gallery");
            }}
            style={{
              height: 36,
              borderRadius: 6,
              backgroundColor: "#ccfbf1",
              justifyContent: "center",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "bold", color: "#0f766e" }}>
              ← Back to gallery
            </Text>
          </Pressable>
          {selected ? (
            <View>
              <Text style={{ fontSize: 15, fontWeight: "bold", color: "#111827" }}>
                {selected}
              </Text>
              {photos.previews.has(baseOf(selected)) ? (
                <Image
                  source={"/data/.camera/" + baseOf(selected) + ".png"}
                  style={{ width: 640, height: 360, marginTop: 12 }}
                />
              ) : (
                <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 12 }}>
                  Preview unavailable for this photo — the JPEG is saved in /data.
                </Text>
              )}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
