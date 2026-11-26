// SevynOS v2 — key-modifier state (gap build unit 1).
//
// Tracks the Ctrl / Alt / Super(= Meta) modifier keys by evdev
// keycode, the same way the host already tracked Shift (wayland.cc):
// the host reads no xkb keymap (it closes the keymap fd unread),
// so modifiers are tracked by keycode, not by keysym — layout
// independent, and the same codes on every PC keyboard.
//
//   Shift  42 left, 54 right
//   Ctrl   29 left, 97 right
//   Alt    56 left, 100 right
//   Meta   125 left, 126 right (the Super / Windows key; evdev has
//          no separate Super keycode, so super() and meta() are the
//          same state under two names)
//
// Per-side booleans, so holding both keys of a pair and releasing
// one still counts as held. Dependency-free (no Wayland headers),
// so the state machine is unit-testable without a compositor —
// see test-key-modifiers.cc. The Wayland layer (wayland.cc) owns
// one instance and hands a snapshot to JS with every key event.
#pragma once

#include <cstdint>

namespace sevyn {

class KeyModifiers {
 public:
  // Feed one Wayland keyboard key event. Modifier keys update the
  // state; every other key leaves it untouched.
  void onKey(uint32_t key, bool pressed) {
    const bool down = pressed;
    switch (key) {
      case 42:
        shiftLeft_ = down;
        break;
      case 54:
        shiftRight_ = down;
        break;
      case 29:
        ctrlLeft_ = down;
        break;
      case 97:
        ctrlRight_ = down;
        break;
      case 56:
        altLeft_ = down;
        break;
      case 100:
        altRight_ = down;
        break;
      case 125:
        metaLeft_ = down;
        break;
      case 126:
        metaRight_ = down;
        break;
      default:
        break;
    }
  }

  // True for either Shift key. Shift keys are state only: the
  // Wayland layer swallows them and never forwards them as key
  // events (pre-existing behaviour, unchanged).
  bool isShiftKey(uint32_t key) const { return key == 42 || key == 54; }
  // True for any modifier key (Shift, Ctrl, Alt, Meta).
  bool isModifierKey(uint32_t key) const {
    return isShiftKey(key) || key == 29 || key == 97 || key == 56 ||
           key == 100 || key == 125 || key == 126;
  }

  // Set the Shift state wholesale. Only the headless input path
  // uses this: its `key` lines carry shift as a single flag, not
  // per-side keycodes.
  void setShift(bool down) {
    shiftLeft_ = down;
    shiftRight_ = down;
  }

  bool shift() const { return shiftLeft_ || shiftRight_; }
  bool ctrl() const { return ctrlLeft_ || ctrlRight_; }
  bool alt() const { return altLeft_ || altRight_; }
  bool super() const { return metaLeft_ || metaRight_; }
  // Meta is the Super key on evdev — same state, second name.
  bool meta() const { return super(); }

 private:
  bool shiftLeft_ = false;
  bool shiftRight_ = false;
  bool ctrlLeft_ = false;
  bool ctrlRight_ = false;
  bool altLeft_ = false;
  bool altRight_ = false;
  bool metaLeft_ = false;
  bool metaRight_ = false;
};

} // namespace sevyn
