// SevynOS v2 — Camera entry point (evaluated by Hermes in the
// host). Renders <Camera /> into the app window (M9: sized from Sevyn.width/height).

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Camera } from "./Camera";

render(React.createElement(Camera), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
