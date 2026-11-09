const React = require("react");
// SevynOS M6 — expo-secure-store stub. No secure storage on the
// host yet: values live in an in-memory map, so they round-trip within
// a launch (login must hand the access token back to the socket layer)
// but do not persist across launches.
const store = new Map();
module.exports = {
  getItemAsync: (key) => Promise.resolve(store.has(key) ? store.get(key) : null),
  setItemAsync: (key, value) => {
    store.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key) => {
    store.delete(key);
    return Promise.resolve();
  },
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    store.set(key, value);
  },
  deleteItem: (key) => {
    store.delete(key);
  },
  AFTER_FIRST_UNLOCK: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  ALWAYS: 2,
  WHEN_PASSCODE_SET: 3,
  WHEN_UNLOCKED: 4,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
};
