// SevynOS v2 M3 — Wayland client for the RN host.
//
// The shell is a layer-shell Background surface when the compositor
// offers zwlr_layer_shell_v1 (Genesis Stage 4+; the Shell must never
// be raisable above app windows, so it is not a toplevel at all —
// a click on the desktop reaches it without raising it). With no
// layer-shell global (e.g. Weston dev), the shell falls back to a
// fullscreen xdg_toplevel. An app runs windowed (800x500) with its
// own title and app id, and the compositor's close request ends the
// app (the shell is not closable). M9: the toplevel configure is
// honored — a resize drag or an output mode change resizes the
// painters and fires the size handler; a left-button press in the
// title bar (minus the close-X zone) starts an interactive move, and
// in the 8px right/bottom edge strips an interactive resize.
// Double-buffered SHM: two Painters, each with its own wl_buffer; a
// buffer is only reused after the compositor releases it, so frames
// never tear. Pointer + keyboard events are forwarded to the host.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <wayland-client.h>
#include <wayland-cursor.h>

#include "common.h"
#include "genesis-presenter.h"
#include "key-modifiers.h"
#include "painter.h"
#include "text-clipboard.h"

struct xdg_wm_base;
struct xdg_surface;
struct xdg_toplevel;
struct zwlr_layer_shell_v1;
struct zwlr_layer_surface_v1;
struct wl_data_device_manager;
struct wl_data_device;
struct wl_data_source;
struct wl_data_offer;

namespace sevyn {

class Wayland {
 public:
  // Pointer event: type is "enter" | "leave" | "motion" | "button".
  // button is the Linux input button code (0x110 left, 0x111 right…);
  // pressed is meaningful for button events. modifiers is the Ctrl /
  // Alt / Super(= Meta) / Shift state at the moment of the event
  // (gap unit 13, audit #22: the host's live snapshot — Shift keys
  // are swallowed as key events and never reach JS, so a click's
  // modifiers can only arrive on the pointer event itself).
  using PointerHandler = std::function<void(const std::string& type, double x,
                                            double y, uint32_t button, bool pressed,
                                            const KeyModifiers& modifiers)>;
  // Scroll event (GF65 fix, 2026-11-10): a wheel click or a
  // trackpad two-finger scroll, accumulated per pointer frame.
  // (x, y) is the pointer position; (dx, dy) is the scroll amount
  // in pixels — positive dy scrolls DOWN (content moves up),
  // positive dx scrolls RIGHT. Matches the renderer's scrollAt
  // convention (scrollY += dy), so the handler forwards as-is.
  using ScrollHandler =
      std::function<void(double x, double y, double dx, double dy)>;
  // Key event: evdev keycode (28 Enter, 103 Up, 105 Left, 106 Right,
  // 108 Down, 15 Tab, 1 Esc…), pressed or released. modifiers is the
  // Ctrl / Alt / Super(= Meta) / Shift state at the moment of the
  // event (tracked in wayland.cc — the host reads no xkb keymap, so
  // modifiers are tracked by keycode, not by keysym). Modifier keys
  // themselves are forwarded like any other key (except Shift,
  // which is swallowed — pre-existing behaviour), so JS sees a
  // modifier's own press/release as well as the state it lends to
  // the next key: a Ctrl press arrives with ctrl already true, a
  // Ctrl release with ctrl already false.
  using KeyHandler = std::function<void(uint32_t key, bool pressed,
                                        const KeyModifiers& modifiers)>;
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
  // True for the fullscreen shell surface (false for app windows).
  bool isFullscreen() const { return fullscreen_; }

  // Painter used for text measurement (fonts are shared by both buffers).
  Painter& painter() { return *painters_[0]; }

  // Paint ops into a free back buffer and present it. If both buffers
  // are busy, the frame is remembered and presented on the next frame
  // callback or buffer release instead.
  void present(const std::vector<DrawOp>& ops, uint32_t bg);

  // One input-region rect, in surface pixels.
  struct InputRect {
    int x, y, w, h;
    bool operator==(const InputRect& o) const {
      return x == o.x && y == o.y && w == o.w && h == o.h;
    }
  };

  // Restrict this surface's pointer input region to `rects`
  // (window-raise fix, #158 follow-up): with no layer-shell global
  // (Weston 13) the shell is a fullscreen xdg_toplevel, so any
  // pointer hit on it raises it above the app windows. The shell
  // host calls this on every present with the shell's interactive
  // rects (its Pressables + TextInputs only — the opaque top bar
  // is NOT added as a whole, only its own pressables such as the
  // tray Power button are in the list), so a click on empty
  // desktop or on the bar's empty stretch falls through to the
  // window below instead of raising the shell. App windows never call it — their
  // region stays the whole surface. A no-op when the rects are
  // unchanged since the last call (presents run every frame); an
  // empty list leaves the region untouched. No commit here: the
  // caller's present commits the surface in the same frame.
  void setInputRegion(const std::vector<InputRect>& rects);

  // Non-blocking dispatch round. Returns false if the display is gone.
  bool dispatch(int timeoutMs);

  // M12: evaluate the Genesis fps sample window on the host
  // main-loop tick (see GenesisPresenter::maybeLogFps). No-op when
  // Genesis is not live.
  void tickGenesis();

  void setPointerHandler(PointerHandler h) { pointerHandler_ = h; }
  void setScrollHandler(ScrollHandler h) { scrollHandler_ = h; }
  void setKeyHandler(KeyHandler h) { keyHandler_ = h; }
  void setFrameHandler(FrameHandler h) { frameHandler_ = h; }
  void setCloseHandler(CloseHandler h) { closeHandler_ = h; }
  void setSizeHandler(SizeHandler h) { sizeHandler_ = h; }

  // Text clipboard (gap unit 2, wl_data_device): the compositor's
  // selection, bridged to JS as Sevyn.clipboardRead/Write. Copy
  // offers the text as "text/plain"; paste reads the compositor's
  // current selection into the cache (see onDataDeviceSelection).
  // False when the compositor advertises no data-device manager
  // (Weston dev does; Genesis does since the clipboard build) —
  // copy/paste then stay local to this process, never fail.
  // Contents are never logged.
  void setClipboardText(const std::string& text);
  std::string clipboardText() const { return clipboard_.get(); }
  bool clipboardAvailable() const { return dataDeviceManager_ != nullptr; }

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
  // maximized state and setFullscreen/unsetFullscreen toggle the
  // fullscreen state, both confirmed by the compositor through the
  // configure states array (see maximized()/appFullscreen()).
  void minimize();
  void maximize();
  void unmaximize();
  void setFullscreen();
  void unsetFullscreen();
  bool maximized() const { return maximized_; }
  bool appFullscreen() const { return appFullscreen_; }
  // Fired when the compositor's configure changes the maximized or
  // fullscreen flag (maximize/unmaximize, setFullscreen/
  // unsetFullscreen, or a title-bar drag that restores a maximized
  // window), and when keyboard focus enters/leaves the window (the
  // active flag). The host forwards the full triple to JS, which
  // renders the title bar from it (glyph, fullscreen, dimming).
  // fullscreen_ (the shell's own fullscreen surface) is a different
  // flag: this handler never fires for the shell.
  using WindowStateHandler =
      std::function<void(bool maximized, bool fullscreen, bool active)>;
  void setWindowStateHandler(WindowStateHandler h) {
    windowStateHandler_ = h;
  }
  // Preferred output mode (0,0 when no wl_output mode arrived).
  int outputWidth() const { return outputWidth_; }
  int outputHeight() const { return outputHeight_; }

 private:
  // Create the wl_surface for the current width_/height_/title_/
  // appId_/fullscreen_ and collect the initial configure. Used by
  // the constructor and by remap(). The fullscreen shell prefers a
  // layer-shell Background surface (namespace "sevyn-shell") when
  // the compositor offers zwlr_layer_shell_v1, and falls back to a
  // fullscreen xdg_toplevel otherwise; app windows always use the
  // toplevel path.
  void createSurface();

  // Input-region plumbing for setInputRegion (see above): applies
  // `rects` to the current surface, clamping each rect to the
  // surface and dropping zero-area ones. A no-op on an empty list
  // (the region stays as it was) and without a surface/compositor.
  void applyInputRegion(const std::vector<InputRect>& rects);

  // Text clipboard (gap unit 2): bind the seat's data device once
  // both the manager global and the seat exist. A no-op when either
  // is missing or the device already exists.
  void maybeCreateDataDevice();

  void onFrameDone();
  void onBufferRelease(int index);
  void doPresent();
  // Genesis (M12): create the GPU presenter on first use (or return
  // false forever once it has failed / been disabled via
  // SEVYN_GENESIS=0). True means the GPU path is live.
  bool ensureGenesis();
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
  // Layer-shell surface events (shell only): the configure carries
  // the size the background must paint at — ack it, resize when it
  // differs (the first configure can carry the compositor's fallback
  // size; the corrected one follows the first commit), and flush
  // any pending present. Closed means the compositor killed the
  // background; the shell logs it (it has no close handler).
  static void onLayerSurfaceConfigure(void* data,
                                      zwlr_layer_surface_v1* layerSurface,
                                      uint32_t serial, uint32_t width,
                                      uint32_t height);
  static void onLayerSurfaceClosed(void* data,
                                   zwlr_layer_surface_v1* layerSurface);
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
  // Text clipboard (gap unit 2, wl_data_device): the source side
  // serves our copy on request; the offer/device side receives the
  // compositor's current selection. Contents are never logged.
  static void onDataSourceTarget(void* data, wl_data_source* source,
                                 const char* mime_type);
  static void onDataSourceSend(void* data, wl_data_source* source,
                               const char* mime_type, int32_t fd);
  static void onDataSourceCancelled(void* data, wl_data_source* source);
  static void onDataSourceDndDropPerformed(void* data,
                                           wl_data_source* source);
  static void onDataSourceDndFinished(void* data, wl_data_source* source);
  static void onDataSourceAction(void* data, wl_data_source* source,
                                 uint32_t dnd_action);
  static void onDataOfferOffer(void* data, wl_data_offer* offer,
                               const char* mime_type);
  static void onDataOfferSourceActions(void* data, wl_data_offer* offer,
                                       uint32_t actions);
  static void onDataOfferAction(void* data, wl_data_offer* offer,
                                uint32_t dnd_action);
  static void onDataDeviceDataOffer(void* data, wl_data_device* device,
                                    wl_data_offer* offer);
  static void onDataDeviceEnter(void* data, wl_data_device* device,
                                uint32_t serial, wl_surface* surface,
                                wl_fixed_t x, wl_fixed_t y,
                                wl_data_offer* offer);
  static void onDataDeviceLeave(void* data, wl_data_device* device);
  static void onDataDeviceMotion(void* data, wl_data_device* device,
                                 uint32_t time, wl_fixed_t x, wl_fixed_t y);
  static void onDataDeviceDrop(void* data, wl_data_device* device);
  static void onDataDeviceSelection(void* data, wl_data_device* device,
                                    wl_data_offer* offer);

  int width_, height_;
  bool fullscreen_;
  // Last input region applied by setInputRegion (empty until the
  // first present): re-applied when the surface is recreated, and
  // compared against so a present that changes nothing re-applies
  // nothing. Only ever non-empty for the shell surface.
  std::vector<InputRect> lastInputRects_;
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
  // Text clipboard (gap unit 2): the data-device manager global +
  // this seat's data device, created once both are bound (see
  // maybeCreateDataDevice — registry order is the compositor's
  // choice, so either bind can come first). dataSource_ is our
  // current copy offer (null when nothing copied); dataOffer_ is
  // the compositor's current selection offer (null when the
  // selection is clear); offerMimes_ is its MIME list, collected
  // from the offer events that precede the selection event.
  // clipboard_ is the cache: the last copied text, or the last
  // selection read from another client. lastInputSerial_ is the
  // most recent key/pointer serial — set_selection carries it
  // (Smithay ignores it, but the protocol asks for an input
  // serial, and a future compositor may check it).
  wl_data_device_manager* dataDeviceManager_ = nullptr;
  wl_data_device* dataDevice_ = nullptr;
  wl_data_source* dataSource_ = nullptr;
  wl_data_offer* dataOffer_ = nullptr;
  wl_data_offer* pendingOffer_ = nullptr;
  std::vector<std::string> pendingMimes_;
  std::vector<std::string> offerMimes_;
  TextClipboard clipboard_;
  uint32_t lastInputSerial_ = 0;
  xdg_wm_base* xdgWmBase_ = nullptr;
  wl_surface* surface_ = nullptr;
  xdg_surface* xdgSurface_ = nullptr;
  xdg_toplevel* xdgToplevel_ = nullptr;
  // Layer-shell (shell only): the zwlr_layer_shell_v1 global and
  // the Background layer surface, when the compositor offers it.
  // layerMode_ is true while the surface is a layer surface (never
  // for app windows); xdgSurface_/xdgToplevel_ stay null then.
  zwlr_layer_shell_v1* layerShell_ = nullptr;
  zwlr_layer_surface_v1* layerSurface_ = nullptr;
  bool layerMode_ = false;
  // Genesis (M12): the GPU present path. Created lazily on the first
  // present; null means "not attempted yet" (CPU painter in use) and
  // genesisDead_ means "attempted and unavailable — never retry".
  // Declared after surface_ so it is destroyed before the surface
  // (its wl_egl_window hangs off the surface).
  std::unique_ptr<GenesisPresenter> genesis_;
  bool genesisDead_ = false;
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
  // Fullscreen state of an APP window, from the configure states
  // array (xdg_toplevel state FULLSCREEN). Set only by the configure
  // handler — never assumed from a setFullscreen() call. Distinct
  // from fullscreen_ above, which marks the SHELL's own fullscreen
  // surface (an app window is never fullscreen_).
  bool appFullscreen_ = false;
  // Keyboard focus: true while the compositor has given this window
  // keyboard focus (onKeyboardEnter), false on leave. App windows
  // only — the shell's focus never reaches JS. Starts true: a newly
  // launched window is the foreground window, and a Leave dims it;
  // starting false would render every title bar dimmed until the
  // first Enter arrives.
  bool active_ = true;
  // Title-bar double-click (maximize toggle): timestamp of the last
  // press in the move region, from the Wayland event clock.
  uint32_t lastTitleBarPressMs_ = 0;
  bool haveLastTitleBarPress_ = false;
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

  // Modifier state (Ctrl / Alt / Super / Shift), tracked by evdev
  // keycode in onKeyboardKey and forwarded with every key event
  // (see KeyHandler). Per-key booleans inside KeyModifiers, so
  // holding both keys of a pair and releasing one still counts as
  // held. The host reads no xkb keymap, so the wl_keyboard
  // modifiers event is not used for this: its bitmask needs the
  // keymap to interpret, and the keymap fd is closed unread.
  KeyModifiers modifiers_;

  PointerHandler pointerHandler_;
  ScrollHandler scrollHandler_;
  KeyHandler keyHandler_;
  FrameHandler frameHandler_;
  CloseHandler closeHandler_;
  SizeHandler sizeHandler_;

  // M9 window geometry: the title bar is 40px on every app surface
  // (template + Settings/Terminal/Files/Browser, polish surface (b);
  // tokens.window.titleBarHeight), and the close X lives in the
  // rightmost ~40px of it. The move region is the title bar minus
  // the button zone; the resize zones are 8px strips on the right
  // and bottom edges (+ the bottom-right corner). Minimum window
  // size after a resize drag.
  // The button zone is 100px: three 28px buttons (minimize,
  // fullscreen, close) + 12px right padding. A press inside it must
  // reach the JS Pressables, never start a move drag.
  static constexpr int kTitleBarHeight = 40;
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
