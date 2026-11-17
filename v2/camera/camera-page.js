// SevynOS v2 Camera v1 — preview page logic.
//
// Loaded by camera.html (the page `sevyn camera preview` opens in
// Chromium as the content window paired with the Camera app). The
// <video> element IS the live preview: getUserMedia paints the real
// webcam on hardware, Chromium's synthetic camera under
// --use-fake-device-for-media-stream in the check.
//
// The page exposes window.__sevynCamera for the capture helper
// (camera-capture.mjs, over CDP):
//   state()   -> "starting" | "ready" | "error"
//   error()   -> the getUserMedia failure message, or ""
//   capture() -> { jpeg, png, width, height, at } — the current
//                video frame drawn to canvas, encoded BOTH ways:
//                JPEG is the real photo (saved to /data, where
//                Photos already looks); PNG is the viewer preview
//                (the RN host's image loader is PNG-only — see
//                Camera.tsx — so the gallery shows the PNG sidecar
//                in /data/.camera, never the JPEG).
// document.title mirrors the state so `sevyn camera status` can
// report it over plain CDP HTTP (/json/list): "Camera ready
// 1280x720", "Camera error: <msg>", "Camera starting…".
//
// Kept as its own file (not inline in camera.html) so the logic is
// unit-testable in Node (test-camera-page.mjs) without a browser.

(function () {
  var video = null;
  var statusEl = null;
  var state = "starting";
  var lastError = "";
  var frameWidth = 0;
  var frameHeight = 0;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setState(next, detail) {
    state = next;
    if (next === "ready") {
      document.title = "Camera ready " + frameWidth + "x" + frameHeight;
      setStatus("");
    } else if (next === "error") {
      lastError = detail || "camera unavailable";
      document.title = "Camera error: " + lastError;
      setStatus("Camera unavailable: " + lastError);
    } else {
      document.title = "Camera starting…";
      setStatus("Camera starting…");
    }
  }

  function start() {
    video = document.getElementById("preview");
    statusEl = document.getElementById("status");
    setState("starting");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState("error", "getUserMedia not available");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then(function (stream) {
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        frameWidth = video.videoWidth || 0;
        frameHeight = video.videoHeight || 0;
        setState("ready");
      })
      .catch(function (err) {
        setState("error", (err && err.message) || String(err));
      });
    video.addEventListener("resize", function () {
      if (video.videoWidth && video.videoHeight) {
        frameWidth = video.videoWidth;
        frameHeight = video.videoHeight;
        if (state === "ready") setState("ready");
      }
    });
  }

  function capture() {
    if (state !== "ready") {
      throw new Error("camera not ready: " + state);
    }
    if (!video || video.readyState < 2) {
      throw new Error("no video frames yet");
    }
    var w = video.videoWidth || 0;
    var h = video.videoHeight || 0;
    if (!w || !h) {
      throw new Error("no video frames yet");
    }
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    return {
      jpeg: canvas.toDataURL("image/jpeg", 0.92),
      png: canvas.toDataURL("image/png"),
      width: w,
      height: h,
      at: Date.now(),
    };
  }

  window.__sevynCamera = {
    state: function () {
      return state;
    },
    error: function () {
      return lastError;
    },
    capture: capture,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
