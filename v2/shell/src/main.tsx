// SevynOS v2 M2 — shell entry point (evaluated by Hermes in the host).
// Renders <Shell /> into the 1024x768 surface.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Shell } from "./Shell";

render(React.createElement(Shell), {
  width: 1024,
  height: 768,
  backgroundColor: "#0b0b0f",
});
