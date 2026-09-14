import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { renderDesktopDock, type DesktopDockRenderInput } from "../desktop.js";
import { SystemApplicationId } from "../identifiers.js";

export const dockSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.Dock,
    name: "Dock",
    roles: ["dock", "running-applications", "workspace-switcher"],
    supportedDeviceClasses: ["desktop", "laptop", "tablet", "mobile"],
  }),
  (input) => renderDesktopDock(input as DesktopDockRenderInput),
);
