// SevynOS v2 — key-modifier state test (gap build unit 1).
//
// Drives the real KeyModifiers state machine (key-modifiers.h) with
// the evdev keycodes a Wayland keyboard delivers, proving, with no
// Wayland, no compositor and no Hermes:
//   1. Ctrl pressed/released (left 29 and right 97), alone and
//      held together (releasing one side still counts as held).
//   2. Alt pressed/released (left 56 and right 100).
//   3. Super/Meta pressed/released (left 125 and right 126), and
//      that meta() is the same state as super().
//   4. a combination: Ctrl held while another key fires — the
//      modifier state survives the other key's press and release.
//   5. Shift behaviour is unchanged: either Shift key (42/54)
//      sets shift() and nothing else, and is classified as a
//      Shift key; non-modifier keys touch no state at all.
//
// The Wayland wiring (wayland.cc hands the snapshot to JS with
// every key event) is proven by the host-compile job and by the
// GF65 on-device proof in the PR body, not here.
//
// Build: g++ -O2 -std=c++17 -Wall -Wextra -I v2/rn/host
//        -o /tmp/test-key-modifiers v2/rn/host/test-key-modifiers.cc
//        && /tmp/test-key-modifiers
#include <cstdio>
#include <string>

#include "key-modifiers.h"

using namespace sevyn;

namespace {

int failures = 0;

void check(bool ok, const std::string& name, const std::string& detail = "") {
  if (ok) {
    printf("ok - %s%s\n", name.c_str(),
           detail.empty() ? "" : (" (" + detail + ")").c_str());
  } else {
    printf("FAIL - %s%s\n", name.c_str(),
           detail.empty() ? "" : (" (" + detail + ")").c_str());
    failures++;
  }
}

// Nothing held.
void checkClear(const KeyModifiers& m, const std::string& name) {
  check(!m.shift() && !m.ctrl() && !m.alt() && !m.super() && !m.meta(),
        name);
}

} // namespace

int main() {
  // 1. Ctrl pressed/released, left then right, then both together.
  {
    KeyModifiers m;
    checkClear(m, "ctrl: initial state clear");
    m.onKey(29, true); // left Ctrl down
    check(m.ctrl() && !m.shift() && !m.alt() && !m.super(),
          "ctrl: left press sets ctrl only");
    m.onKey(29, false); // left Ctrl up
    checkClear(m, "ctrl: left release clears");
    m.onKey(97, true); // right Ctrl down
    check(m.ctrl(), "ctrl: right press sets ctrl");
    m.onKey(97, false);
    checkClear(m, "ctrl: right release clears");
    m.onKey(29, true);
    m.onKey(97, true);
    check(m.ctrl(), "ctrl: both sides held");
    m.onKey(29, false); // release one side only
    check(m.ctrl(), "ctrl: still held after one side releases");
    m.onKey(97, false);
    checkClear(m, "ctrl: clear after both sides release");
  }

  // 2. Alt pressed/released, left then right, then both together.
  {
    KeyModifiers m;
    m.onKey(56, true); // left Alt down
    check(m.alt() && !m.ctrl() && !m.shift() && !m.super(),
          "alt: left press sets alt only");
    m.onKey(56, false);
    checkClear(m, "alt: left release clears");
    m.onKey(100, true); // right Alt down
    check(m.alt(), "alt: right press sets alt");
    m.onKey(100, false);
    checkClear(m, "alt: right release clears");
    m.onKey(56, true);
    m.onKey(100, true);
    m.onKey(56, false);
    check(m.alt(), "alt: still held after one side releases");
    m.onKey(100, false);
    checkClear(m, "alt: clear after both sides release");
  }

  // 3. Super/Meta pressed/released; meta() is the same state.
  {
    KeyModifiers m;
    m.onKey(125, true); // left Meta down
    check(m.super() && m.meta() && !m.ctrl() && !m.alt() && !m.shift(),
          "super: left press sets super and meta");
    m.onKey(125, false);
    checkClear(m, "super: left release clears");
    m.onKey(126, true); // right Meta down
    check(m.super() && m.meta(), "super: right press sets super and meta");
    m.onKey(126, false);
    checkClear(m, "super: right release clears");
    m.onKey(125, true);
    m.onKey(126, true);
    m.onKey(125, false);
    check(m.super() && m.meta(),
          "super: still held after one side releases");
    m.onKey(126, false);
    checkClear(m, "super: clear after both sides release");
  }

  // 4. Combination: Ctrl held while another key fires.
  {
    KeyModifiers m;
    m.onKey(29, true);  // left Ctrl down
    m.onKey(46, true);  // 'c' down (evdev 46)
    check(m.ctrl() && !m.shift() && !m.alt() && !m.super(),
          "combo: ctrl still held while c is down");
    m.onKey(46, false); // 'c' up
    check(m.ctrl(), "combo: ctrl still held after c releases");
    m.onKey(29, false); // Ctrl up
    checkClear(m, "combo: clear after ctrl releases");
    // Two modifiers at once, then one releases.
    m.onKey(29, true);
    m.onKey(56, true);
    check(m.ctrl() && m.alt(), "combo: ctrl+alt both held");
    m.onKey(29, false);
    check(!m.ctrl() && m.alt(), "combo: alt survives ctrl release");
    m.onKey(56, false);
    checkClear(m, "combo: clear after both release");
  }

  // 5. Shift behaviour is unchanged.
  {
    KeyModifiers m;
    m.onKey(42, true); // left Shift down
    check(m.shift() && !m.ctrl() && !m.alt() && !m.super(),
          "shift: left press sets shift only");
    m.onKey(42, false);
    checkClear(m, "shift: left release clears");
    m.onKey(54, true); // right Shift down
    check(m.shift(), "shift: right press sets shift");
    m.onKey(54, false);
    checkClear(m, "shift: right release clears");
    m.onKey(42, true);
    m.onKey(54, true);
    m.onKey(42, false);
    check(m.shift(), "shift: still held after one side releases");
    m.onKey(54, false);
    checkClear(m, "shift: clear after both sides release");
    // setShift (headless path) sets and clears both sides at once.
    m.setShift(true);
    check(m.shift(), "shift: setShift(true) sets shift");
    m.setShift(false);
    checkClear(m, "shift: setShift(false) clears shift");
    // Classification: shift keys are shift keys and modifier keys;
    // ctrl/alt/meta are modifier keys but not shift keys; a plain
    // key (30 'a') is neither.
    check(m.isShiftKey(42) && m.isShiftKey(54), "classify: shifts are shift");
    check(!m.isShiftKey(29) && !m.isShiftKey(56) && !m.isShiftKey(125),
          "classify: ctrl/alt/meta are not shift");
    check(m.isModifierKey(42) && m.isModifierKey(54) &&
              m.isModifierKey(29) && m.isModifierKey(97) &&
              m.isModifierKey(56) && m.isModifierKey(100) &&
              m.isModifierKey(125) && m.isModifierKey(126),
          "classify: all modifier keys are modifiers");
    check(!m.isModifierKey(30) && !m.isShiftKey(30),
          "classify: plain key is not a modifier");
    // A plain key press/release touches no modifier state.
    m.onKey(30, true);
    checkClear(m, "shift: plain key down touches no state");
    m.onKey(30, false);
    checkClear(m, "shift: plain key up touches no state");
  }

  if (failures == 0) {
    printf("KEY-MODIFIERS-TEST all checks passed\n");
    return 0;
  }
  printf("KEY-MODIFIERS-TEST %d failure(s)\n", failures);
  return 1;
}
