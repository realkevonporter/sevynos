// SevynOS v2 M5 — Browser entry point (evaluated by Hermes in the
// host). Renders <Browser /> into the app window (M9: sized from Sevyn.width/height).

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Browser } from "./Browser";

render(React.createElement(Browser), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f0f9ff",
});
