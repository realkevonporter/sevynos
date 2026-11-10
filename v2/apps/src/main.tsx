// SevynOS v2 M3 — stock-app entry point (evaluated by Hermes in the
// host). Renders <App /> into the app window: M9 sizes it from
// Sevyn.width/height (the host's real window size, updated on resize
// drags), falling back to the 800x500 default.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { App } from "./App";

render(React.createElement(App), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
