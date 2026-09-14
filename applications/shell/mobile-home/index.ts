import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const mobileHomeSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.MobileHome,
    name: "Mobile Home",
    roles: ["mobile-home"],
    supportedDeviceClasses: ["mobile"],
  }),
);
