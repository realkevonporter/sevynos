// SevynOS M6 — expo-tracking-transparency stub.
module.exports = {
  getTrackingPermissionsAsync: () => Promise.resolve({ status: "undetermined" }),
  requestTrackingPermissionsAsync: () => Promise.resolve({ status: "denied" }),
  PermissionStatus: {
    UNDETERMINED: "undetermined",
    DENIED: "denied",
    GRANTED: "granted",
    RESTRICTED: "restricted",
  },
};
