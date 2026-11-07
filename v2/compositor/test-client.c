/* SevynOS v2 M1 — compositor test client.
 *
 * One xdg_toplevel window (800x300) holding two subsurfaces side by side
 * (400x300 each, distinct dark colours). It is the click-target proof for
 * M1: every pointer enter/leave/button and every key event is logged with
 * the surface it landed on, so the host harness can sweep the pointer
 * across the screen and assert the compositor routes events to the surface
 * actually under the cursor.
 *
 * Logs go to /dev/console (the host harness reads the serial stream) and
 * to /tmp/sevyn-m1-client.log. Lines are prefixed with monotonic ms.
 *
 * Build: gcc with wayland-client; xdg-shell protocol sources are generated
 * at build time by wayland-scanner (see v2/image/build-m1-image.sh).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#define WIN_W 800
#define WIN_H 300
#define HALF_W 400

static int console_fd = -1;
static int log_fd = -1;
static long long start_ms;

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void log_line(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = snprintf(buf, sizeof(buf), "[%lld] ", now_ms() - start_ms);
    n += vsnprintf(buf + n, sizeof(buf) - (size_t)n, fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    if (buf[n - 1] != '\n')
        buf[n++] = '\n';
    if (console_fd >= 0)
        (void)!write(console_fd, buf, (size_t)n);
    if (log_fd >= 0)
        (void)!write(log_fd, buf, (size_t)n);
}

struct surface {
    struct wl_surface *wl;
    struct wl_buffer *buffer;
    const char *name;
    uint32_t color; /* XRGB */
    int x, y, w, h;
};

struct app {
    struct wl_display *display;
    struct wl_registry *registry;
    struct wl_compositor *compositor;
    struct wl_subcompositor *subcompositor;
    struct wl_shm *shm;
    struct wl_seat *seat;
    struct wl_pointer *pointer;
    struct wl_keyboard *keyboard;
    struct xdg_wm_base *wm_base;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;
    struct surface toplevel_surface;
    struct surface left;
    struct surface right;
    const char *pointer_surface; /* name of surface under the pointer */
    const char *focus_surface;   /* name of keyboard-focused surface */
    bool configured;
};

static struct wl_buffer *make_buffer(struct app *app, int w, int h, uint32_t color)
{
    int size = w * h * 4;
    int fd = memfd_create("sevyn-m1-shm", MFD_CLOEXEC);
    if (fd < 0) {
        log_line("M1CLIENT error: memfd_create failed: %s", strerror(errno));
        return NULL;
    }
    if (ftruncate(fd, size) < 0) {
        log_line("M1CLIENT error: ftruncate failed: %s", strerror(errno));
        close(fd);
        return NULL;
    }
    uint32_t *pixels = mmap(NULL, (size_t)size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) {
        log_line("M1CLIENT error: mmap failed: %s", strerror(errno));
        close(fd);
        return NULL;
    }
    for (int i = 0; i < w * h; i++)
        pixels[i] = color;
    munmap(pixels, (size_t)size);
    struct wl_shm_pool *pool = wl_shm_create_pool(app->shm, fd, size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, w * 4, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

static void surface_commit(struct app *app, struct surface *s)
{
    if (!s->buffer)
        s->buffer = make_buffer(app, s->w, s->h, s->color);
    if (!s->buffer)
        return;
    wl_surface_attach(s->wl, s->buffer, 0, 0);
    wl_surface_damage(s->wl, 0, 0, s->w, s->h);
    wl_surface_commit(s->wl);
}

/* --- xdg_surface / toplevel --- */

static void xdg_surface_configure(void *data, struct xdg_surface *xdg_surface, uint32_t serial)
{
    struct app *app = data;
    xdg_surface_ack_configure(xdg_surface, serial);
    if (!app->configured) {
        app->configured = true;
        surface_commit(app, &app->toplevel_surface);
        surface_commit(app, &app->left);
        surface_commit(app, &app->right);
        log_line("M1CLIENT READY surfaces=A(left) B(right) size=%dx%d", WIN_W, WIN_H);
    } else {
        surface_commit(app, &app->toplevel_surface);
        surface_commit(app, &app->left);
        surface_commit(app, &app->right);
    }
}

static const struct xdg_surface_listener xdg_surface_listener = {
    .configure = xdg_surface_configure,
};

static void xdg_toplevel_configure(void *data, struct xdg_toplevel *toplevel,
                                   int32_t width, int32_t height, struct wl_array *states)
{
    (void)data;
    (void)toplevel;
    (void)states;
    log_line("M1CLIENT toplevel configure size=%dx%d states=%d", width, height,
             (int)(states ? states->size / sizeof(uint32_t) : 0));
    /* M1 keeps its fixed 800x300 geometry; the harness measures the real
     * geometry from pointer-enter events, so a compositor resize would not
     * break the proof. */
}

static void xdg_toplevel_close(void *data, struct xdg_toplevel *toplevel)
{
    (void)data;
    (void)toplevel;
    log_line("M1CLIENT toplevel close requested, exiting");
    exit(0);
}

static const struct xdg_toplevel_listener xdg_toplevel_listener = {
    .configure = xdg_toplevel_configure,
    .close = xdg_toplevel_close,
};

/* --- pointer --- */

static void pointer_enter(void *data, struct wl_pointer *pointer, uint32_t serial,
                          struct wl_surface *surface, wl_fixed_t sx, wl_fixed_t sy)
{
    struct app *app = data;
    (void)pointer;
    (void)serial;
    const char *name = surface ? wl_surface_get_user_data(surface) : NULL;
    app->pointer_surface = name ? name : "?";
    log_line("PTR ENTER %s %d %d", app->pointer_surface, wl_fixed_to_int(sx), wl_fixed_to_int(sy));
}

static void pointer_leave(void *data, struct wl_pointer *pointer, uint32_t serial,
                          struct wl_surface *surface)
{
    struct app *app = data;
    (void)pointer;
    (void)serial;
    (void)surface;
    log_line("PTR LEAVE %s", app->pointer_surface ? app->pointer_surface : "?");
    app->pointer_surface = NULL;
}

static void pointer_motion(void *data, struct wl_pointer *pointer, uint32_t time,
                           wl_fixed_t sx, wl_fixed_t sy)
{
    (void)data;
    (void)pointer;
    (void)time;
    (void)sx;
    (void)sy;
    /* Motion is deliberately not logged: the sweep would flood the serial
     * stream. Enter/leave/button are the proof. */
}

static void pointer_button(void *data, struct wl_pointer *pointer, uint32_t serial,
                           uint32_t time, uint32_t button, uint32_t state)
{
    struct app *app = data;
    (void)pointer;
    (void)serial;
    (void)time;
    log_line("PTR BUTTON %s button=%u state=%s",
             app->pointer_surface ? app->pointer_surface : "?",
             button, state == WL_POINTER_BUTTON_STATE_PRESSED ? "pressed" : "released");
}

static void pointer_axis(void *data, struct wl_pointer *pointer, uint32_t time,
                         uint32_t axis, wl_fixed_t value)
{
    (void)data;
    (void)pointer;
    (void)time;
    (void)axis;
    (void)value;
}

static void pointer_frame(void *data, struct wl_pointer *pointer)
{
    (void)data;
    (void)pointer;
    /* End of a pointer event batch. Same NULL-handler abort as
     * keyboard repeat_info (see below): the client binds wl_seat
     * version 5, so Weston sends pointer.frame (opcode 5) after every
     * batch of pointer events, and libwayland aborts on a NULL entry.
     * Without this, the first pointer motion would kill the client. */
}

static const struct wl_pointer_listener pointer_listener = {
    .enter = pointer_enter,
    .leave = pointer_leave,
    .motion = pointer_motion,
    .button = pointer_button,
    .axis = pointer_axis,
    .frame = pointer_frame,
};

/* --- keyboard --- */

static void keyboard_keymap(void *data, struct wl_keyboard *keyboard, uint32_t format,
                            int32_t fd, uint32_t size)
{
    (void)data;
    (void)keyboard;
    (void)format;
    (void)size;
    close(fd);
}

static void keyboard_enter(void *data, struct wl_keyboard *keyboard, uint32_t serial,
                           struct wl_surface *surface, struct wl_array *keys)
{
    struct app *app = data;
    (void)keyboard;
    (void)serial;
    (void)keys;
    const char *name = surface ? wl_surface_get_user_data(surface) : NULL;
    app->focus_surface = name ? name : "?";
    log_line("KEY FOCUS %s", app->focus_surface);
}

static void keyboard_leave(void *data, struct wl_keyboard *keyboard, uint32_t serial,
                           struct wl_surface *surface)
{
    struct app *app = data;
    (void)keyboard;
    (void)serial;
    (void)surface;
    log_line("KEY LEAVE %s", app->focus_surface ? app->focus_surface : "?");
    app->focus_surface = NULL;
}

static void keyboard_key(void *data, struct wl_keyboard *keyboard, uint32_t serial,
                         uint32_t time, uint32_t key, uint32_t state)
{
    struct app *app = data;
    (void)keyboard;
    (void)serial;
    (void)time;
    /* Wayland keycodes are evdev + 8 (XKB convention). */
    log_line("KEY %s key=%u state=%s",
             app->focus_surface ? app->focus_surface : "?",
             key, state == WL_KEYBOARD_KEY_STATE_PRESSED ? "pressed" : "released");
}

static void keyboard_modifiers(void *data, struct wl_keyboard *keyboard, uint32_t serial,
                               uint32_t mods_depressed, uint32_t mods_latched,
                               uint32_t mods_locked, uint32_t group)
{
    (void)data;
    (void)keyboard;
    (void)serial;
    (void)mods_depressed;
    (void)mods_latched;
    (void)mods_locked;
    (void)group;
}

static void keyboard_repeat_info(void *data, struct wl_keyboard *keyboard,
                                 int32_t rate, int32_t delay)
{
    (void)data;
    (void)keyboard;
    (void)rate;
    (void)delay;
    /* Key repeat rate/delay. The M1 harness sends single key presses, so
     * there is nothing to do — but the handler MUST exist: the client
     * binds wl_seat version 5, so Weston sends repeat_info (opcode 5)
     * when the keyboard is created, and libwayland aborts ("listener
     * function for opcode 5 of wl_keyboard is NULL") on a NULL entry.
     * That abort — 2s after READY, no window, no pointer events — was
     * the failure that killed the first fixed-socket check runs. */
}

static const struct wl_keyboard_listener keyboard_listener = {
    .keymap = keyboard_keymap,
    .enter = keyboard_enter,
    .leave = keyboard_leave,
    .key = keyboard_key,
    .modifiers = keyboard_modifiers,
    .repeat_info = keyboard_repeat_info,
};

static void seat_capabilities(void *data, struct wl_seat *seat, uint32_t caps)
{
    struct app *app = data;
    if ((caps & WL_SEAT_CAPABILITY_POINTER) && !app->pointer) {
        app->pointer = wl_seat_get_pointer(seat);
        wl_pointer_add_listener(app->pointer, &pointer_listener, app);
    }
    if ((caps & WL_SEAT_CAPABILITY_KEYBOARD) && !app->keyboard) {
        app->keyboard = wl_seat_get_keyboard(seat);
        wl_keyboard_add_listener(app->keyboard, &keyboard_listener, app);
    }
}

static void seat_name(void *data, struct wl_seat *seat, const char *name)
{
    (void)data;
    (void)seat;
    (void)name;
}

static const struct wl_seat_listener seat_listener = {
    .capabilities = seat_capabilities,
    .name = seat_name,
};

/* --- wm_base / registry --- */

static void wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial)
{
    (void)data;
    xdg_wm_base_pong(wm_base, serial);
}

static const struct xdg_wm_base_listener wm_base_listener = {
    .ping = wm_base_ping,
};

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version)
{
    struct app *app = data;
    if (strcmp(interface, wl_compositor_interface.name) == 0) {
        app->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
    } else if (strcmp(interface, wl_subcompositor_interface.name) == 0) {
        app->subcompositor = wl_registry_bind(registry, name, &wl_subcompositor_interface, 1);
    } else if (strcmp(interface, wl_shm_interface.name) == 0) {
        app->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    } else if (strcmp(interface, wl_seat_interface.name) == 0) {
        app->seat = wl_registry_bind(registry, name, &wl_seat_interface, 5);
        wl_seat_add_listener(app->seat, &seat_listener, app);
    } else if (strcmp(interface, xdg_wm_base_interface.name) == 0) {
        app->wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(app->wm_base, &wm_base_listener, app);
    }
    (void)version;
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

int main(void)
{
    start_ms = now_ms();
    console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    log_fd = open("/tmp/sevyn-m1-client.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);

    struct app app;
    memset(&app, 0, sizeof(app));
    app.display = wl_display_connect(NULL);
    if (!app.display) {
        log_line("M1CLIENT error: cannot connect to Wayland display (WAYLAND_DISPLAY=%s)",
                 getenv("WAYLAND_DISPLAY") ? getenv("WAYLAND_DISPLAY") : "(unset)");
        return 1;
    }
    app.registry = wl_display_get_registry(app.display);
    wl_registry_add_listener(app.registry, &registry_listener, &app);
    wl_display_roundtrip(app.display);

    if (!app.compositor || !app.subcompositor || !app.shm || !app.wm_base) {
        log_line("M1CLIENT error: missing globals (compositor=%d subcompositor=%d shm=%d wm_base=%d)",
                 !!app.compositor, !!app.subcompositor, !!app.shm, !!app.wm_base);
        return 1;
    }

    /* Toplevel window. */
    app.toplevel_surface = (struct surface){
        .wl = wl_compositor_create_surface(app.compositor),
        .name = "window",
        .color = 0xFF181818,
        .x = 0, .y = 0, .w = WIN_W, .h = WIN_H,
    };
    wl_surface_set_user_data(app.toplevel_surface.wl, (void *)"window");
    app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.toplevel_surface.wl);
    xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
    app.toplevel = xdg_surface_get_toplevel(app.xdg_surface);
    xdg_toplevel_add_listener(app.toplevel, &xdg_toplevel_listener, &app);
    xdg_toplevel_set_title(app.toplevel, "sevyn-m1-test");
    xdg_toplevel_set_app_id(app.toplevel, "sevyn.m1.test");

    /* Left half (A, dark red) and right half (B, dark blue). */
    app.left = (struct surface){
        .wl = wl_compositor_create_surface(app.compositor),
        .name = "A",
        .color = 0xFF402020,
        .x = 0, .y = 0, .w = HALF_W, .h = WIN_H,
    };
    app.right = (struct surface){
        .wl = wl_compositor_create_surface(app.compositor),
        .name = "B",
        .color = 0xFF202040,
        .x = HALF_W, .y = 0, .w = HALF_W, .h = WIN_H,
    };
    wl_surface_set_user_data(app.left.wl, (void *)"A");
    wl_surface_set_user_data(app.right.wl, (void *)"B");
    struct wl_subsurface *sub_a = wl_subcompositor_get_subsurface(
        app.subcompositor, app.left.wl, app.toplevel_surface.wl);
    struct wl_subsurface *sub_b = wl_subcompositor_get_subsurface(
        app.subcompositor, app.right.wl, app.toplevel_surface.wl);
    wl_subsurface_set_position(sub_a, 0, 0);
    wl_subsurface_set_position(sub_b, HALF_W, 0);
    wl_subsurface_set_desync(sub_a);
    wl_subsurface_set_desync(sub_b);

    /* First commit triggers the configure; the configure handler commits
     * the real buffers and prints M1CLIENT READY. */
    wl_surface_commit(app.toplevel_surface.wl);

    log_line("M1CLIENT started, waiting for configure");
    while (wl_display_dispatch(app.display) != -1) {
    }
    log_line("M1CLIENT display dispatch ended (%s)", strerror(errno));
    return 0;
}
