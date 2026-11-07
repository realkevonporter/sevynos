// SevynOS v2 M3 — stock-app entry point (evaluated by Hermes in the
// host). Renders <App /> into the 800x500 app window.

import * as React from "react";
import { render } from "../../rn/renderer/sevyn-renderer";
import { App } from "./App";

render(React.createElement(App), {
  width: 800,
  height: 500,
  backgroundColor: "#f9fafb",
});
