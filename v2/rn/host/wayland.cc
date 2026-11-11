// SevynOS v2 M3 — Wayland client (see wayland.h).
#include "wayland.h"

#include <cerrno>
#include <cstdlib>
#include <poll.h>
#include <unistd.h>
#include <cstring>

#include <wayland-client-protocol.h>

#include "xdg-shell-client-protocol.h"

namespace sevyn {

// Listener tables are function-local statics at their use sites: they
// reference the private static callbacks, so namespace scope cannot
// name them.

Wayland::Wayland(int width, int height, bool fullscreen,
                 const std::string& title, const std::string& appId)
    : width_(width),
      height_(height),
      fullscreen_(fullscreen),
      title_(title),
      appId_(appId) {
  static const wl_registry_listener kRegistryListener = {
      &Wayland::onRegistryGlobal, &Wayland::onRegistryGlobalRemove};
  display_ = wl_display_connect(nullptr);
  if (!display_) {
    logLine("WAYLAND connect failed (WAYLAND_DISPLAY=%s)",
            getenv("WAYLAND_DISPLAY") ? getenv("WAYLAND_DISPLAY") : "(unset)");
    return;
  }
  registry_ = wl_display_get_registry(display_);
  wl_registry_add_listener(registry_, &kRegistryListener, this);
  // First roundtrip binds the globals; a second collects seat
  // capabilities (pointer/keyboard) once the seat is bound.
  if (wl_display_roundtrip(display_) < 0) {
    logLine("WAYLAND roundtrip failed");
    return;
  }
  if (wl_display_roundtrip(display_) < 0) {
    logLine("WAYLAND second roundtrip failed");
    return;
  }
  if (!compositor_ || !shm_ || !xdgWmBase_) {
    logLine("WAYLAND missing globals (compositor=%d shm=%d xdg=%d)",
            compositor_ != nullptr, shm_ != nullptr, xdgWmBase_ != nullptr);
    return;
  }
  // M9 fullscreen: the shell paints at the output's preferred
  // (native) mode, not the 1024x768 default — weston.ini no longer
  // pins Virtual-1, so the mode is the panel's native resolution
  // (1920x1080 in QEMU with xres/yres, the GF65 panel on hardware).
  // When no output mode arrived (no wl_output), keep the requested
  // size. App windows keep their --width/--height.
  if (fullscreen_ && outputWidth_ > 0 && outputHeight_ > 0) {
    logLine("WAYLAND output mode %dx%d (requested %dx%d)", outputWidth_,
            outputHeight_, width_, height_);
    width_ = outputWidth_;
    height_ = outputHeight_;
  }
  painters_[0] = std::make_unique<Painter>(width_, height_);
  painters_[1] = std::make_unique<Painter>(width_, height_);
  if (painters_[0]->shmFd() < 0 || painters_[1]->shmFd() < 0) {
    logLine("WAYLAND painter SHM setup failed");
    return;
  }
  createSurface();
  ok_ = true;
}

void Wayland::createSurface() {
  static const xdg_surface_listener kXdgSurfaceListener = {
      &Wayland::onXdgSurfaceConfigure};
  static const xdg_toplevel_listener kXdgToplevelListener = {
      &Wayland::onXdgToplevelConfigure, &Wayland::onXdgToplevelClose};
  surface_ = wl_compositor_create_surface(compositor_);
  if (!surface_) {
    logLine("WAYLAND create surface failed");
    return;
  }
  xdgSurface_ = xdg_wm_base_get_xdg_surface(xdgWmBase_, surface_);
  xdgToplevel_ = xdg_surface_get_toplevel(xdgSurface_);
  xdg_toplevel_set_title(xdgToplevel_, title_.c_str());
  xdg_toplevel_set_app_id(xdgToplevel_, appId_.c_str());
  if (fullscreen_)
    xdg_toplevel_set_fullscreen(xdgToplevel_, nullptr);
  xdg_surface_add_listener(xdgSurface_, &kXdgSurfaceListener, this);
  xdg_toplevel_add_listener(xdgToplevel_, &kXdgToplevelListener, this);
  wl_surface_commit(surface_);
  // Collect the initial configure before the caller presents.
  wl_display_roundtrip(display_);
}

void Wayland::remap() {
  if (!surface_ || fullscreen_)
    return;
  logLine("WAYLAND remap (focus restore)");
  // Drop the pending frame callback: destroying the surface orphans
  // it, and a stale framePending_ would block later frame requests.
  if (frameCallback_) {
    wl_callback_destroy(frameCallback_);
    frameCallback_ = nullptr;
    framePending_ = false;
  }
  // Drop both wl_buffers (doPresent recreates them from the
  // painters, which survive — their SHM fds are independent of the
  // surface).
  for (int i = 0; i < 2; i++) {
    if (buffers_[i]) {
      wl_buffer_destroy(buffers_[i]);
      buffers_[i] = nullptr;
    }
    busy_[i] = false;
  }
  lastCommitted_ = -1;
  back_ = 0;
  if (xdgToplevel_) {
    xdg_toplevel_destroy(xdgToplevel_);
    xdgToplevel_ = nullptr;
  }
  if (xdgSurface_) {
    xdg_surface_destroy(xdgSurface_);
    xdgSurface_ = nullptr;
  }
  if (surface_) {
    wl_surface_destroy(surface_);
    surface_ = nullptr;
  }
  // The new surface has not been configured yet; the next configure
  // flushes a pending present (see present()).
  configured_ = false;
  bool wasMaximized = maximized_;
  suppressWindowState_ = true;
  createSurface();
  suppressWindowState_ = false;
  if (!surface_)
    return;
  // A maximized window comes back maximized on the new surface.
  // (The initial configure carries no states, so restore the flag
  // silently — the maximize configure that follows agrees with it.)
  if (wasMaximized && xdgToplevel_) {
    maximized_ = true;
    xdg_toplevel_set_maximized(xdgToplevel_);
  }
  // Re-present the current content on the new surface. The last
  // present already cleared havePending_, so force it: pendingOps_
  // still holds the last frame, and the new surface has no buffer
  // attached until a present runs — without this the remapped
  // window stays blank (invisible) even though the compositor
  // raised it.
  havePending_ = true;
  flushPending();
}

void Wayland::minimize() {
  if (!xdgToplevel_ || fullscreen_)
    return;
  logLine("WAYLAND minimize");
  xdg_toplevel_set_minimized(xdgToplevel_);
}

void Wayland::maximize() {
  if (!xdgToplevel_ || fullscreen_ || maximized_)
    return;
  logLine("WAYLAND maximize");
  xdg_toplevel_set_maximized(xdgToplevel_);
  // Defer presents until the maximize configure is processed (see
  // sizeChangePending_ in wayland.h): the button-press release
  // re-render would otherwise commit a frame at the OLD size after
  // this request and poison the compositor's reposition.
  sizeChangePending_ = true;
  logLine("WAYLAND maximize: deferring presents until configure");
}

void Wayland::unmaximize() {
  if (!xdgToplevel_ || fullscreen_ || !maximized_)
    return;
  logLine("WAYLAND unmaximize");
  xdg_toplevel_unset_maximized(xdgToplevel_);
  // Same gate as maximize(): a commit at the maximized size after
  // this request but before the restore configure would poison the
  // restore the same way.
  sizeChangePending_ = true;
  logLine("WAYLAND unmaximize: deferring presents until configure");
}

Wayland::~Wayland() {
  if (frameCallback_)
    wl_callback_destroy(frameCallback_);
  if (buffers_[0])
    wl_buffer_destroy(buffers_[0]);
  if (buffers_[1])
    wl_buffer_destroy(buffers_[1]);
  if (xdgToplevel_)
    xdg_toplevel_destroy(xdgToplevel_);
  if (output_)
    wl_output_destroy(output_);
  if (xdgSurface_)
    xdg_surface_destroy(xdgSurface_);
  if (surface_)
    wl_surface_destroy(surface_);
  if (cursorSurface_)
    wl_surface_destroy(cursorSurface_);
  if (cursorTheme_)
    wl_cursor_theme_destroy(cursorTheme_);
  if (pointer_)
    wl_pointer_destroy(pointer_);
  if (keyboard_)
    wl_keyboard_destroy(keyboard_);
  if (seat_)
    wl_seat_destroy(seat_);
  if (xdgWmBase_)
    xdg_wm_base_destroy(xdgWmBase_);
  if (shm_)
    wl_shm_destroy(shm_);
  if (compositor_)
    wl_compositor_destroy(compositor_);
  if (registry_)
    wl_registry_destroy(registry_);
  if (display_)
    wl_display_disconnect(display_);
}

void Wayland::onRegistryGlobal(void* data, wl_registry* registry,
                               uint32_t name, const char* interface,
                               uint32_t version) {
  Wayland* self = static_cast<Wayland*>(data);
  static const wl_seat_listener kSeatListener = {&Wayland::onSeatCapabilities,
                                                 &Wayland::onSeatName};
  static const xdg_wm_base_listener kXdgWmBaseListener = {
      &Wayland::onXdgWmBasePing};
  if (strcmp(interface, wl_compositor_interface.name) == 0) {
    // doPresent() calls wl_surface_damage_buffer, which needs a
    // wl_surface of version >= 4. Binding the compositor at 1 made
    // every surface version 1, so Weston killed the client with
    // "invalid method 9 (since 1 < 4)" and the host exited before
    // ever presenting a frame. Bind at min(advertised, 4): enough
    // for damage_buffer, nothing newer used.
    uint32_t v = version < 4 ? version : 4;
    self->compositor_ = static_cast<wl_compositor*>(
        wl_registry_bind(registry, name, &wl_compositor_interface, v));
  } else if (strcmp(interface, wl_shm_interface.name) == 0) {
    self->shm_ = static_cast<wl_shm*>(
        wl_registry_bind(registry, name, &wl_shm_interface, 1));
  } else if (strcmp(interface, wl_output_interface.name) == 0) {
    // Bind at min(advertised, 2): mode/geometry/done are v1, scale
    // is v2. The first output wins — one output in this guest.
    uint32_t v = version < 2 ? version : 2;
    static const wl_output_listener kOutputListener = {
        &Wayland::onOutputGeometry, &Wayland::onOutputMode,
        &Wayland::onOutputDone, &Wayland::onOutputScale};
    if (!self->output_) {
      self->output_ = static_cast<wl_output*>(
          wl_registry_bind(registry, name, &wl_output_interface, v));
      wl_output_add_listener(self->output_, &kOutputListener, self);
    }
  } else if (strcmp(interface, wl_seat_interface.name) == 0) {
    self->seat_ = static_cast<wl_seat*>(
        wl_registry_bind(registry, name, &wl_seat_interface, 1));
    wl_seat_add_listener(self->seat_, &kSeatListener, self);
  } else if (strcmp(interface, xdg_wm_base_interface.name) == 0) {
    self->xdgWmBase_ = static_cast<xdg_wm_base*>(
        wl_registry_bind(registry, name, &xdg_wm_base_interface, 1));
    xdg_wm_base_add_listener(self->xdgWmBase_, &kXdgWmBaseListener, self);
  }
}

void Wayland::onRegistryGlobalRemove(void* data, wl_registry* registry,
                                     uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

void Wayland::onOutputGeometry(void* data, wl_output* output, int32_t x,
                               int32_t y, int32_t physicalWidth,
                               int32_t physicalHeight, int32_t subpixel,
                               const char* make, const char* model,
                               int32_t transform) {
  (void)data;
  (void)output;
  (void)x;
  (void)y;
  (void)physicalWidth;
  (void)physicalHeight;
  (void)subpixel;
  (void)make;
  (void)model;
  (void)transform;
}

void Wayland::onOutputMode(void* data, wl_output* output, uint32_t flags,
                           int32_t width, int32_t height, int32_t refresh) {
  (void)output;
  (void)refresh;
  Wayland* self = static_cast<Wayland*>(data);
  // The preferred mode is the panel's native resolution; the current
  // mode is the fallback when no mode carries PREFERRED (Weston
  // marks the preferred mode current). Preferred always wins over a
  // merely current mode — the two can differ. The constructor reads
  // the result after the roundtrips.
  if (flags & WL_OUTPUT_MODE_PREFERRED) {
    self->outputWidth_ = width;
    self->outputHeight_ = height;
    self->outputPreferred_ = true;
  } else if ((flags & WL_OUTPUT_MODE_CURRENT) && !self->outputPreferred_) {
    self->outputWidth_ = width;
    self->outputHeight_ = height;
  }
}

void Wayland::onOutputDone(void* data, wl_output* output) {
  (void)data;
  (void)output;
}

void Wayland::onOutputScale(void* data, wl_output* output, int32_t factor) {
  (void)data;
  (void)output;
  (void)factor;
}

void Wayland::onSeatCapabilities(void* data, wl_seat* seat,
                                 uint32_t capabilities) {
  Wayland* self = static_cast<Wayland*>(data);
  static const wl_pointer_listener kPointerListener = {
      &Wayland::onPointerEnter, &Wayland::onPointerLeave,
      &Wayland::onPointerMotion, &Wayland::onPointerButton,
      &Wayland::onPointerAxis, &Wayland::onPointerFrame,
      &Wayland::onPointerAxisSource, &Wayland::onPointerAxisStop,
      &Wayland::onPointerAxisDiscrete};
  static const wl_keyboard_listener kKeyboardListener = {
      &Wayland::onKeyboardKeymap, &Wayland::onKeyboardEnter,
      &Wayland::onKeyboardLeave, &Wayland::onKeyboardKey,
      &Wayland::onKeyboardModifiers, &Wayland::onKeyboardRepeatInfo};
  if ((capabilities & WL_SEAT_CAPABILITY_POINTER) && !self->pointer_) {
    self->pointer_ = wl_seat_get_pointer(seat);
    wl_pointer_add_listener(self->pointer_, &kPointerListener, self);
  }
  if ((capabilities & WL_SEAT_CAPABILITY_KEYBOARD) && !self->keyboard_) {
    self->keyboard_ = wl_seat_get_keyboard(seat);
    wl_keyboard_add_listener(self->keyboard_, &kKeyboardListener, self);
  }
}

void Wayland::onSeatName(void* data, wl_seat* seat, const char* name) {
  (void)data;
  (void)seat;
  (void)name;
}

void Wayland::onXdgWmBasePing(void* data, xdg_wm_base* base,
                              uint32_t serial) {
  (void)data;
  xdg_wm_base_pong(base, serial);
}

void Wayland::onXdgSurfaceConfigure(void* data, xdg_surface* surface,
                                    uint32_t serial) {
  Wayland* self = static_cast<Wayland*>(data);
  xdg_surface_ack_configure(surface, serial);
  self->configured_ = true;
  // Apply a deferred unmaximize restore (see restorePending_ in
  // wayland.h): the ack above cleared the compositor's maximized
  // bookkeeping, so committing the saved pre-maximize size now is
  // legal. Committing it in onXdgToplevelConfigure (before this
  // ack) made Weston raise xdg_wm_base error 4 and kill the
  // connection.
  if (self->restorePending_) {
    self->restorePending_ = false;
    if (self->savedWidth_ > 0 && self->savedHeight_ > 0) {
      logLine("WAYLAND restore to saved size %dx%d (after ack)",
              self->savedWidth_, self->savedHeight_);
      self->resize(self->savedWidth_, self->savedHeight_);
    }
  }
  // The compositor is ready for content; present anything pending.
  self->flushPending();
}

void Wayland::onXdgToplevelConfigure(void* data, xdg_toplevel* toplevel,
                                     int32_t width, int32_t height,
                                     wl_array* states) {
  (void)toplevel;
  Wayland* self = static_cast<Wayland*>(data);
  // The configure answers a maximize/unmaximize request (or a resize
  // drag); either way the size-change window is over — presents may
  // flow again. resize() below (or the surface configure's
  // flushPending) replays any deferred present.
  self->sizeChangePending_ = false;
  // Track the maximized flag from the states array (maximize /
  // unmaximize, or a title-bar drag restoring a maximized window).
  // The flag can change in a configure that carries no size, so
  // parse it before the size early-return below.
  bool maximized = false;
  if (states) {
    // wl_array_for_each does not compile in C++ (void* assignment),
    // so walk the array by hand.
    for (size_t i = 0; i + sizeof(uint32_t) <= states->size;
         i += sizeof(uint32_t)) {
      uint32_t s = *reinterpret_cast<uint32_t*>(
          static_cast<char*>(states->data) + i);
      if (s == XDG_TOPLEVEL_STATE_MAXIMIZED)
        maximized = true;
    }
  }
  bool flagChanged = (maximized != self->maximized_);
  if (flagChanged)
    self->maximized_ = maximized;
  // Save the pre-maximize size (before resize() below runs) so an
  // unmaximize configure that carries no size can restore to it.
  // Arm the settle commit on either transition (see
  // maximizeSettlePending_ in wayland.h): on the next frame
  // callback after this configure, commit once more so the
  // compositor gets a second, definitely-armed chance to
  // reposition the window.
  if (flagChanged) {
    if (maximized) {
      self->savedWidth_ = self->width_;
      self->savedHeight_ = self->height_;
    }
    self->maximizeSettlePending_ = true;
  }
  // Notify the JS window-state handler AFTER any resize below: the
  // handler re-renders the title bar, which presents a frame. If it
  // runs before the resize, that present is at the OLD size — and a
  // stale old-size commit followed back-to-back by the new-size
  // commit leaves a maximized window at its cascade position (the
  // compositor applies the maximized position on the first
  // post-configure commit only; verified against Weston 13 with a
  // minimal client). Resizing first makes every post-configure
  // commit the new size.
  auto notifyState = [&]() {
    if (flagChanged && !self->suppressWindowState_) {
      logLine("WAYLAND toplevel %s", maximized ? "maximized" : "restored");
      if (self->windowStateHandler_)
        self->windowStateHandler_(maximized);
    }
  };
  // M9: honor the compositor's size. Zero means "no opinion" — the
  // client keeps its size (Weston sends 0,0 for the initial
  // fullscreen configure when the output mode already matches).
  // A resize drag ends with a configure carrying the new size; the
  // fullscreen shell gets one when the output mode changes. App
  // windows clamp to the minimum size.
  // Exception: on unmaximize, a sizeless configure means "restore
  // to your pre-maximize size" — the client keeps the maximized
  // size otherwise, and the window stays fullscreen. (Weston sends
  // 0,0 on unmaximize when it has no saved size; verified in CI:
  // the restore configure carried no size and no resize ran.)
  // Defer the resize to onXdgSurfaceConfigure (restorePending_):
  // committing 800x500 before acking the configure makes Weston
  // raise xdg_wm_base error 4 and kill the connection.
  if (width <= 0 || height <= 0) {
    if (flagChanged && !maximized && self->savedWidth_ > 0 &&
        self->savedHeight_ > 0) {
      logLine("WAYLAND restore to saved size %dx%d deferred (sizeless configure)",
              self->savedWidth_, self->savedHeight_);
      self->restorePending_ = true;
    }
    notifyState();
    return;
  }
  int w = width;
  int h = height;
  if (!self->fullscreen_) {
    if (w < kMinWidth)
      w = kMinWidth;
    if (h < kMinHeight)
      h = kMinHeight;
  }
  if (w == self->width_ && h == self->height_) {
    // Same exception as above: on unmaximize the compositor may
    // echo the maximized size instead of the restored one; restore
    // to the saved pre-maximize size (deferred to after the ack,
    // as above).
    if (flagChanged && !maximized && self->savedWidth_ > 0 &&
        self->savedHeight_ > 0 &&
        (self->savedWidth_ != w || self->savedHeight_ != h)) {
      logLine("WAYLAND restore to saved size %dx%d deferred (configure echoed maximized size)",
              self->savedWidth_, self->savedHeight_);
      self->restorePending_ = true;
    }
    notifyState();
    return;
  }
  self->resize(w, h);
  notifyState();
}

void Wayland::resize(int width, int height) {
  if (width <= 0 || height <= 0)
    return;
  if (width == width_ && height == height_)
    return;
  logLine("WAYLAND resize %dx%d -> %dx%d", width_, height_, width, height);
  // Drop both wl_buffers: they reference the old SHM fds at the old
  // size, and doPresent recreates them from the resized painters.
  // The compositor may still be reading a just-committed buffer; the
  // presents here are seconds apart, so the residual tear risk is
  // the same transient class the unconditional presents already
  // accept (see doPresent).
  for (int i = 0; i < 2; i++) {
    if (buffers_[i]) {
      wl_buffer_destroy(buffers_[i]);
      buffers_[i] = nullptr;
    }
    busy_[i] = false;
  }
  lastCommitted_ = -1;
  back_ = 0;
  bool ok = true;
  for (int i = 0; i < 2; i++)
    ok = painters_[i]->resize(width, height) && ok;
  if (!ok) {
    logLine("WAYLAND resize failed (painter)");
    return;
  }
  width_ = width;
  height_ = height;
  // The size handler re-lays out JS and presents at the new size.
  // If it does not present synchronously (the usual case under TCG —
  // the JS re-layout takes seconds), force a present of the last
  // frame at the new size now: the compositor repositions a maximized
  // window on the first commit at the new size, so without this the
  // window sits at its old (cascade) position until JS catches up
  // (M9 CI: the maximized calculator stayed at (169,521) for 4+ s
  // because the first new-size commit waited on the JS re-layout).
  // The forced frame repaints the old layout in the top-left of the
  // new buffer; the JS present replaces it.
  int committedBefore = lastCommitted_;
  if (sizeHandler_)
    sizeHandler_(width, height);
  if (lastCommitted_ == committedBefore)
    havePending_ = true;
  if (havePending_)
    flushPending();
}

void Wayland::onXdgToplevelClose(void* data, xdg_toplevel* toplevel) {
  (void)toplevel;
  Wayland* self = static_cast<Wayland*>(data);
  if (self->closeHandler_) {
    logLine("WAYLAND toplevel close requested");
    self->closeHandler_();
    return;
  }
  logLine("WAYLAND toplevel close requested (ignoring — shell is not closable)");
}

void Wayland::onBufferReleaseCb(void* data, wl_buffer* buffer) {
  Wayland* self = static_cast<Wayland*>(data);
  int index = (int)(intptr_t)wl_proxy_get_user_data((wl_proxy*)buffer);
  self->onBufferRelease(index);
}

void Wayland::onBufferRelease(int index) {
  if (index < 0 || index > 1)
    return;
  busy_[index] = false;
  flushPending();
}

void Wayland::onFrameDoneCb(void* data, wl_callback* callback,
                            uint32_t time) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)time;
  wl_callback_destroy(callback);
  if (self->frameCallback_ == callback)
    self->frameCallback_ = nullptr;
  self->onFrameDone();
}

void Wayland::onFrameDone() {
  framePending_ = false;
  // The compositor presented a frame, which always shows the latest
  // committed buffer — so the OTHER buffer is off-screen now and
  // reusable. This is what unblocks presents when wl_buffer.release
  // never arrives (this guest: Weston never releases these SHM
  // buffers — zero releases across a whole M2 run while every
  // present after the second stalled). The presented frame includes
  // the latest commit: the frame callback was requested after it,
  // and presents here are seconds apart while the callback lands
  // within ~400ms of the commit.
  if (lastCommitted_ >= 0)
    busy_[1 - lastCommitted_] = false;
  flushPending();
  // Maximize/restore settle (see maximizeSettlePending_ in
  // wayland.h): the compositor has now presented a frame at the new
  // size, so commit once more — a second, definitely-armed chance
  // to reposition the window.
  if (maximizeSettlePending_) {
    maximizeSettlePending_ = false;
    logLine("WAYLAND settle commit after maximize/restore");
    havePending_ = true;
    flushPending();
  }
  if (frameHandler_)
    frameHandler_();
}

void Wayland::onPointerEnter(void* data, wl_pointer* pointer, uint32_t serial,
                             wl_surface* surface, wl_fixed_t sx,
                             wl_fixed_t sy) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  (void)surface;
  self->pointerX_ = wl_fixed_to_double(sx);
  self->pointerY_ = wl_fixed_to_double(sy);
  // The enter serial is the only one wl_pointer_set_cursor accepts:
  // without it Weston shows no cursor at all (the invisible-cursor
  // bug — nothing in the guest ever set one).
  self->setCursor(serial);
  if (self->pointerHandler_)
    self->pointerHandler_("enter", self->pointerX_, self->pointerY_, 0, false);
}

// Load the default arrow cursor and hand it to the compositor for
// this pointer enter. One static arrow for the whole shell/apps —
// no per-surface cursors. Loads lazily: shm_ is bound by the first
// enter, and a failed theme load is logged once, not retried every
// enter (a missing theme would otherwise spam the serial log).
void Wayland::setCursor(uint32_t serial) {
  if (!pointer_ || !shm_ || !compositor_)
    return;
  if (!cursorTried_) {
    cursorTried_ = true;
    // Load "Adwaita" by name, not the default theme: the image's
    // default theme (usr/share/icons/default/index.theme) is a
    // dangling symlink to /etc/alternatives/x-cursor-theme, which
    // does not exist in the image — so the default lookup finds no
    // cursor and Weston shows nothing. Adwaita's cursors (including
    // left_ptr) are staged in the image.
    cursorTheme_ = wl_cursor_theme_load("Adwaita", 24, shm_);
    if (!cursorTheme_) {
      logLine("WAYLAND cursor theme load failed (Adwaita)");
      return;
    }
    cursor_ = wl_cursor_theme_get_cursor(cursorTheme_, "left_ptr");
    if (!cursor_ || cursor_->image_count < 1) {
      logLine("WAYLAND cursor left_ptr not found in theme");
      return;
    }
    cursorSurface_ = wl_compositor_create_surface(compositor_);
    if (!cursorSurface_) {
      logLine("WAYLAND cursor surface creation failed");
      return;
    }
    wl_cursor_image* image = cursor_->images[0];
    wl_buffer* buffer = wl_cursor_image_get_buffer(image);
    if (!buffer) {
      logLine("WAYLAND cursor image has no buffer");
      return;
    }
    wl_surface_attach(cursorSurface_, buffer, 0, 0);
    wl_surface_damage(cursorSurface_, 0, 0, image->width, image->height);
    wl_surface_commit(cursorSurface_);
  }
  if (!cursor_ || !cursorSurface_)
    return;
  wl_cursor_image* image = cursor_->images[0];
  wl_pointer_set_cursor(pointer_, serial, cursorSurface_, image->hotspot_x,
                        image->hotspot_y);
  if (!cursorLogged_) {
    cursorLogged_ = true;
    logLine("WAYLAND cursor set (left_ptr %dx%d hotspot %d,%d)", image->width,
            image->height, image->hotspot_x, image->hotspot_y);
  }
}

void Wayland::onPointerLeave(void* data, wl_pointer* pointer, uint32_t serial,
                             wl_surface* surface) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  (void)serial;
  (void)surface;
  if (self->pointerHandler_)
    self->pointerHandler_("leave", self->pointerX_, self->pointerY_, 0, false);
}

void Wayland::onPointerMotion(void* data, wl_pointer* pointer, uint32_t time,
                              wl_fixed_t sx, wl_fixed_t sy) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  (void)time;
  self->pointerX_ = wl_fixed_to_double(sx);
  self->pointerY_ = wl_fixed_to_double(sy);
  if (self->pointerHandler_)
    self->pointerHandler_("motion", self->pointerX_, self->pointerY_, 0,
                          false);
}

void Wayland::onPointerButton(void* data, wl_pointer* pointer, uint32_t serial,
                              uint32_t time, uint32_t button, uint32_t state) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  (void)time;
  // M9 move + resize (app windows only — the shell is fullscreen).
  // Left-button press in the title bar (44px, minus the close-X
  // zone) starts an interactive move; a press in the 8px right /
  // bottom edge strips (or the bottom-right corner) starts an
  // interactive resize. The compositor owns the drag from here: it
  // sends a configure with the new size on release, which flows
  // through onXdgToplevelConfigure. The press is still forwarded to
  // JS below — the title bar holds no pressables, and the close X
  // is outside the move region, so nothing in JS fires for a drag.
  if (state == WL_POINTER_BUTTON_STATE_PRESSED && button == 0x110 &&
      !self->fullscreen_ && self->xdgToplevel_ && self->seat_) {
    const double x = self->pointerX_;
    const double y = self->pointerY_;
    const int w = self->width_;
    const int h = self->height_;
    uint32_t edges = XDG_TOPLEVEL_RESIZE_EDGE_NONE;
    if (x >= w - kResizeEdge && y >= h - kResizeEdge)
      edges = XDG_TOPLEVEL_RESIZE_EDGE_BOTTOM_RIGHT;
    else if (x >= w - kResizeEdge)
      edges = XDG_TOPLEVEL_RESIZE_EDGE_RIGHT;
    else if (y >= h - kResizeEdge)
      edges = XDG_TOPLEVEL_RESIZE_EDGE_BOTTOM;
    if (edges != XDG_TOPLEVEL_RESIZE_EDGE_NONE) {
      xdg_toplevel_resize(self->xdgToplevel_, self->seat_, serial, edges);
    } else if (y < kTitleBarHeight && x < w - kCloseZoneWidth) {
      xdg_toplevel_move(self->xdgToplevel_, self->seat_, serial);
    }
  }
  if (self->pointerHandler_)
    self->pointerHandler_("button", self->pointerX_, self->pointerY_, button,
                          state == WL_POINTER_BUTTON_STATE_PRESSED);
}

void Wayland::onPointerAxis(void* data, wl_pointer* pointer, uint32_t time,
                            uint32_t axis, wl_fixed_t value) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  (void)time;
  // GF65 scroll fix: accumulate the delta; onPointerFrame flushes
  // one scroll event per frame. Vertical positive = scroll down,
  // horizontal positive = scroll right — the renderer's scrollAt
  // convention, forwarded unchanged.
  const double v = wl_fixed_to_double(value);
  if (axis == WL_POINTER_AXIS_VERTICAL_SCROLL) {
    self->axisAccumY_ += v;
  } else if (axis == WL_POINTER_AXIS_HORIZONTAL_SCROLL) {
    self->axisAccumX_ += v;
  }
  self->axisPending_ = true;
}

void Wayland::onPointerFrame(void* data, wl_pointer* pointer) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  if (!self->axisPending_)
    return;
  // A frame with discrete wheel steps scrolls by clicks, not by the
  // raw axis value (libinput reports ~10 axis units per click next
  // to the discrete event). A frame with no discrete steps is a
  // smooth trackpad gesture: forward the accumulated pixels as-is.
  const double dx = self->axisDiscreteX_ != 0
                        ? self->axisDiscreteX_ * kWheelStepPx
                        : self->axisAccumX_;
  const double dy = self->axisDiscreteY_ != 0
                        ? self->axisDiscreteY_ * kWheelStepPx
                        : self->axisAccumY_;
  self->axisAccumX_ = 0;
  self->axisAccumY_ = 0;
  self->axisDiscreteX_ = 0;
  self->axisDiscreteY_ = 0;
  self->axisPending_ = false;
  if (self->scrollHandler_)
    self->scrollHandler_(self->pointerX_, self->pointerY_, dx, dy);
}

void Wayland::onPointerAxisSource(void* data, wl_pointer* pointer,
                                  uint32_t axis_source) {
  (void)data;
  (void)pointer;
  (void)axis_source;
}

void Wayland::onPointerAxisStop(void* data, wl_pointer* pointer, uint32_t time,
                                uint32_t axis) {
  (void)data;
  (void)pointer;
  (void)time;
  (void)axis;
}

void Wayland::onPointerAxisDiscrete(void* data, wl_pointer* pointer,
                                    uint32_t axis, int32_t discrete) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  if (axis == WL_POINTER_AXIS_VERTICAL_SCROLL) {
    self->axisDiscreteY_ += discrete;
  } else if (axis == WL_POINTER_AXIS_HORIZONTAL_SCROLL) {
    self->axisDiscreteX_ += discrete;
  }
  self->axisPending_ = true;
}

void Wayland::onKeyboardKeymap(void* data, wl_keyboard* keyboard,
                               uint32_t format, int32_t fd, uint32_t size) {
  (void)data;
  (void)keyboard;
  (void)format;
  close(fd);
  (void)size;
}

void Wayland::onKeyboardEnter(void* data, wl_keyboard* keyboard,
                              uint32_t serial, wl_surface* surface,
                              wl_array* keys) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)surface;
  (void)keys;
}

void Wayland::onKeyboardLeave(void* data, wl_keyboard* keyboard,
                              uint32_t serial, wl_surface* surface) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)surface;
}

void Wayland::onKeyboardKey(void* data, wl_keyboard* keyboard, uint32_t serial,
                            uint32_t time, uint32_t key, uint32_t state) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)keyboard;
  (void)serial;
  (void)time;
  // Shift keys (evdev 42 left, 54 right) are modifiers, not input:
  // track the state and do not forward them as key events.
  if (key == 42 || key == 54) {
    bool down = (state == WL_KEYBOARD_KEY_STATE_PRESSED);
    if (key == 42)
      self->shiftLeft_ = down;
    else
      self->shiftRight_ = down;
    return;
  }
  if (self->keyHandler_)
    self->keyHandler_(key, state == WL_KEYBOARD_KEY_STATE_PRESSED,
                      self->shiftLeft_ || self->shiftRight_);
}

void Wayland::onKeyboardModifiers(void* data, wl_keyboard* keyboard,
                                  uint32_t serial, uint32_t mods_depressed,
                                  uint32_t mods_latched, uint32_t mods_locked,
                                  uint32_t group) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)mods_depressed;
  (void)mods_latched;
  (void)mods_locked;
  (void)group;
}

void Wayland::onKeyboardRepeatInfo(void* data, wl_keyboard* keyboard,
                                   int32_t rate, int32_t delay) {
  (void)data;
  (void)keyboard;
  (void)rate;
  (void)delay;
}

void Wayland::requestFrame() {
  if (framePending_ || !surface_)
    return;
  static const wl_callback_listener kFrameListener = {
      &Wayland::onFrameDoneCb};
  wl_callback* cb = wl_surface_frame(surface_);
  wl_callback_add_listener(cb, &kFrameListener, this);
  frameCallback_ = cb;
  framePending_ = true;
}

void Wayland::doPresent() {
  if (!configured_ || !surface_)
    return;
  // A maximize/unmaximize is in flight: do NOT commit. The frame is
  // not lost — havePending_ replays it once the configure is
  // processed (resize()'s flushPending, or the surface configure's).
  if (sizeChangePending_) {
    logLine("WAYLAND present deferred (size change pending)");
    havePending_ = true;
    return;
  }
  // Present into the back buffer unconditionally and alternate.
  // Weston never releases these SHM buffers in this guest and
  // stops sending frame callbacks after the first frames (0
  // releases, 1 frame callback across a whole M2 run), so waiting
  // for a free buffer — or for a frame callback to free one —
  // freezes the screen after two frames: the frame-free fix
  // unblocked exactly one invisible present and then re-froze.
  // Presents here are seconds apart while a repaint takes ~400ms,
  // so by the time a buffer is repainted the compositor has
  // finished with it; the residual tear risk (a paint landing in
  // the few-ms window while the compositor reads the buffer) is
  // one transient torn frame. busy_/havePending_ are kept as
  // bookkeeping (releases and frame callbacks still clear them)
  // but no longer gate presents.
  int idx = back_;
  Painter& p = *painters_[idx];
  p.beginFrame(pendingBg_);
  p.paint(pendingOps_);
  if (!buffers_[idx]) {
    static const wl_buffer_listener kBufferListener = {
        &Wayland::onBufferReleaseCb};
    wl_shm_pool* pool = wl_shm_create_pool(
        shm_, p.shmFd(), (int32_t)((size_t)p.stride() * p.height()));
    buffers_[idx] = wl_shm_pool_create_buffer(
        pool, 0, width_, height_, p.stride(), WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    wl_proxy_set_user_data((wl_proxy*)buffers_[idx],
                           (void*)(intptr_t)idx);
    wl_buffer_add_listener(buffers_[idx], &kBufferListener, this);
  }
  wl_surface_attach(surface_, buffers_[idx], 0, 0);
  wl_surface_damage_buffer(surface_, 0, 0, width_, height_);
  wl_surface_commit(surface_);
  busy_[idx] = true;
  lastCommitted_ = idx;
  back_ = 1 - idx;
  havePending_ = false;
  requestFrame();
}

void Wayland::flushPending() {
  if (havePending_)
    doPresent();
}

void Wayland::present(const std::vector<DrawOp>& ops, uint32_t bg) {
  pendingOps_ = ops;
  pendingBg_ = bg;
  if (!configured_) {
    havePending_ = true; // first configure will flush
    return;
  }
  doPresent();
}

bool Wayland::dispatch(int timeoutMs) {
  if (!display_)
    return false;
  wl_display_flush(display_);
  int fd = wl_display_get_fd(display_);
  pollfd pfd{fd, POLLIN, 0};
  int r = poll(&pfd, 1, timeoutMs);
  if (r < 0) {
    logLine("WAYLAND dispatch poll failed (errno=%d %s)", errno,
            strerror(errno));
    return false;
  }
  if (pfd.revents & POLLIN) {
    if (wl_display_dispatch(display_) < 0) {
      logLine("WAYLAND dispatch failed (display_error=%d errno=%d %s)",
              wl_display_get_error(display_), errno, strerror(errno));
      return false;
    }
  }
  if (wl_display_dispatch_pending(display_) < 0) {
    logLine("WAYLAND dispatch_pending failed (display_error=%d errno=%d %s)",
            wl_display_get_error(display_), errno, strerror(errno));
    return false;
  }
  wl_display_flush(display_);
  return true;
}

} // namespace sevyn
