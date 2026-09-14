import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";
import {
  renderDesktopLockScreen,
  type DesktopLockScreenRenderInput,
} from "../desktop.js";

export const lockScreenSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.LockScreen,
    name: "Lock Screen",
    roles: ["lock-screen"],
    supportedDeviceClasses: ["desktop", "tablet", "mobile"],
  }),
  (input) => renderDesktopLockScreen(input as DesktopLockScreenRenderInput),
);
