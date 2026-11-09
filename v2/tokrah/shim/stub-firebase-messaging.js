// SevynOS M6 — @react-native-firebase/messaging stub.
// Default export is a function returning the messaging object (the
// real package's shape: `messaging().getToken()`).
const api = {
  getToken: () => Promise.resolve(""),
  deleteToken: () => Promise.resolve(),
  onMessage: () => () => {},
  onTokenRefresh: () => () => {},
  onNotificationOpenedApp: () => () => {},
  getInitialNotification: () => Promise.resolve(null),
  requestPermission: () => Promise.resolve(0),
  hasPermission: () => Promise.resolve(0),
  subscribeToTopic: () => Promise.resolve(),
  unsubscribeFromTopic: () => Promise.resolve(),
  setBackgroundMessageHandler: () => {},
};
function messaging() {
  return api;
}
module.exports = Object.assign(messaging, api, { default: messaging });

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
