// SevynOS v2 M3 — Wayland client for the RN host.
//
// One xdg_toplevel surface. The shell runs fullscreen at the output's
// preferred mode (M9 — weston.ini no longer pins 1024x768); an app
// runs windowed (800x500) with its own title and app id, and the
// compositor's close request ends the app (the shell is not closable).
// M9: the toplevel configure is honored — a resize drag or an output
// mode change resizes the painters and fires the size handler; a
// left-button press in the title bar (minus the close-X zone) starts
// an interactive move, and in the 8px right/bottom edge strips an
// interactive resize. Double-buffered SHM: two Painters, each with
// its own wl_buffer; a buffer is only reused after the compositor
// releases it, so frames never tear. Pointer + keyboard events are
// forwarded to the host.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <wayland-client.h>
#include <wayland-cursor.h>

#include "common.h"
#include "painter.h"

struct xdg_wm_base;
struct xdg_surface;
struct xdg_toplevel;

namespace sevyn {

class Wayland {
 public:
  // Pointer event: type is "enter" | "leave" | "motion" | "button".
  // button is the Linux input button code (0x110 left, 0x111 right…);
  // pressed is meaningful for button events.
  using PointerHandler =
      std::function<void(const std::string& type, double x, double y,
                         uint32_t button, bool pressed)>;
  // Scroll event (GF65 fix, 2026-11-10): a wheel click or a
  // trackpad two-finger scroll, accumulated per pointer frame.
  // (x, y) is the pointer position; (dx, dy) is the scroll amount
  // in pixels — positive dy scrolls DOWN (content moves up),
  // positive dx scrolls RIGHT. Matches the renderer's scrollAt
  // convention (scrollY += dy), so the handler forwards as-is.
  using ScrollHandler =
      std::function<void(double x, double y, double dx, double dy)>;
  // Key event: evdev keycode (28 Enter, 103 Up, 105 Left, 106 Right,
  // 108 Down, 15 Tab, 1 Esc…), pressed or released. shift is the
  // state of either Shift key at the moment of the event (tracked in
  // wayland.cc — the host reads no xkb keymap, so modifiers are
  // tracked by keycode, not by keysym).
  using KeyHandler =
      std::function<void(uint32_t key, bool pressed, bool shift)>;
  // Frame callback: the compositor is ready for the next frame.
  using FrameHandler = std::function<void()>;
  // Close request from the compositor (window X / Alt-F4). Set for
  // app windows; the shell leaves it unset (not closable).
  using CloseHandler = std::function<void()>;
  // Surface size changed (M9): the compositor's configure gave the
  // surface a new size (app resize drag, or the fullscreen shell's
  // output mode). The painters are already resized when this fires;
  // the host re-lays out JS to the new size.
  using SizeHandler = std::function<void(int width, int height)>;

  // fullscreen=false makes a windowed toplevel with the given title
  // and app id instead of a fullscreen shell surface.
  Wayland(int width, int height, bool fullscreen = true,
          const std::string& title = "SevynOS Shell",
          const std::string& appId = "sevyn-shell");
  ~Wayland();

  Wayland(const Wayland&) = delete;
  Wayland& operator=(const Wayland&) = delete;

  bool ok() const { return ok_; }
  int width() const { return width_; }
  int height() const { return height_; }

  // Painter used for text measurement (fonts are shared by both buffers).
  Painter& painter() { return *painters_[0]; }

  // Paint ops into a free back buffer and present it. If both buffers
  // are busy, the frame is remembered and presented on the next frame
  // callback or buffer release instead.
  void present(const std::vector<DrawOp>& ops, uint32_t bg);

  // Non-blocking dispatch round. Returns false if the display is gone.
  bool dispatch(int timeoutMs);

  void setPointerHandler(PointerHandler h) { pointerHandler_ = h; }
  void setScrollHandler(ScrollHandler h) { scrollHandler_ = h; }
  void setKeyHandler(KeyHandler h) { keyHandler_ = h; }
  void setFrameHandler(FrameHandler h) { frameHandler_ = h; }
  void setCloseHandler(CloseHandler h) { closeHandler_ = h; }
  void setSizeHandler(SizeHandler h) { sizeHandler_ = h; }

  // Resize the surface to a new size (M9): destroy both wl_buffers
  // (doPresent recreates them at the new size), resize both
  // painters, and fire the size handler. A no-op for the current
  // size. The output mode is the shell's size — see outputWidth().
  void resize(int width, int height);
  // Remap (window-focus fix): destroy the wl_surface/xdg_toplevel
  // and create a fresh one (same title/app id/size). Weston's
  // desktop-shell activates a newly mapped toplevel and raises it
  // above the fullscreen shell — Weston 13 does NOT implement
  // xdg_activation_v1 (verified: the global is never advertised),
  // so re-creating the surface is the only Wayland-correct way to
  // raise a covered window. The painters survive (their SHM fds are
  // independent of the surface); a pending present is flushed by
  // the new surface's first configure. A maximized window is
  // re-maximized on the new surface.
  void remap();
  // Window state (xdg_toplevel): minimize hides the window (a dock
  // click restores it via remap); maximize/unmaximize toggle the
  // maximized state, which the compositor confirms through the
  // configure states array (see maximized()).
  void minimize();
  void maximize();
  void unmaximize();
  bool maximized() const { return maximized_; }
  // Fired when the compositor's configure changes the maximized
  // flag (maximize/unmaximize, or a title-bar drag that restores
  // a maximized window). The host forwards it to JS.
  using WindowStateHandler = std::function<void(bool maximized)>;
  void setWindowStateHandler(WindowStateHandler h) {
    windowStateHandler_ = h;
  }
  // Preferred output mode (0,0 when no wl_output mode arrived).
  int outputWidth() const { return outputWidth_; }
  int outputHeight() const { return outputHeight_; }

 private:
  // Create the wl_surface + xdg_surface + xdg_toplevel for the
  // current width_/height_/title_/appId_/fullscreen_ and collect the
  // initial configure. Used by the constructor and by remap().
  void createSurface();

  void onFrameDone();
  void onBufferRelease(int index);
  void doPresent();
  void requestFrame();
  void flushPending();
  // Set the pointer cursor (default arrow) from the enter serial.
  // Loads the theme lazily on first enter; a no-op until then.
  void setCursor(uint32_t serial);

  // Listener entry points (static so they can be C callbacks).
  static void onRegistryGlobal(void* data, wl_registry* registry,
                               uint32_t name, const char* interface,
                               uint32_t version);
  static void onRegistryGlobalRemove(void* data, wl_registry* registry,
                                     uint32_t name);
  // wl_output events: the mode events carry the output's preferred
  // (native) mode, which sizes the fullscreen shell (M9).
  static void onOutputGeometry(void* data, wl_output* output, int32_t x,
                               int32_t y, int32_t physicalWidth,
                               int32_t physicalHeight, int32_t subpixel,
                               const char* make, const char* model,
                               int32_t transform);
  static void onOutputMode(void* data, wl_output* output, uint32_t flags,
                           int32_t width, int32_t height, int32_t refresh);
  static void onOutputDone(void* data, wl_output* output);
  static void onOutputScale(void* data, wl_output* output, int32_t factor);
  static void onSeatCapabilities(void* data, wl_seat* seat,
                                 uint32_t capabilities);
  static void onSeatName(void* data, wl_seat* seat, const char* name);
  static void onXdgWmBasePing(void* data, xdg_wm_base* base,
                              uint32_t serial);
  static void onXdgSurfaceConfigure(void* data, xdg_surface* surface,
                                    uint32_t serial);
  static void onXdgToplevelConfigure(void* data, xdg_toplevel* toplevel,
                                     int32_t width, int32_t height,
                                     wl_array* states);
  static void onXdgToplevelClose(void* data, xdg_toplevel* toplevel);
  static void onBufferReleaseCb(void* data, wl_buffer* buffer);
  static void onFrameDoneCb(void* data, wl_callback* callback,
                            uint32_t time);
  static void onPointerEnter(void* data, wl_pointer* pointer,
                             uint32_t serial, wl_surface* surface,
                             wl_fixed_t sx, wl_fixed_t sy);
  static void onPointerLeave(void* data, wl_pointer* pointer,
                             uint32_t serial, wl_surface* surface);
  static void onPointerMotion(void* data, wl_pointer* pointer,
                              uint32_t time, wl_fixed_t sx, wl_fixed_t sy);
  static void onPointerButton(void* data, wl_pointer* pointer,
                              uint32_t serial, uint32_t time,
                              uint32_t button, uint32_t state);
  static void onPointerAxis(void* data, wl_pointer* pointer, uint32_t time,
                            uint32_t axis, wl_fixed_t value);
  static void onPointerFrame(void* data, wl_pointer* pointer);
  static void onPointerAxisSource(void* data, wl_pointer* pointer,
                                  uint32_t axis_source);
  static void onPointerAxisStop(void* data, wl_pointer* pointer,
                                uint32_t time, uint32_t axis);
  static void onPointerAxisDiscrete(void* data, wl_pointer* pointer,
                                    uint32_t axis, int32_t discrete);
  static void onKeyboardKeymap(void* data, wl_keyboard* keyboard,
                               uint32_t format, int32_t fd, uint32_t size);
  static void onKeyboardEnter(void* data, wl_keyboard* keyboard,
                              uint32_t serial, wl_surface* surface,
                              wl_array* keys);
  static void onKeyboardLeave(void* data, wl_keyboard* keyboard,
                              uint32_t serial, wl_surface* surface);
  static void onKeyboardKey(void* data, wl_keyboard* keyboard,
                            uint32_t serial, uint32_t time, uint32_t key,
                            uint32_t state);
  static void onKeyboardModifiers(void* data, wl_keyboard* keyboard,
                                  uint32_t serial, uint32_t mods_depressed,
                                  uint32_t mods_latched, uint32_t mods_locked,
                                  uint32_t group);
  static void onKeyboardRepeatInfo(void* data, wl_keyboard* keyboard,
                                   int32_t rate, int32_t delay);

  int width_, height_;
  bool fullscreen_;
  std::string title_;
  std::string appId_;
  bool ok_ = false;
  wl_display* display_ = nullptr;
  wl_registry* registry_ = nullptr;
  wl_compositor* compositor_ = nullptr;
  wl_shm* shm_ = nullptr;
  wl_output* output_ = nullptr;
  // Preferred output mode from wl_output (M9 fullscreen): 0,0 until
  // a mode event arrives. The shell sizes its painters to this when
  // known, so the desktop fills the panel at native resolution.
  int outputWidth_ = 0;
  int outputHeight_ = 0;
  // True once a PREFERRED mode event arrived: preferred always wins
  // over a merely CURRENT mode (they can differ).
  bool outputPreferred_ = false;
  wl_seat* seat_ = nullptr;
  xdg_wm_base* xdgWmBase_ = nullptr;
  wl_surface* surface_ = nullptr;
  xdg_surface* xdgSurface_ = nullptr;
  xdg_toplevel* xdgToplevel_ = nullptr;
  wl_pointer* pointer_ = nullptr;
  wl_keyboard* keyboard_ = nullptr;
  // Pointer cursor: one static arrow for the whole shell/apps. The
  // theme is loaded lazily on first pointer enter (shm_ is bound by
  // then); cursor_ is owned by the theme, not by us.
  wl_cursor_theme* cursorTheme_ = nullptr;
  wl_cursor* cursor_ = nullptr;
  wl_surface* cursorSurface_ = nullptr;
  bool cursorTried_ = false;
  bool cursorLogged_ = false;

  std::unique_ptr<Painter> painters_[2];
  wl_buffer* buffers_[2] = {nullptr, nullptr};
  bool busy_[2] = {false, false};
  int back_ = 0;
  // Index of the most recently committed buffer (-1 if none). A frame
  // callback proves the compositor presented a frame, which always
  // shows the latest committed buffer — so on frame-done the OTHER
  // buffer is off-screen and reusable. This is the release path the
  // client can rely on: Weston does not send wl_buffer.release for
  // these SHM buffers in this guest (verified: zero releases across
  // a whole M2 run while presents stalled), so depending on releases
  // alone freezes the screen after two frames.
  int lastCommitted_ = -1;

  bool havePending_ = false;
  std::vector<DrawOp> pendingOps_;
  uint32_t pendingBg_ = 0;

  bool framePending_ = false;
  // The pending frame callback (owned here so remap() can destroy
  // it: destroying the surface leaves the callback orphaned, and a
  // stale framePending_ would block every later frame request).
  wl_callback* frameCallback_ = nullptr;
  bool configured_ = false;

  // Maximized state from the compositor's configure states array
  // (xdg_toplevel state MAXIMIZED). Set only by the configure
  // handler — never assumed from a maximize() call.
  bool maximized_ = false;
  // While remap() recreates the surface, the new surface's initial
  // configure carries no states — suppress the state handler there
  // so a maximized window does not flicker to "restored" mid-remap.
  bool suppressWindowState_ = false;
  // While a maximize/unmaximize is in flight (set_*_maximized sent,
  // configure not yet processed), presents are deferred (see
  // doPresent). A commit at the OLD size after the request but
  // before the configure poisons the compositor's reposition: Weston
  // applies the maximized position only on the first post-configure
  // commit at the new size, and an old-size commit in between leaves
  // the window at its cascade position at the new size (verified
  // against Weston 13 with a minimal client: an old-size commit
  // 2ms after set_maximized breaks it; a second new-size commit
  // 250ms later is harmless). The button-press release re-render
  // presents exactly such an old-size frame, so the gate has to live
  // here, not in the JS. Cleared by onXdgToplevelConfigure.
  bool sizeChangePending_ = false;
  // After a maximize/unmaximize configure, commit once more when the
  // frame callback for the first frame at the new size fires. The
  // compositor (Weston on DRM) repositions a window on commit, but
  // the first post-configure commit can land before it has armed
  // the reposition — the window then sits at its cascade position
  // at the new size until a later commit (in CI the maximized
  // calculator only reached (0,0) when the Files launch
  // re-evaluated the scene). A settle commit after the first
  // presented frame gives the compositor a second,
  // definitely-armed chance. Set on any maximize/unmaximize
  // configure, consumed once in onFrameDone.
  bool maximizeSettlePending_ = false;
  // Pre-maximize size, saved when a maximize configure lands. On
  // unmaximize Weston may send a configure with no size (0,0) or
  // echo the maximized size; without a saved size the host would
  // keep the maximized size and the window would stay fullscreen
  // (its header at y=0, invisible to the check's y0=48 band).
  int savedWidth_ = 0;
  int savedHeight_ = 0;
  // Set in onXdgToplevelConfigure when an unmaximize configure
  // carries no size (or echoes the maximized size): the host must
  // restore to the saved pre-maximize size, but NOT in that
  // handler. The compositor only clears its maximized bookkeeping
  // when the client acks the configure (onXdgSurfaceConfigure),
  // and committing 800x500 before the ack makes Weston raise
  // xdg_wm_base error 4 ("geometry does not match the configured
  // maximized state") and kill the connection. So the resize is
  // deferred to onXdgSurfaceConfigure, which acks first and then
  // applies the pending restore.
  bool restorePending_ = false;
  WindowStateHandler windowStateHandler_;

  // Either Shift key held (evdev 42 left, 54 right). The host reads no
  // xkb keymap, so modifiers are tracked by keycode here and forwarded
  // with every key event (see onKeyboardKey). Per-key booleans, so
  // holding both Shifts and releasing one still counts as Shift.
  bool shiftLeft_ = false;
  bool shiftRight_ = false;

  PointerHandler pointerHandler_;
  ScrollHandler scrollHandler_;
  KeyHandler keyHandler_;
  FrameHandler frameHandler_;
  CloseHandler closeHandler_;
  SizeHandler sizeHandler_;

  // M9 window geometry: the title bar is 44px on every app surface
  // (template + Settings/Terminal/Files/Browser), and the close X
  // lives in the rightmost ~40px of it. The move region is the title
  // bar minus the button zone; the resize zones are 8px strips on
  // the right and bottom edges (+ the bottom-right corner). Minimum
  // window size after a resize drag.
  // The button zone is 100px: three 28px buttons (minimize,
  // maximize/restore, close) + 12px right padding. A press inside
  // it must reach the JS Pressables, never start a move drag.
  static constexpr int kTitleBarHeight = 44;
  static constexpr int kCloseZoneWidth = 100;
  static constexpr int kResizeEdge = 8;
  static constexpr int kMinWidth = 480;
  static constexpr int kMinHeight = 320;

  double pointerX_ = 0, pointerY_ = 0;

  // GF65 scroll fix: wheel/trackpad axis events accumulate here
  // between pointer frames and flush as one scroll event in
  // onPointerFrame (Weston groups one gesture's axis events into a
  // frame). axisAccum_ is the wl_fixed value sum (pixels for smooth
  // trackpad scrolling); axisDiscrete_ counts wheel clicks — when a
  // frame has discrete steps, the click count wins over the axis
  // value for that axis, because libinput reports ~10 axis units
  // per click alongside the discrete event and using both would
  // double-scroll.
  double axisAccumX_ = 0, axisAccumY_ = 0;
  int axisDiscreteX_ = 0, axisDiscreteY_ = 0;
  bool axisPending_ = false;
  // One wheel click moves this many pixels. A click is a coarse
  // gesture — the raw ~10 axis units per click would crawl.
  static constexpr double kWheelStepPx = 48;
};

} // namespace sevyn
