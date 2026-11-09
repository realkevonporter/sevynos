// SevynOS M6 — `expo-widgets` stub. Widgets render in the iOS widget
// extension, never in the app; the app only calls updateSnapshot to
// push new data. The stub keeps that call working and drops the data.
"use strict";
module.exports = {
  createWidget: () => ({ updateSnapshot: () => {} }),
};
