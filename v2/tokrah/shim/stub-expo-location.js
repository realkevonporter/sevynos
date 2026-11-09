// SevynOS M6 — expo-location stub. No location hardware; the
// current position is the null island fix (0,0) so flows that read
// it do not crash.
const pos = () =>
  Promise.resolve({
    coords: { latitude: 0, longitude: 0, altitude: 0, accuracy: 0, heading: 0, speed: 0 },
    timestamp: Date.now(),
  });
module.exports = {
  getCurrentPositionAsync: pos,
  getLastKnownPositionAsync: () => Promise.resolve(null),
  getForegroundPermissionsAsync: () =>
    Promise.resolve({ status: "undetermined", canAskAgain: true }),
  requestForegroundPermissionsAsync: () =>
    Promise.resolve({ status: "denied", canAskAgain: false }),
  getBackgroundPermissionsAsync: () =>
    Promise.resolve({ status: "undetermined", canAskAgain: true }),
  requestBackgroundPermissionsAsync: () =>
    Promise.resolve({ status: "denied", canAskAgain: false }),
  watchPositionAsync: () => Promise.resolve({ remove() {} }),
  reverseGeocodeAsync: () => Promise.resolve([]),
  geocodeAsync: () => Promise.resolve([]),
  hasServicesEnabledAsync: () => Promise.resolve(false),
  LocationAccuracy: {
    Lowest: 1,
    Low: 2,
    Balanced: 3,
    High: 4,
    Highest: 5,
    BestForNavigation: 6,
  },
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
};
