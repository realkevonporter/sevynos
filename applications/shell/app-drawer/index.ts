import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const appDrawerSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.AppDrawer,
    name: "App Drawer",
    roles: ["app-drawer"],
    supportedDeviceClasses: ["desktop", "laptop", "tablet", "mobile"],
  }),
);
