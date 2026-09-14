import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const desktopHomeSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.DesktopHome,
    name: "Desktop",
    roles: ["desktop-home"],
    supportedDeviceClasses: ["desktop", "laptop"],
  }),
);
