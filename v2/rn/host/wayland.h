// SevynOS v2 M3 — Wayland client for the RN host.
//
// One xdg_toplevel surface. The shell runs fullscreen (1024x768, the
// Weston output mode); an app runs windowed (800x500) with its own
// title and app id, and the compositor's close request ends the app
// (the shell is not closable). Double-buffered SHM: two Painters, each
// with its own wl_buffer; a buffer is only reused after the compositor
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
  void setKeyHandler(KeyHandler h) { keyHandler_ = h; }
  void setFrameHandler(FrameHandler h) { frameHandler_ = h; }
  void setCloseHandler(CloseHandler h) { closeHandler_ = h; }

 private:
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
  bool configured_ = false;

  // Either Shift key held (evdev 42 left, 54 right). The host reads no
  // xkb keymap, so modifiers are tracked by keycode here and forwarded
  // with every key event (see onKeyboardKey). Per-key booleans, so
  // holding both Shifts and releasing one still counts as Shift.
  bool shiftLeft_ = false;
  bool shiftRight_ = false;

  PointerHandler pointerHandler_;
  KeyHandler keyHandler_;
  FrameHandler frameHandler_;
  CloseHandler closeHandler_;

  double pointerX_ = 0, pointerY_ = 0;
};

} // namespace sevyn
