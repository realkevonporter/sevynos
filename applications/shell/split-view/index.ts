import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { SystemApplicationId } from "../identifiers.js";

export const splitViewSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.SplitView,
    name: "Split View",
    roles: ["split-view", "multitasking"],
    supportedDeviceClasses: ["tablet"],
  }),
);
