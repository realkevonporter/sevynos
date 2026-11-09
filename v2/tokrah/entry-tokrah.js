// SevynOS M6 — Tokrah entry for the SevynOS host.
// Installs the environment glue, loads Tokrah's root through
// expo-router, and runs it through the shim's AppRegistry (which
// renders via the v2 renderer). The login screen is the mount target:
// with no stored session the app lands on auth.
require("./shim/env.js");
const { AppRegistry } = require("react-native");
require("expo-router/entry");
AppRegistry.runApplication("main", {});
