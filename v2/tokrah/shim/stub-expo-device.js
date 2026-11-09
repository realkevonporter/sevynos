// SevynOS M6 — expo-device stub.
module.exports = {
  isDevice: true,
  brand: "Sevyn",
  manufacturer: "SevynOS",
  modelName: "SevynOS",
  modelId: "sevynos-1",
  deviceName: "SevynOS",
  osName: "SevynOS",
  osVersion: "1.0",
  deviceType: 1,
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  getDeviceTypeAsync: () => Promise.resolve(1),
  getUptimeAsync: () => Promise.resolve(0),
};
