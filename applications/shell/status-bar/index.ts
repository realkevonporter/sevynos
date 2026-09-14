import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { renderDesktopStatusBar, type DesktopStatusBarRenderInput } from "../desktop.js";
import { SystemApplicationId } from "../identifiers.js";

export const statusBarSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.StatusBar,
    name: "Status Bar",
    roles: ["status", "system-indicators"],
    supportedDeviceClasses: ["desktop", "laptop", "tablet", "mobile"],
  }),
  (input) => renderDesktopStatusBar(input as DesktopStatusBarRenderInput),
);
