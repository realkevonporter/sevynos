import {
  createSystemApplication,
  systemApplicationManifest,
} from "../create-system-application.js";
import { renderDesktopWallpaper, type DesktopWallpaperRenderInput } from "../desktop.js";
import { SystemApplicationId } from "../identifiers.js";

export const wallpaperSystemApplication = createSystemApplication(
  systemApplicationManifest({
    id: SystemApplicationId.Wallpaper,
    name: "Wallpaper",
    roles: ["wallpaper"],
    supportedDeviceClasses: ["desktop", "laptop", "tablet", "mobile"],
  }),
  (input) => renderDesktopWallpaper(input as DesktopWallpaperRenderInput),
);
