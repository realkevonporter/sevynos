// SevynOS M6 — `react-native-vision-camera` stub. There is no camera
// adapter on the SevynOS host yet (M6 scope: the bring-up, not media
// capture), so permissions report granted and the preview renders a
// static view. The go-live screen can therefore reach its Start button;
// the actual camera frames are out of scope for M6.
"use strict";
const React = require("react");

const granted = {
  hasPermission: true,
  canRequestPermission: true,
  requestPermission: () => Promise.resolve(true),
};

function Camera(props) {
  return React.createElement("View", props, props && props.children);
}

module.exports = {
  Camera,
  useCameraDevice: () => ({ id: "sevyn-stub-camera", position: "front" }),
  useCameraPermission: () => granted,
  useMicrophonePermission: () => granted,
  useCameraFormat: () => null,
  useFrameProcessor: () => null,
  useSkiaFrameProcessor: () => null,
  runAtTargetFps: (fps, fn) => fn,
  useCameraDevices: () => [],
};
Object.defineProperty(module.exports, "__esModule", { value: true });
