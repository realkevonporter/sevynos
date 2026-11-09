// SevynOS M6 — @legendapp/list stub.
// LegendList renders every item eagerly inside a ScrollView (no
// virtualization on the SevynOS host — the renderer has no recycling
// cells). Correct for the mount proof; large feeds are slower, not
// broken.
const React = require("react");

// ListHeader/Footer/EmptyComponent may be a component type OR an
// already-created element (FlatList accepts both): an element must be
// rendered as-is — createElement() on it makes the element the TYPE,
// which throws React #130 (an element-shaped object as a type).
function renderComponentProp(comp) {
  if (comp == null) return null;
  if (typeof comp === "object" && comp.$$typeof != null) return comp;
  return React.createElement(comp);
}
function LegendList(props) {
  const data = (props && props.data) || [];
  const renderItem = props && props.renderItem;
  const keyExtractor = (props && props.keyExtractor) || ((item, i) => String(i));
  const items = renderItem
    ? data.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: keyExtractor(item, index) },
          renderItem({ item, index, separators: {} }),
        ),
      )
    : null;
  const header =
    props && props.ListHeaderComponent
      ? React.createElement(
          React.Fragment,
          null,
          renderComponentProp(props.ListHeaderComponent),
        )
      : null;
  const footer =
    props && props.ListFooterComponent
      ? React.createElement(
          React.Fragment,
          null,
          renderComponentProp(props.ListFooterComponent),
        )
      : null;
  const empty =
    data.length === 0 && props && props.ListEmptyComponent
      ? React.createElement(
          React.Fragment,
          null,
          renderComponentProp(props.ListEmptyComponent),
        )
      : null;
  return React.createElement(
    "ScrollView",
    { style: props && props.style },
    header,
    items,
    empty,
    footer,
  );
}
module.exports = { LegendList, default: LegendList };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
