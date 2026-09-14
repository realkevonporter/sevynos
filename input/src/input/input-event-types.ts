export type InputEventType =
  | "pointer-move"
  | "pointer-down"
  | "pointer-up"
  | "pointer-cancel"
  | "key-down"
  | "key-up"
  | "wheel"
  | "touch-start"
  | "touch-move"
  | "touch-end"
  | "touch-cancel";

export type InputDeviceKind =
  "mouse" | "touchpad" | "keyboard" | "touchscreen" | "stylus" | "unknown";
