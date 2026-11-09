// SevynOS M6 — @gorhom/bottom-sheet stub.
// Sheets render inline when open (no modal layer in the v2 renderer):
// BottomSheet renders its children when its index is >= 0, the modal
// variant the same. Hooks are no-ops.
const React = require("react");

function BottomSheet(props) {
  if (props && props.index != null && props.index < 0) return null;
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function BottomSheetModal(props) {
  return React.createElement(BottomSheet, props, props && props.children);
}
// The modal provider just renders children (no modal layer on the host).
function BottomSheetProvider(props) {
  return React.createElement(React.Fragment, null, props && props.children);
}
function BottomSheetView(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
function BottomSheetScrollView(props) {
  return React.createElement(
    "ScrollView",
    { style: props && props.style },
    props && props.children,
  );
}
function BottomSheetFlatList(props) {
  const data = (props && props.data) || [];
  const renderItem = props && props.renderItem;
  const items = renderItem
    ? data.map((item, index) =>
        React.createElement(React.Fragment, { key: index }, renderItem({ item, index })),
      )
    : null;
  return React.createElement("ScrollView", { style: props && props.style }, items);
}
function BottomSheetTextInput(props) {
  return React.createElement("TextInput", props);
}
function BottomSheetBackdrop() {
  return null;
}
function BottomSheetFooter(props) {
  return React.createElement(
    "View",
    { style: props && props.style },
    props && props.children,
  );
}
const INITIAL_LAYOUT_VALUE = { x: 0, y: 0, width: 0, height: 0 };
const KEYBOARD_STATUS = { SHOWN: "shown", HIDDEN: "hidden" };
const useBottomSheet = () => ({
  close: () => {},
  expand: () => {},
  collapse: () => {},
  snapToIndex: () => {},
});
const useBottomSheetInternal = () => ({});
module.exports = {
  default: BottomSheet,
  BottomSheet,
  BottomSheetModal,
  BottomSheetModalProvider: BottomSheetProvider,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetFlatList,
  BottomSheetTextInput,
  BottomSheetBackdrop,
  BottomSheetFooter,
  INITIAL_LAYOUT_VALUE,
  KEYBOARD_STATUS,
  useBottomSheet,
  useBottomSheetInternal,
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
