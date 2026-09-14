import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { renderDesktopLauncher, type DesktopLauncherRenderInput } from "../desktop.js";
import { SystemApplicationId } from "../identifiers.js";

export const launcherSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.Launcher,
    name: "Launcher",
    roles: ["launcher"],
    supportedDeviceClasses: ["desktop", "laptop", "tablet"],
  }),
  (input) => renderDesktopLauncher(input as DesktopLauncherRenderInput),
);
