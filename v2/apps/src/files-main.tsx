// SevynOS v2 M4 — Files entry point (evaluated by Hermes in the
// host). Renders <Files /> into the 800x500 app window.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { Files } from "./Files";

render(React.createElement(Files), {
  width: 800,
  height: 500,
  backgroundColor: "#f9fafb",
});
