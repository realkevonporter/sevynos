import { defineConfig } from "vitest/config";
// Test tooling only (never shipped in the app bundle): resolves the bare
// "react-native" specifier the way the app bundlers do.
// eslint-disable-next-line no-restricted-imports
import { fileURLToPath } from "node:url";

/**
 * Shell components import the bare "react-native" specifier (the app
 * bundler maps it to the SevynOS framework). In unit tests, resolve it to
 * the framework's built public entry so components can mount in
 * SevynApplicationRuntime like the setup-wizard tests do.
 */
export default defineConfig({
  resolve: {
    alias: {
      "react-native": fileURLToPath(
        new URL("../../frameworks/react-native/dist/index.js", import.meta.url),
      ),
    },
  },
});
