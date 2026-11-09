// SevynOS M6 — `expo-linking` stub. The real package calls
// requireNativeModule('ExpoLinking') at load and there is no such
// module on the SevynOS host, so the real JS cannot load. The stub
// keeps the JS API shape: no initial URL (the host has no deep-link
// delivery in M6), openURL/canOpenURL resolve without doing anything.
"use strict";
module.exports = {
  getInitialURL: () => Promise.resolve(null),
  openURL: () => Promise.resolve(),
  canOpenURL: () => Promise.resolve(false),
  openSettings: () => Promise.resolve(),
  addEventListener: () => ({ remove() {} }),
  removeEventListener: () => {},
  createURL: (path) => `tokrah.app/${path || ""}`,
  parse: (url) => ({ path: "", queryParams: {}, hostname: "", scheme: "", url }),
  useURL: () => null,
};
