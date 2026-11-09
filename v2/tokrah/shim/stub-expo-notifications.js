// SevynOS M6 — expo-notifications stub. No push on the host.
module.exports = {
  getPermissionsAsync: () =>
    Promise.resolve({ status: "undetermined", canAskAgain: true }),
  requestPermissionsAsync: () =>
    Promise.resolve({ status: "denied", canAskAgain: false }),
  getExpoPushTokenAsync: () => Promise.resolve({ type: "expo", data: "" }),
  getDevicePushTokenAsync: () => Promise.resolve({ type: "ios", data: "" }),
  setNotificationHandler: () => {},
  addNotificationReceivedListener: () => ({ remove() {} }),
  addNotificationResponseReceivedListener: () => ({ remove() {} }),
  scheduleNotificationAsync: () => Promise.resolve(""),
  cancelScheduledNotificationAsync: () => Promise.resolve(),
  cancelAllScheduledNotificationsAsync: () => Promise.resolve(),
  dismissNotificationAsync: () => Promise.resolve(),
  dismissAllNotificationsAsync: () => Promise.resolve(),
  setBadgeCountAsync: () => Promise.resolve(),
  getBadgeCountAsync: () => Promise.resolve(0),
  getLastNotificationResponseAsync: () => Promise.resolve(null),
  clearLastNotificationResponseAsync: () => Promise.resolve(),
  setNotificationChannelAsync: () => Promise.resolve(),
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
};
