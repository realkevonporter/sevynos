// SevynOS v2 — quit-shortcut test (gap build unit 7, audit #8).
//
// Drives the real KeyModifiers state machine (key-modifiers.h)
// through the evdev key sequences a Wayland keyboard delivers,
// proving, with no Wayland, no compositor and no Hermes:
//   1. Alt+F4 (left Alt 56 and right Alt 100) is a quit chord: the
//      host quits a closable app, and swallows the chord — never
//      forwards it — for the shell, which is not closable.
//   2. Super+Q (left Super 125 and right Super 126, Meta being the
//      same state) is the same quit chord, both closable and shell.
//   3. A plain F4 (no modifier) does nothing; a plain Q does
//      nothing; releases never quit.
//   4. The chord is never forwarded to JS — so a focused TextInput
//      cannot swallow it: Super+Q would otherwise type a 'q' (the
//      renderer types any KEYMAP key when only Super is held), and
//      Alt+F4 would be ignored entirely.
//   5. Neighbour chords are untouched: Alt+Q, Super+F4, Ctrl+F4,
//      Ctrl+Q, Alt+Tab, Alt+Enter, Super+Tab and the other F-keys
//      all forward normally. Alt+Tab is window switching, a later
//      unit — it must not quit.
//   6. Extra modifiers do not block the chord (Alt+Shift+F4 still
//      quits), and a held-chord repeat still quits.
//
// The dispatch wiring (RnHost::dispatchKey calls
// quitShortcutAction with closable = !appId_.empty() — the same
// condition Sevyn.closeApp() uses — and sets exitRequested_, the
// same flag closeApp and the compositor close request set) is
// proven by the host-compile job and by the GF65 on-device proof
// in the PR body, not here.
//
// Build: g++ -O2 -std=c++17 -Wall -Wextra -I v2/rn/host
//        -o /tmp/test-quit-shortcut v2/rn/host/test-quit-shortcut.cc
//        && /tmp/test-quit-shortcut
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

// Feed a press/release into the state machine and ask what the
// host does with it. closable = the app has an appId (an app
// window); false = the shell.
QuitAction act(KeyModifiers& m, uint32_t key, bool pressed, bool closable) {
  m.onKey(key, pressed);
  return quitShortcutAction(key, pressed, m, closable);
}

}  // namespace

int main() {
  // The chord keycodes are the evdev codes, not characters.
  check(kQuitF4Key == 62, "codes: KEY_F4 is 62");
  check(kQuitQKey == 16, "codes: KEY_Q is 16");

  // 1. Alt+F4 quits a closable app; the shell swallows it.
  {
    KeyModifiers m;
    check(act(m, 62, true, true) == QuitAction::kForward,
          "alt-f4: plain F4 does nothing");
    check(act(m, 56, true, true) == QuitAction::kForward,
          "alt-f4: Alt press itself forwards");
    check(act(m, 62, true, true) == QuitAction::kQuit,
          "alt-f4: left Alt + F4 quits the app");
    check(act(m, 62, false, true) == QuitAction::kForward,
          "alt-f4: F4 release with Alt held does nothing");
    check(act(m, 56, false, true) == QuitAction::kForward,
          "alt-f4: Alt release forwards");
    check(act(m, 62, true, true) == QuitAction::kForward,
          "alt-f4: F4 after Alt released does nothing");
  }
  {
    KeyModifiers m;
    m.onKey(56, true);  // left Alt down
    check(quitShortcutAction(62, true, m, false) == QuitAction::kSwallow,
          "alt-f4: shell swallows the chord (not closable)");
    check(quitShortcutAction(62, true, m, true) == QuitAction::kQuit,
          "alt-f4: same state quits a closable app");
  }
  {
    // Right Alt, and both Alts held with one released.
    KeyModifiers m;
    m.onKey(100, true);  // right Alt down
    check(quitShortcutAction(62, true, m, true) == QuitAction::kQuit,
          "alt-f4: right Alt + F4 quits");
    m.onKey(56, true);  // left Alt down too
    m.onKey(56, false);  // left Alt up — right still held
    check(m.alt(), "alt-f4: releasing one Alt still counts as held");
    check(quitShortcutAction(62, true, m, true) == QuitAction::kQuit,
          "alt-f4: one Alt held still quits");
    m.onKey(100, false);
    check(!m.alt(), "alt-f4: both Alts up clears alt");
    check(quitShortcutAction(62, true, m, true) == QuitAction::kForward,
          "alt-f4: no Alt held, F4 does nothing");
  }
  {
    // A held-chord repeat still quits (the compositor repeats the
    // press while F4 is held; the first press already asked to exit,
    // the repeat must not resurrect the key as input).
    KeyModifiers m;
    m.onKey(56, true);
    check(quitShortcutAction(62, true, m, true) == QuitAction::kQuit,
          "alt-f4: first F4 press quits");
    check(quitShortcutAction(62, true, m, true) == QuitAction::kQuit,
          "alt-f4: repeated F4 press still quits, never forwards");
  }

  // 2. Super+Q is the same chord (Super is the Cmd key on SevynOS).
  {
    KeyModifiers m;
    check(act(m, 16, true, true) == QuitAction::kForward,
          "super-q: plain Q does nothing");
    check(act(m, 125, true, true) == QuitAction::kForward,
          "super-q: Super press itself forwards");
    check(act(m, 16, true, true) == QuitAction::kQuit,
          "super-q: left Super + Q quits the app");
    check(act(m, 16, false, true) == QuitAction::kForward,
          "super-q: Q release with Super held does nothing");
    check(act(m, 125, false, true) == QuitAction::kForward,
          "super-q: Super release forwards");
  }
  {
    KeyModifiers m;
    m.onKey(126, true);  // right Super down
    check(m.super() && m.meta(),
          "super-q: right Super sets super and meta (same state)");
    check(quitShortcutAction(16, true, m, true) == QuitAction::kQuit,
          "super-q: right Super + Q quits");
    check(quitShortcutAction(16, true, m, false) == QuitAction::kSwallow,
          "super-q: shell swallows the chord (not closable)");
  }

  // 3. The chord never reaches JS, in either closable state — so a
  // focused TextInput cannot swallow Super+Q as a typed 'q'.
  {
    KeyModifiers m;
    m.onKey(56, true);
    check(quitShortcutAction(62, true, m, true) != QuitAction::kForward,
          "textinput: Alt+F4 never forwards to a focused input (app)");
    check(quitShortcutAction(62, true, m, false) != QuitAction::kForward,
          "textinput: Alt+F4 never forwards to a focused input (shell)");
    KeyModifiers n;
    n.onKey(125, true);
    check(quitShortcutAction(16, true, n, true) != QuitAction::kForward,
          "textinput: Super+Q never forwards to a focused input (app)");
    check(quitShortcutAction(16, true, n, false) != QuitAction::kForward,
          "textinput: Super+Q never forwards to a focused input (shell)");
  }

  // 4. Neighbour chords forward normally — none of them quits.
  {
    KeyModifiers m;
    m.onKey(56, true);  // Alt held
    check(quitShortcutAction(16, true, m, true) == QuitAction::kForward,
          "neighbours: Alt+Q forwards (not a quit chord)");
    check(quitShortcutAction(15, true, m, true) == QuitAction::kForward,
          "neighbours: Alt+Tab forwards (window switching, later unit)");
    check(quitShortcutAction(28, true, m, true) == QuitAction::kForward,
          "neighbours: Alt+Enter forwards");
    check(quitShortcutAction(59, true, m, true) == QuitAction::kForward,
          "neighbours: Alt+F1 forwards");
    check(quitShortcutAction(63, true, m, true) == QuitAction::kForward,
          "neighbours: Alt+F5 forwards");
    m.onKey(56, false);
    m.onKey(125, true);  // Super held
    check(quitShortcutAction(62, true, m, true) == QuitAction::kForward,
          "neighbours: Super+F4 forwards (not a quit chord)");
    check(quitShortcutAction(15, true, m, true) == QuitAction::kForward,
          "neighbours: Super+Tab forwards");
    check(quitShortcutAction(28, true, m, true) == QuitAction::kForward,
          "neighbours: Super+Enter forwards");
    m.onKey(125, false);
    m.onKey(29, true);  // Ctrl held
    check(quitShortcutAction(62, true, m, true) == QuitAction::kForward,
          "neighbours: Ctrl+F4 forwards (not a quit chord)");
    check(quitShortcutAction(16, true, m, true) == QuitAction::kForward,
          "neighbours: Ctrl+Q forwards (not a SevynOS chord)");
  }

  // 5. Extra modifiers do not block the chord.
  {
    KeyModifiers m;
    m.onKey(56, true);   // Alt
    m.onKey(42, true);   // left Shift too
    check(quitShortcutAction(62, true, m, true) == QuitAction::kQuit,
          "extra-mods: Alt+Shift+F4 still quits");
    KeyModifiers n;
    n.onKey(125, true);  // Super
    n.onKey(54, true);   // right Shift too
    check(quitShortcutAction(16, true, n, true) == QuitAction::kQuit,
          "extra-mods: Super+Shift+Q still quits");
    KeyModifiers o;
    o.onKey(56, true);  // Alt
    o.onKey(29, true);  // Ctrl too
    check(quitShortcutAction(62, true, o, true) == QuitAction::kQuit,
          "extra-mods: Ctrl+Alt+F4 still quits");
  }

  if (failures == 0) {
    printf("QUIT-SHORTCUT-TEST all checks passed\n");
    return 0;
  }
  printf("QUIT-SHORTCUT-TEST %d failure(s)\n", failures);
  return 1;
}
