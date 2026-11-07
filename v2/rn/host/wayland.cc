// SevynOS v2 M2 — Wayland client (see wayland.h).
#include "wayland.h"

#include <cerrno>
#include <poll.h>
#include <unistd.h>
#include <cstring>

#include <wayland-client-protocol.h>

#include "xdg-shell-client-protocol.h"

namespace sevyn {

// Listener tables are function-local statics at their use sites: they
// reference the private static callbacks, so namespace scope cannot
// name them.

Wayland::Wayland(int width, int height) : width_(width), height_(height) {
  static const wl_registry_listener kRegistryListener = {
      &Wayland::onRegistryGlobal, &Wayland::onRegistryGlobalRemove};
  static const xdg_surface_listener kXdgSurfaceListener = {
      &Wayland::onXdgSurfaceConfigure};
  static const xdg_toplevel_listener kXdgToplevelListener = {
      &Wayland::onXdgToplevelConfigure, &Wayland::onXdgToplevelClose};
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
  painters_[0] = std::make_unique<Painter>(width_, height_);
  painters_[1] = std::make_unique<Painter>(width_, height_);
  if (painters_[0]->shmFd() < 0 || painters_[1]->shmFd() < 0) {
    logLine("WAYLAND painter SHM setup failed");
    return;
  }
  surface_ = wl_compositor_create_surface(compositor_);
  if (!surface_) {
    logLine("WAYLAND create surface failed");
    return;
  }
  xdgSurface_ = xdg_wm_base_get_xdg_surface(xdgWmBase_, surface_);
  xdgToplevel_ = xdg_surface_get_toplevel(xdgSurface_);
  xdg_toplevel_set_title(xdgToplevel_, "SevynOS Shell");
  xdg_toplevel_set_fullscreen(xdgToplevel_, nullptr);
  xdg_surface_add_listener(xdgSurface_, &kXdgSurfaceListener, this);
  xdg_toplevel_add_listener(xdgToplevel_, &kXdgToplevelListener, this);
  wl_surface_commit(surface_);
  // Collect the initial configure before the caller presents.
  wl_display_roundtrip(display_);
  ok_ = true;
}

Wayland::~Wayland() {
  if (buffers_[0])
    wl_buffer_destroy(buffers_[0]);
  if (buffers_[1])
    wl_buffer_destroy(buffers_[1]);
  if (xdgToplevel_)
    xdg_toplevel_destroy(xdgToplevel_);
  if (xdgSurface_)
    xdg_surface_destroy(xdgSurface_);
  if (surface_)
    wl_surface_destroy(surface_);
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
  // The compositor is ready for content; present anything pending.
  self->flushPending();
}

void Wayland::onXdgToplevelConfigure(void* data, xdg_toplevel* toplevel,
                                     int32_t width, int32_t height,
                                     wl_array* states) {
  (void)data;
  (void)toplevel;
  (void)width;
  (void)height;
  (void)states;
  // Fullscreen: the compositor owns the size (1024x768). Ignore.
}

void Wayland::onXdgToplevelClose(void* data, xdg_toplevel* toplevel) {
  (void)data;
  (void)toplevel;
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
  if (frameHandler_)
    frameHandler_();
}

void Wayland::onPointerEnter(void* data, wl_pointer* pointer, uint32_t serial,
                             wl_surface* surface, wl_fixed_t sx,
                             wl_fixed_t sy) {
  Wayland* self = static_cast<Wayland*>(data);
  (void)pointer;
  (void)serial;
  (void)surface;
  self->pointerX_ = wl_fixed_to_double(sx);
  self->pointerY_ = wl_fixed_to_double(sy);
  if (self->pointerHandler_)
    self->pointerHandler_("enter", self->pointerX_, self->pointerY_, 0, false);
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
  (void)serial;
  (void)time;
  if (self->pointerHandler_)
    self->pointerHandler_("button", self->pointerX_, self->pointerY_, button,
                          state == WL_POINTER_BUTTON_STATE_PRESSED);
}

void Wayland::onPointerAxis(void* data, wl_pointer* pointer, uint32_t time,
                            uint32_t axis, wl_fixed_t value) {
  (void)data;
  (void)pointer;
  (void)time;
  (void)axis;
  (void)value;
}

void Wayland::onPointerFrame(void* data, wl_pointer* pointer) {
  (void)data;
  (void)pointer;
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
  (void)data;
  (void)pointer;
  (void)axis;
  (void)discrete;
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
  if (self->keyHandler_)
    self->keyHandler_(key, state == WL_KEYBOARD_KEY_STATE_PRESSED);
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
  framePending_ = true;
}

void Wayland::doPresent() {
  if (!configured_ || !surface_)
    return;
  int idx = -1;
  if (!busy_[back_])
    idx = back_;
  else if (!busy_[1 - back_])
    idx = 1 - back_;
  if (idx < 0) {
    havePending_ = true; // both buffers busy; retry on release/frame
    return;
  }
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
