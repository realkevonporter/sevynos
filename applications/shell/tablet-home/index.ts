import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const tabletHomeSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.TabletHome,
    name: "Tablet Home",
    roles: ["tablet-home"],
    supportedDeviceClasses: ["tablet"],
  }),
);
