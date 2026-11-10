// SevynOS v2 M4 — Terminal entry point (evaluated by Hermes in the
// host). Renders <Terminal /> into the app window (M9: sized from Sevyn.width/height).

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Terminal } from "./Terminal";

render(React.createElement(Terminal), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#111827",
});
