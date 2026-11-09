// SevynOS M6 — expo-background-task stub.
module.exports = {
  registerTaskAsync: () => Promise.resolve(),
  unregisterTaskAsync: () => Promise.resolve(),
  getStatusAsync: () => Promise.resolve(0),
  BackgroundTaskStatus: { RESTRICTED: 0, AVAILABLE: 1 },
};
