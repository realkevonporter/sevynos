/* eslint-disable @typescript-eslint/no-require-imports */
/* global __dirname, module, require */

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Workspace packages emit ESM with explicit `.js` specifiers. During Expo
// development Metro consumes their TypeScript sources, so resolve those local
// specifiers back to the matching `.ts` or `.tsx` module.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(
        context,
        moduleName.slice(0, -".js".length),
        platform,
      );
    } catch {
      // The specifier may point to a real JavaScript file; use Metro's normal path.
    }
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
