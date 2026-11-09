// SevynOS M6 — generic native-module stub.
// Any named import resolves to a stub function; the default export is
// the same stub. When used as a component it renders its children
// (so stubbed providers/wrappers never blank the tree); when called
// as a plain function it returns undefined. Enough for packages
// Tokrah only touches at load time or in flows M6 does not drive.
// Packages the mount path actually calls get dedicated stubs instead
// (see stub-*.js).
const React = require("react");

function StubComponent(props) {
  if (props && props.children != null)
    return React.createElement(React.Fragment, null, props.children);
  return null;
}
const stub = new Proxy(StubComponent, {
  get(_t, prop) {
    // __esModule must be TRUE (not undefined): Babel's _interopDefault
    // and _interopNamespace both short-circuit on it. With undefined,
    // a namespace import copies `default` as a getter and then
    // assigns it, which throws ("Cannot set property default ... which
    // has only a getter"); with true, both interops return the proxy
    // as-is and `.default` resolves to the stub.
    if (prop === "__esModule") return true;
    // `prototype` must NOT resolve to the stub: React's class check
    // is `type.prototype && type.prototype.isReactComponent`, and the
    // trap would return the stub (truthy) for both — so React treated
    // the stub as a class component and `instance.render()` threw
    // ("context.render is not a function"). Undefined keeps it a
    // function component.
    if (prop === "prototype" || prop === "isReactComponent") return undefined;
    return stub;
  },
  apply(_t, _thisArg, args) {
    const first = args && args[0];
    if (first && typeof first === "object" && first.children != null) {
      return React.createElement(React.Fragment, null, first.children);
    }
    return undefined;
  },
});
module.exports = new Proxy(
  { default: stub },
  {
    get(_t, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return stub;
      return stub;
    },
  },
);
