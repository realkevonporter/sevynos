// SevynOS v2 M4 — Settings entry point (evaluated by Hermes in the
// host). Renders <Settings /> into the 800x500 app window.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Settings } from "./Settings";

render(React.createElement(Settings), {
  width: 800,
  height: 500,
  backgroundColor: "#f9fafb",
});
