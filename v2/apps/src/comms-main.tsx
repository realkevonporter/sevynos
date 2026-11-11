// SevynOS v2 M10 — comms entry point (evaluated by Hermes in the
// host). Renders <Comms /> into the app window (M9: sized from
// Sevyn.width/height). One bundle serves Messages, Video Calls, and
// Voice Calls — the identity comes from Sevyn.appId at runtime.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Comms } from "./Comms";

render(React.createElement(Comms), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
