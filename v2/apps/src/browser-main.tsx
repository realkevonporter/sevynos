// SevynOS v2 M5 — Browser entry point (evaluated by Hermes in the
// host). Renders <Browser /> into the 800x500 app window.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Browser } from "./Browser";

render(React.createElement(Browser), {
  width: 800,
  height: 500,
  backgroundColor: "#f0f9ff",
});
