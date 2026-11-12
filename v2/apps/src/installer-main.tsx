// SevynOS v2 M11 — Installer entry point (evaluated by Hermes in
// the host). Renders <Installer /> into the app window.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Installer } from "./Installer";

render(React.createElement(Installer), {
  width: Sevyn.width || 800,
  height: Sevyn.height || 500,
  backgroundColor: "#f9fafb",
});
