// SevynOS v2 M4 — Files entry point (evaluated by Hermes in the
// host). Renders <Files /> into the app window (M9: sized from Sevyn.width/height).

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Files } from "./Files";

render(React.createElement(Files), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
