import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const windowChromeSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.WindowChrome,
    name: "Window Chrome",
    roles: ["window-chrome"],
    supportedDeviceClasses: ["desktop", "laptop"],
  }),
);
