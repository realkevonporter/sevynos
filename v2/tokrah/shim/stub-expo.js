// SevynOS M6 — `expo` package stub. Only registerRootComponent is
// used by the entry path; it forwards to the shim's AppRegistry.
// expo-router's splash flow also imports requireOptionalNativeModule
// from 'expo': on the SevynOS host there are no native modules, so it
// returns null (its documented "not found" answer). requireNativeModule
// returns a no-op module Proxy instead of throwing — the shim's
// standing pattern for missing native surface (a throw at load time
// would kill the mount for modules that call it at module scope).
"use strict";
const { AppRegistry } = require("./react-native.js");

function makeModule() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "getConstants") return () => ({});
        if (prop === "then") return undefined;
        return () => undefined;
      },
    },
  );
}

module.exports = {
  registerRootComponent: (component) => {
    AppRegistry.registerComponent("main", () => component);
    return component;
  },
  requireOptionalNativeModule: () => null,
  requireNativeModule: () => makeModule(),
  // requireNativeView(name) returns a native view component. On the
  // host there are no native views: return a component that renders
  // its children in a plain View.
  requireNativeView: () => {
    const React = require("react");
    return function SevynNativeView(props) {
      return React.createElement("View", props);
    };
  },
  requireNativeViewManager: () => {
    const React = require("react");
    return function SevynNativeView(props) {
      return React.createElement("View", props);
    };
  },
};
