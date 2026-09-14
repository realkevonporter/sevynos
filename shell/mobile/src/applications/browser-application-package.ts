import type { ApplicationPackage } from "@sevynos/runtime";

import { BROWSER_COMPONENT_ID } from "../runtime/create-sevyn-shell-runtime";

export const browserApplicationPackage: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "sevyn.builtin.browser",
    name: "Sevyn Browser",
    version: "1.0.0",
    hostId: "sevyn.host.react-native",
    entrypoint: BROWSER_COMPONENT_ID,
  },
  files: {},
};
