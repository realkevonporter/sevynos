// SevynOS M6 — expo-haptics stub. No haptics hardware in QEMU.
const ok = () => Promise.resolve();
module.exports = {
  impactAsync: ok,
  notificationAsync: ok,
  selectionAsync: ok,
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Rigid: "rigid",
    Soft: "soft",
  },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
};
