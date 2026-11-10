// SevynOS v2 M2 — shell entry point (evaluated by Hermes in the host).
// Renders <Shell /> into the surface: M9 sizes the surface to the
// output's preferred mode (the host sets Sevyn.width/height from the
// real surface size), falling back to 1024x768.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Shell } from "./Shell";

render(React.createElement(Shell), {
  width: Sevyn.width || 1024,
  height: Sevyn.height || 768,
  backgroundColor: "#0b0b0f",
});
