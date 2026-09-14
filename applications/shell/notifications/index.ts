import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const notificationsSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.Notifications,
    name: "Notification Center",
    roles: ["notifications"],
    supportedDeviceClasses: ["desktop", "laptop", "tablet", "mobile"],
  }),
);
