import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import {
  renderDesktopWindowSwitcher,
  type DesktopWindowSwitcherRenderInput,
} from "../desktop.js";
import { SystemApplicationId } from "../identifiers.js";

export const windowSwitcherSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.WindowSwitcher,
    name: "Window Switcher",
    roles: ["window-switcher", "overlay"],
    supportedDeviceClasses: ["desktop", "laptop"],
  }),
  (input) => renderDesktopWindowSwitcher(input as DesktopWindowSwitcherRenderInput),
);
