// SevynOS v2 M4 — Settings entry point (evaluated by Hermes in the
// host). Renders <Settings /> into the app window (M9: sized from Sevyn.width/height).

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Settings } from "./Settings";

render(React.createElement(Settings), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
