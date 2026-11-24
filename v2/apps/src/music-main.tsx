// SevynOS v2 — Music entry point (evaluated by Hermes in the
// host). Renders <Music /> into the app window (M9: sized from Sevyn.width/height).

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Music } from "./Music";

render(React.createElement(Music), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
