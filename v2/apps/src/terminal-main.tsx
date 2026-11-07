// SevynOS v2 M4 — Terminal entry point (evaluated by Hermes in the
// host). Renders <Terminal /> into the 800x500 app window.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Terminal } from "./Terminal";

render(React.createElement(Terminal), {
  width: 800,
  height: 500,
  backgroundColor: "#111827",
});
