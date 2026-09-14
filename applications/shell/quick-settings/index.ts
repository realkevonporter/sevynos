import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const quickSettingsSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.QuickSettings,
    name: "Quick Settings",
    roles: ["quick-settings"],
    supportedDeviceClasses: ["mobile"],
  }),
);
