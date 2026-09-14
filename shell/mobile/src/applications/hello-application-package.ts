import type { ApplicationPackage } from "@sevynos/runtime";

import { HELLO_COMPONENT_ID } from "../runtime/create-sevyn-shell-runtime";

export const helloApplicationPackage: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "sevyn.builtin.hello",
    name: "Hello",
    version: "1.0.0",
    hostId: "sevyn.host.react-native",
    entrypoint: HELLO_COMPONENT_ID,
  },

  files: {},
};
