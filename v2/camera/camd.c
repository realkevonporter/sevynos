/* SevynOS v2 — camd: the native camera daemon.
 *
 * The system camera service. It owns /dev/video* (V4L2 ioctls, no
 * Chromium, no ffmpeg — neither is staged in the image) and serves
 * frames over a Unix socket (/run/sevyn-camera.sock) to the RN host
 * camera adapter and to `sevyn camera`. One line in, one JSON line
 * out (aid-style, like commsd):
 *
 *   STATUS                  -> {ok, available, source, device, formats, width, height}
 *   LIST                    -> {ok, devices: [{device, name, formats}]}
 *   PREVIEW [w h]           -> {ok, available, width, height, png, rgba, timestamp, source}
 *   CAPTURE [path]          -> {ok, path, width, height, bytes, timestamp}
 *   DECODE <jpeg> <rgba> [maxPixels]
 *                           -> {ok, available, width, height, path, png}
 *   SHUTDOWN                -> {ok} then exits 0
 *
 * Replies are {"ok":true,...} or {"ok":false,"error":"..."}.
 *
 * Capture path: the daemon negotiates MJPEG first (most UVC webcams
 * offer it — the frame is written to disk byte-for-byte, a real
 * JPEG straight from the sensor), and falls back to YUYV, which is
 * JPEG-encoded here with libjpeg-turbo. Preview is 640x360 by
 * default: an RGBA file for the RN host adapter (CameraPreviewFrame
 * reads raw pixels) plus a PNG file for the v2/apps Camera app (the
 * shell renderer decodes PNG only — painter.cc). Preview files are
 * named with a per-call sequence number because the painter caches
 * images by path forever: a new path per frame is what makes the
 * preview actually move. The previous preview pair is unlinked.
 *
 * Synthetic source (--synthetic, or kernel cmdline
 * sevyn.syntheticcamera=1 via init): QEMU has no camera, so the
 * daemon generates a test pattern (gradient + colour bars + a moving
 * bar + a frame counter) and runs the exact same encode paths. The
 * check proves the service answers, preview frames flow and differ,
 * and shutter writes a valid JPEG — with no hardware at all. A
 * device without a camera reports available:false; it never fakes
 * a capture. Synthetic mode is explicit only: without the flag and
 * without a device, camd stays up answering available:false.
 *
 * Video recording is NOT here (v1 is stills only): recordStart /
 * recordStop stay unimplemented in the host adapter until a
 * follow-up wires an encoder. Nothing in this daemon pretends
 * otherwise.
 *
 * Build: gcc -O2 -Wall -Wextra -Werror camd.c -ljpeg -lpng -lz
 * (libjpeg-turbo8-dev + libpng-dev; the image build installs both).
 * Run as root from the guest init script; log to /data/logs/camd.log.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <setjmp.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
/* jpeglib.h needs FILE (stdio.h) first; png.h likewise. */
#include <jpeglib.h>
#include <linux/videodev2.h>
#include <png.h>

#define DEFAULT_SOCK "/run/sevyn-camera.sock"
#define DEFAULT_DATA "/data/camera"
#define MAX_LINE 4096
#define PREVIEW_DEFAULT_W 640
#define PREVIEW_DEFAULT_H 360
#define CAPTURE_W 1280
#define CAPTURE_H 720
#define FALLBACK_W 640
#define FALLBACK_H 480
#define JPEG_QUALITY 85
#define DECODE_DEFAULT_MAX_PIXELS 1000000
#define STREAM_IDLE_STOP_S 30
#define NBUF 4

static volatile sig_atomic_t g_stop = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static void log_msg(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "CAMD ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

static int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int64_t wall_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int clamp255(int v)
{
    if (v < 0)
        return 0;
    if (v > 255)
        return 255;
    return v;
}

/* mkdir -p for the parent directory of path (path itself included
 * when it names a directory). Returns 0 on success. */
static int mkdir_p(const char *path)
{
    char tmp[1024];
    size_t n = strlen(path);
    if (n == 0 || n >= sizeof(tmp))
        return -1;
    memcpy(tmp, path, n + 1);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
        return -1;
    return 0;
}

static int parent_mkdir(const char *path)
{
    char tmp[1024];
    size_t n = strlen(path);
    if (n == 0 || n >= sizeof(tmp))
        return -1;
    memcpy(tmp, path, n + 1);
    char *slash = strrchr(tmp, '/');
    if (slash == NULL || slash == tmp)
        return 0;
    *slash = '\0';
    return mkdir_p(tmp);
}

static int write_file(const char *path, const uint8_t *data, size_t len)
{
    if (parent_mkdir(path) != 0)
        return -1;
    FILE *f = fopen(path, "wb");
    if (!f)
        return -1;
    size_t w = fwrite(data, 1, len, f);
    if (fclose(f) != 0)
        return -1;
    return w == len ? 0 : -1;
}

/* --- JPEG encode (libjpeg) ------------------------------------------- */
/* libjpeg's default error handler calls exit() — a corrupt frame
 * must never kill the daemon. Route errors through setjmp. */

struct jpeg_err {
    struct jpeg_error_mgr pub;
    jmp_buf jb;
};

static void jpeg_error_exit(j_common_ptr cinfo)
{
    struct jpeg_err *err = (struct jpeg_err *)cinfo->err;
    longjmp(err->jb, 1);
}

/* Encode RGB (w*h*3) to a JPEG file. Returns 0 on success. */
static int jpeg_encode_file(const char *path, const uint8_t *rgb, int w, int h,
                            int quality)
{
    FILE *f = fopen(path, "wb");
    if (!f)
        return -1;
    struct jpeg_compress_struct cinfo;
    struct jpeg_err jerr;
    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = jpeg_error_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_compress(&cinfo);
        fclose(f);
        unlink(path);
        return -1;
    }
    jpeg_create_compress(&cinfo);
    jpeg_stdio_dest(&cinfo, f);
    cinfo.image_width = (JDIMENSION)w;
    cinfo.image_height = (JDIMENSION)h;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, quality, TRUE);
    jpeg_start_compress(&cinfo, TRUE);
    JSAMPROW row[1];
    while (cinfo.next_scanline < cinfo.image_height) {
        row[0] = (JSAMPROW)(rgb + (size_t)cinfo.next_scanline * w * 3);
        jpeg_write_scanlines(&cinfo, row, 1);
    }
    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    if (fclose(f) != 0)
        return -1;
    return 0;
}

/* Encode one YUYV frame to JPEG, converting scanline by scanline
 * (no full-frame RGB temp). Returns 0 on success. */
static int yuyv_encode_file(const char *path, const uint8_t *yuyv, int w, int h,
                            int quality)
{
    FILE *f = fopen(path, "wb");
    if (!f)
        return -1;
    struct jpeg_compress_struct cinfo;
    struct jpeg_err jerr;
    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = jpeg_error_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_compress(&cinfo);
        fclose(f);
        unlink(path);
        return -1;
    }
    jpeg_create_compress(&cinfo);
    jpeg_stdio_dest(&cinfo, f);
    cinfo.image_width = (JDIMENSION)w;
    cinfo.image_height = (JDIMENSION)h;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, quality, TRUE);
    jpeg_start_compress(&cinfo, TRUE);
    uint8_t *row = malloc((size_t)w * 3);
    if (!row) {
        jpeg_destroy_compress(&cinfo);
        fclose(f);
        unlink(path);
        return -1;
    }
    JSAMPROW rp[1];
    rp[0] = row;
    while (cinfo.next_scanline < cinfo.image_height) {
        int y = (int)cinfo.next_scanline;
        const uint8_t *src = yuyv + (size_t)y * w * 2;
        for (int x = 0; x < w; x += 2) {
            int y0 = src[x * 2];
            int u = src[x * 2 + 1];
            int y1 = src[x * 2 + 2];
            int v = src[x * 2 + 3];
            int yy, uu, vv, r, g, b;
            yy = y0 - 16;
            uu = u - 128;
            vv = v - 128;
            r = (298 * yy + 409 * vv + 128) >> 8;
            g = (298 * yy - 100 * uu - 208 * vv + 128) >> 8;
            b = (298 * yy + 516 * uu + 128) >> 8;
            row[x * 3] = (uint8_t)clamp255(r);
            row[x * 3 + 1] = (uint8_t)clamp255(g);
            row[x * 3 + 2] = (uint8_t)clamp255(b);
            yy = y1 - 16;
            r = (298 * yy + 409 * vv + 128) >> 8;
            g = (298 * yy - 100 * uu - 208 * vv + 128) >> 8;
            b = (298 * yy + 516 * uu + 128) >> 8;
            row[x * 3 + 3] = (uint8_t)clamp255(r);
            row[x * 3 + 4] = (uint8_t)clamp255(g);
            row[x * 3 + 5] = (uint8_t)clamp255(b);
        }
        jpeg_write_scanlines(&cinfo, rp, 1);
    }
    free(row);
    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    if (fclose(f) != 0)
        return -1;
    return 0;
}

/* Decode a JPEG file to RGBA (out_w/out_h set). Scales down by
 * 1/2, 1/4 or 1/8 when the image exceeds max_pixels. The caller
 * frees *out. Returns 0 on success. */
static int jpeg_decode_rgba(const char *path, uint8_t **out, int *out_w,
                            int *out_h, int max_pixels)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return -1;
    struct jpeg_decompress_struct cinfo;
    struct jpeg_err jerr;
    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = jpeg_error_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_decompress(&cinfo);
        fclose(f);
        return -1;
    }
    jpeg_create_decompress(&cinfo);
    jpeg_stdio_src(&cinfo, f);
    if (jpeg_read_header(&cinfo, TRUE) != 1) {
        jpeg_destroy_decompress(&cinfo);
        fclose(f);
        return -1;
    }
    int scale = 1;
    while (scale < 8) {
        int w = ((int)cinfo.image_width + scale - 1) / scale;
        int h = ((int)cinfo.image_height + scale - 1) / scale;
        if (w * h <= max_pixels)
            break;
        scale *= 2;
    }
    cinfo.scale_num = 1;
    cinfo.scale_denom = scale;
    cinfo.out_color_space = JCS_RGB;
    jpeg_start_decompress(&cinfo);
    int w = (int)cinfo.output_width;
    int h = (int)cinfo.output_height;
    uint8_t *rgba = malloc((size_t)w * h * 4);
    uint8_t *row = malloc((size_t)w * 3);
    if (!rgba || !row) {
        free(rgba);
        free(row);
        jpeg_destroy_decompress(&cinfo);
        fclose(f);
        return -1;
    }
    while (cinfo.output_scanline < cinfo.output_height) {
        JSAMPROW rp[1];
        rp[0] = row;
        jpeg_read_scanlines(&cinfo, rp, 1);
        int y = (int)cinfo.output_scanline - 1;
        uint8_t *dst = rgba + (size_t)y * w * 4;
        for (int x = 0; x < w; x++) {
            dst[x * 4] = row[x * 3];
            dst[x * 4 + 1] = row[x * 3 + 1];
            dst[x * 4 + 2] = row[x * 3 + 2];
            dst[x * 4 + 3] = 255;
        }
    }
    free(row);
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    fclose(f);
    *out = rgba;
    *out_w = w;
    *out_h = h;
    return 0;
}

/* Decode an MJPEG frame held in memory to RGB. Returns 0. */
static int mjpeg_decode_rgb(const uint8_t *data, size_t len, uint8_t **out,
                            int *out_w, int *out_h)
{
    struct jpeg_decompress_struct cinfo;
    struct jpeg_err jerr;
    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = jpeg_error_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_decompress(&cinfo);
        return -1;
    }
    jpeg_create_decompress(&cinfo);
    jpeg_mem_src(&cinfo, data, (unsigned long)len);
    if (jpeg_read_header(&cinfo, TRUE) != 1) {
        jpeg_destroy_decompress(&cinfo);
        return -1;
    }
    cinfo.out_color_space = JCS_RGB;
    jpeg_start_decompress(&cinfo);
    int w = (int)cinfo.output_width;
    int h = (int)cinfo.output_height;
    uint8_t *rgb = malloc((size_t)w * h * 3);
    if (!rgb) {
        jpeg_destroy_decompress(&cinfo);
        return -1;
    }
    while (cinfo.output_scanline < cinfo.output_height) {
        JSAMPROW rp[1];
        rp[0] = rgb + (size_t)cinfo.output_scanline * w * 3;
        jpeg_read_scanlines(&cinfo, rp, 1);
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    *out = rgb;
    *out_w = w;
    *out_h = h;
    return 0;
}

/* --- PNG encode (libpng) --------------------------------------------- */

static int png_encode_file(const char *path, const uint8_t *rgba, int w, int h)
{
    FILE *f = fopen(path, "wb");
    if (!f)
        return -1;
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
    if (!png) {
        fclose(f);
        return -1;
    }
    png_infop info = png_create_info_struct(png);
    if (!info) {
        png_destroy_write_struct(&png, NULL);
        fclose(f);
        return -1;
    }
    if (setjmp(png_jmpbuf(png))) {
        png_destroy_write_struct(&png, &info);
        fclose(f);
        unlink(path);
        return -1;
    }
    png_init_io(png, f);
    png_set_IHDR(png, info, (png_uint_32)w, (png_uint_32)h, 8,
                 PNG_COLOR_TYPE_RGBA, PNG_INTERLACE_NONE,
                 PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
    png_write_info(png, info);
    for (int y = 0; y < h; y++)
        png_write_row(png, (png_bytep)(rgba + (size_t)y * w * 4));
    png_write_end(png, NULL);
    png_destroy_write_struct(&png, &info);
    if (fclose(f) != 0)
        return -1;
    return 0;
}

/* --- pixel helpers ---------------------------------------------------- */

/* YUYV (w*h*2) -> RGBA at the requested size (nearest-sample). */
static void yuyv_to_rgba_scaled(const uint8_t *yuyv, int w, int h, int pw,
                                int ph, uint8_t *rgba)
{
    for (int y = 0; y < ph; y++) {
        int sy = (y * h / ph) & ~1;
        if (sy > h - 1)
            sy = h - 1;
        const uint8_t *srow = yuyv + (size_t)sy * w * 2;
        uint8_t *drow = rgba + (size_t)y * pw * 4;
        for (int x = 0; x < pw; x++) {
            int sx = (x * w / pw) & ~1;
            int yv = srow[sx * 2];
            int u = srow[sx * 2 + 1];
            int v = srow[sx * 2 + 3];
            int yy = yv - 16;
            int uu = u - 128;
            int vv = v - 128;
            drow[x * 4] = (uint8_t)clamp255((298 * yy + 409 * vv + 128) >> 8);
            drow[x * 4 + 1] =
                (uint8_t)clamp255((298 * yy - 100 * uu - 208 * vv + 128) >> 8);
            drow[x * 4 + 2] = (uint8_t)clamp255((298 * yy + 516 * uu + 128) >> 8);
            drow[x * 4 + 3] = 255;
        }
    }
}

/* RGB (w*h*3) -> RGBA at the requested size (nearest-sample). */
static void rgb_to_rgba_scaled(const uint8_t *rgb, int w, int h, int pw, int ph,
                               uint8_t *rgba)
{
    for (int y = 0; y < ph; y++) {
        int sy = y * h / ph;
        const uint8_t *srow = rgb + (size_t)sy * w * 3;
        uint8_t *drow = rgba + (size_t)y * pw * 4;
        for (int x = 0; x < pw; x++) {
            int sx = x * w / pw;
            drow[x * 4] = srow[sx * 3];
            drow[x * 4 + 1] = srow[sx * 3 + 1];
            drow[x * 4 + 2] = srow[sx * 3 + 2];
            drow[x * 4 + 3] = 255;
        }
    }
}

/* --- synthetic source -------------------------------------------------- */
/* Test pattern, 1280x720 RGB: dark-teal vertical gradient, colour
 * bars across the top, a white bar that moves with the frame number,
 * and the frame number drawn as a row of blocks (bit 1 = white).
 * Two consecutive frames always differ, so the check can prove the
 * preview actually flows instead of replaying one still. */

static uint64_t g_synth_frame = 0;

static void synth_rgb(uint8_t *rgb, int w, int h)
{
    uint64_t f = ++g_synth_frame;
    static const uint8_t bars[8][3] = {
        {255, 255, 255}, {255, 255, 0}, {0, 255, 255}, {0, 255, 0},
        {255, 0, 255},   {255, 0, 0},   {0, 0, 255},   {0, 0, 0},
    };
    for (int y = 0; y < h; y++) {
        uint8_t *row = rgb + (size_t)y * w * 3;
        for (int x = 0; x < w; x++) {
            uint8_t r, g, b;
            if (y < 48) {
                const uint8_t *c = bars[(x * 8) / w];
                r = c[0];
                g = c[1];
                b = c[2];
            } else {
                int t = (y - 48) * 255 / (h - 48);
                r = (uint8_t)(20 + t / 6);
                g = (uint8_t)(60 + t / 3);
                b = (uint8_t)(70 + t / 2);
            }
            int bar_x = (int)((f * 40) % (uint64_t)w);
            if (x >= bar_x && x < bar_x + 24 && y >= 48)
                r = g = b = 255;
            if (y >= h - 64 && y < h - 32 && x >= 32 && x < 32 + 16 * 12) {
                int bit = (x - 32) / 12;
                int on = (bit < 16) && (((f >> bit) & 1) != 0);
                if (on)
                    r = g = b = 255;
            }
            row[x * 3] = r;
            row[x * 3 + 1] = g;
            row[x * 3 + 2] = b;
        }
    }
}

/* --- V4L2 device ------------------------------------------------------- */

struct v4l2buf {
    void *start;
    size_t len;
};

struct camera {
    bool synthetic;
    char device[64];
    int fd;
    uint32_t pixfmt;
    int width;
    int height;
    struct v4l2buf bufs[NBUF];
    int nbufs;
    bool streaming;
    int64_t last_use_ms;
    uint64_t frame_seq;
    /* Last raw frame, owned. */
    uint8_t *raw;
    size_t raw_len;
    uint32_t raw_fmt;
    int raw_w;
    int raw_h;
};

static void fourcc_str(uint32_t fmt, char out[5])
{
    out[0] = (char)(fmt & 0xff);
    out[1] = (char)((fmt >> 8) & 0xff);
    out[2] = (char)((fmt >> 16) & 0xff);
    out[3] = (char)((fmt >> 24) & 0xff);
    out[4] = '\0';
}

static int v4l2_ioctl(int fd, unsigned long req, void *arg)
{
    int r;
    do {
        r = ioctl(fd, req, arg);
    } while (r == -1 && errno == EINTR);
    return r;
}

/* Probe one /dev/videoN: fill name + formats (up to 8 fourccs).
 * Returns 0 when it is a usable capture device. */
static int probe_device(const char *path, char *name, size_t name_cap,
                        char formats[][5], int *nformats)
{
    int fd = open(path, O_RDWR | O_NONBLOCK);
    if (fd < 0)
        return -1;
    struct v4l2_capability cap;
    memset(&cap, 0, sizeof(cap));
    int rc = -1;
    if (v4l2_ioctl(fd, VIDIOC_QUERYCAP, &cap) == 0 &&
        (cap.capabilities & V4L2_CAP_VIDEO_CAPTURE) != 0 &&
        (cap.capabilities & V4L2_CAP_STREAMING) != 0) {
        snprintf(name, name_cap, "%s", cap.card);
        int n = 0;
        for (int i = 0; i < 16 && n < 8; i++) {
            struct v4l2_fmtdesc desc;
            memset(&desc, 0, sizeof(desc));
            desc.index = (uint32_t)i;
            desc.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            if (v4l2_ioctl(fd, VIDIOC_ENUM_FMT, &desc) != 0)
                break;
            fourcc_str(desc.pixelformat, formats[n]);
            n++;
        }
        *nformats = n;
        rc = 0;
    }
    close(fd);
    return rc;
}

static bool find_device(char *path, size_t cap)
{
    for (int i = 0; i < 10; i++) {
        char cand[32];
        snprintf(cand, sizeof(cand), "/dev/video%d", i);
        char name[64];
        char formats[8][5];
        int nformats = 0;
        if (probe_device(cand, name, sizeof(name), formats, &nformats) == 0) {
            snprintf(path, cap, "%s", cand);
            return true;
        }
    }
    return false;
}

static void camera_close_device(struct camera *cam)
{
    if (cam->fd < 0)
        return;
    if (cam->streaming) {
        enum v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        v4l2_ioctl(cam->fd, VIDIOC_STREAMOFF, &type);
        cam->streaming = false;
    }
    for (int i = 0; i < cam->nbufs; i++) {
        if (cam->bufs[i].start)
            munmap(cam->bufs[i].start, cam->bufs[i].len);
        cam->bufs[i].start = NULL;
    }
    cam->nbufs = 0;
    close(cam->fd);
    cam->fd = -1;
    cam->pixfmt = 0;
}

/* Open + negotiate a format + start streaming. Tries MJPEG then
 * YUYV at 1280x720, then the same pair at 640x480. Returns 0. */
static int camera_start(struct camera *cam)
{
    if (cam->fd >= 0 && cam->streaming)
        return 0;
    if (cam->fd < 0) {
        char dev[64];
        if (cam->device[0] != '\0')
            snprintf(dev, sizeof(dev), "%s", cam->device);
        else if (!find_device(dev, sizeof(dev)))
            return -1;
        cam->fd = open(dev, O_RDWR | O_NONBLOCK);
        if (cam->fd < 0)
            return -1;
        snprintf(cam->device, sizeof(cam->device), "%s", dev);
    }
    static const struct {
        uint32_t fmt;
        int w;
        int h;
    } tries[] = {
        {V4L2_PIX_FMT_MJPEG, CAPTURE_W, CAPTURE_H},
        {V4L2_PIX_FMT_YUYV, CAPTURE_W, CAPTURE_H},
        {V4L2_PIX_FMT_MJPEG, FALLBACK_W, FALLBACK_H},
        {V4L2_PIX_FMT_YUYV, FALLBACK_W, FALLBACK_H},
    };
    bool ok = false;
    for (size_t i = 0; i < sizeof(tries) / sizeof(tries[0]); i++) {
        struct v4l2_format f;
        memset(&f, 0, sizeof(f));
        f.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        f.fmt.pix.width = (uint32_t)tries[i].w;
        f.fmt.pix.height = (uint32_t)tries[i].h;
        f.fmt.pix.pixelformat = tries[i].fmt;
        f.fmt.pix.field = V4L2_FIELD_ANY;
        if (v4l2_ioctl(cam->fd, VIDIOC_S_FMT, &f) != 0)
            continue;
        if (f.fmt.pix.pixelformat != tries[i].fmt)
            continue;
        cam->pixfmt = f.fmt.pix.pixelformat;
        cam->width = (int)f.fmt.pix.width;
        cam->height = (int)f.fmt.pix.height;
        ok = true;
        break;
    }
    if (!ok) {
        camera_close_device(cam);
        return -1;
    }
    struct v4l2_requestbuffers req;
    memset(&req, 0, sizeof(req));
    req.count = NBUF;
    req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    req.memory = V4L2_MEMORY_MMAP;
    if (v4l2_ioctl(cam->fd, VIDIOC_REQBUFS, &req) != 0 || req.count < 2) {
        camera_close_device(cam);
        return -1;
    }
    cam->nbufs = (int)req.count;
    for (int i = 0; i < cam->nbufs; i++) {
        struct v4l2_buffer buf;
        memset(&buf, 0, sizeof(buf));
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buf.memory = V4L2_MEMORY_MMAP;
        buf.index = (uint32_t)i;
        if (v4l2_ioctl(cam->fd, VIDIOC_QUERYBUF, &buf) != 0) {
            camera_close_device(cam);
            return -1;
        }
        cam->bufs[i].len = buf.length;
        cam->bufs[i].start =
            mmap(NULL, buf.length, PROT_READ | PROT_WRITE, MAP_SHARED, cam->fd,
                 buf.m.offset);
        if (cam->bufs[i].start == MAP_FAILED) {
            cam->bufs[i].start = NULL;
            camera_close_device(cam);
            return -1;
        }
        if (v4l2_ioctl(cam->fd, VIDIOC_QBUF, &buf) != 0) {
            camera_close_device(cam);
            return -1;
        }
    }
    enum v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (v4l2_ioctl(cam->fd, VIDIOC_STREAMON, &type) != 0) {
        camera_close_device(cam);
        return -1;
    }
    cam->streaming = true;
    char fmt[5];
    fourcc_str(cam->pixfmt, fmt);
    log_msg("streaming %s %s %dx%d", cam->device, fmt, cam->width, cam->height);
    return 0;
}

/* Grab the newest frame, draining the queue so a slow poller never
 * gets a stale one. Copies the bytes into cam->raw. Returns 0. */
static int camera_grab(struct camera *cam)
{
    if (camera_start(cam) != 0)
        return -1;
    cam->last_use_ms = now_ms();
    struct pollfd pfd = {.fd = cam->fd, .events = POLLIN};
    if (poll(&pfd, 1, 2000) <= 0) {
        camera_close_device(cam);
        return -1;
    }
    bool got = false;
    for (;;) {
        struct v4l2_buffer buf;
        memset(&buf, 0, sizeof(buf));
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buf.memory = V4L2_MEMORY_MMAP;
        if (v4l2_ioctl(cam->fd, VIDIOC_DQBUF, &buf) != 0)
            break;
        if (buf.index >= (uint32_t)cam->nbufs || cam->bufs[buf.index].start == NULL) {
            camera_close_device(cam);
            return -1;
        }
        free(cam->raw);
        cam->raw = malloc(buf.bytesused);
        if (!cam->raw) {
            v4l2_ioctl(cam->fd, VIDIOC_QBUF, &buf);
            camera_close_device(cam);
            return -1;
        }
        memcpy(cam->raw, cam->bufs[buf.index].start, buf.bytesused);
        cam->raw_len = buf.bytesused;
        cam->raw_fmt = cam->pixfmt;
        cam->raw_w = cam->width;
        cam->raw_h = cam->height;
        cam->frame_seq++;
        got = true;
        if (v4l2_ioctl(cam->fd, VIDIOC_QBUF, &buf) != 0) {
            camera_close_device(cam);
            return -1;
        }
    }
    if (!got) {
        camera_close_device(cam);
        return -1;
    }
    return 0;
}

static void camera_idle_stop(struct camera *cam)
{
    if (cam->streaming && now_ms() - cam->last_use_ms > STREAM_IDLE_STOP_S * 1000) {
        log_msg("idle %ds, stopping stream", STREAM_IDLE_STOP_S);
        camera_close_device(cam);
    }
}

/* --- frame production -------------------------------------------------- */
/* A produced frame is either the device's raw bytes (MJPEG or YUYV)
 * or synthetic RGB. Preview needs RGBA; capture needs JPEG bytes. */

struct frame {
    uint8_t *raw; /* MJPEG or YUYV bytes, or synthetic RGB */
    size_t raw_len;
    uint32_t fmt; /* V4L2_PIX_FMT_MJPEG, V4L2_PIX_FMT_YUYV, or 0 = RGB */
    int w;
    int h;
    uint64_t seq;
};

static int produce_frame(struct camera *cam, struct frame *out)
{
    memset(out, 0, sizeof(*out));
    if (cam->synthetic) {
        int w = CAPTURE_W;
        int h = CAPTURE_H;
        uint8_t *rgb = malloc((size_t)w * h * 3);
        if (!rgb)
            return -1;
        synth_rgb(rgb, w, h);
        out->raw = rgb;
        out->raw_len = (size_t)w * h * 3;
        out->fmt = 0;
        out->w = w;
        out->h = h;
        out->seq = g_synth_frame;
        return 0;
    }
    if (camera_grab(cam) != 0)
        return -1;
    out->raw = cam->raw;
    out->raw_len = cam->raw_len;
    out->fmt = cam->raw_fmt;
    out->w = cam->raw_w;
    out->h = cam->raw_h;
    out->seq = cam->frame_seq;
    return 0;
}

/* Frame -> preview RGBA at the requested size. The caller frees
 * *rgba. */
static int frame_preview_rgba(struct camera *cam, struct frame *fr, int pw, int ph,
                              uint8_t **rgba)
{
    uint8_t *out = malloc((size_t)pw * ph * 4);
    if (!out)
        return -1;
    if (fr->fmt == V4L2_PIX_FMT_YUYV) {
        yuyv_to_rgba_scaled(fr->raw, fr->w, fr->h, pw, ph, out);
    } else if (fr->fmt == V4L2_PIX_FMT_MJPEG) {
        uint8_t *rgb = NULL;
        int rw = 0, rh = 0;
        if (mjpeg_decode_rgb(fr->raw, fr->raw_len, &rgb, &rw, &rh) != 0) {
            free(out);
            return -1;
        }
        rgb_to_rgba_scaled(rgb, rw, rh, pw, ph, out);
        free(rgb);
    } else {
        rgb_to_rgba_scaled(fr->raw, fr->w, fr->h, pw, ph, out);
    }
    (void)cam;
    *rgba = out;
    return 0;
}

/* Frame -> JPEG file. MJPEG frames are written byte-for-byte after
 * a SOI check; anything else is libjpeg-encoded. Returns 0. */
static int frame_capture_jpeg(struct frame *fr, const char *path)
{
    if (fr->fmt == V4L2_PIX_FMT_MJPEG) {
        if (fr->raw_len < 4 || fr->raw[0] != 0xff || fr->raw[1] != 0xd8)
            return -1;
        return write_file(path, fr->raw, fr->raw_len);
    }
    if (fr->fmt == V4L2_PIX_FMT_YUYV)
        return yuyv_encode_file(path, fr->raw, fr->w, fr->h, JPEG_QUALITY);
    return jpeg_encode_file(path, fr->raw, fr->w, fr->h, JPEG_QUALITY);
}

static bool is_jpeg_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return false;
    uint8_t head[2];
    size_t n = fread(head, 1, 2, f);
    fclose(f);
    return n == 2 && head[0] == 0xff && head[1] == 0xd8;
}

/* --- JSON -------------------------------------------------------------- */

static void json_escape(FILE *f, const char *s)
{
    for (const char *p = s; *p; p++) {
        if (*p == '"' || *p == '\\')
            fputc('\\', f);
        fputc(*p, f);
    }
}

/* --- daemon state ------------------------------------------------------ */

struct daemon {
    struct camera cam;
    char data_dir[512];
    char sock_path[512];
    int quality;
    uint64_t preview_seq;
    char last_preview_png[1024];
    char last_preview_rgba[1024];
};

static void reply_ok(FILE *out)
{
    fprintf(out, "{\"ok\":true}\n");
}

static void reply_err(FILE *out, const char *msg)
{
    fprintf(out, "{\"ok\":false,\"error\":\"");
    json_escape(out, msg);
    fprintf(out, "\"}\n");
}

static void handle_status(struct daemon *d, FILE *out)
{
    struct camera *cam = &d->cam;
    if (cam->synthetic) {
        fprintf(out,
                "{\"ok\":true,\"available\":true,\"source\":\"synthetic\","
                "\"device\":null,\"formats\":[\"SYNTH\"],\"width\":%d,\"height\":%d}\n",
                CAPTURE_W, CAPTURE_H);
        return;
    }
    char dev[64];
    if (!find_device(dev, sizeof(dev))) {
        fprintf(out,
                "{\"ok\":true,\"available\":false,\"source\":\"none\","
                "\"device\":null,\"formats\":[],\"width\":0,\"height\":0}\n");
        return;
    }
    char name[64];
    char formats[8][5];
    int nformats = 0;
    if (probe_device(dev, name, sizeof(name), formats, &nformats) != 0) {
        fprintf(out,
                "{\"ok\":true,\"available\":false,\"source\":\"none\","
                "\"device\":null,\"formats\":[],\"width\":0,\"height\":0}\n");
        return;
    }
    fprintf(out,
            "{\"ok\":true,\"available\":true,\"source\":\"v4l2\",\"device\":\"%s\","
            "\"formats\":[",
            dev);
    for (int i = 0; i < nformats; i++)
        fprintf(out, "%s\"%s\"", i ? "," : "", formats[i]);
    fprintf(out, "],\"width\":%d,\"height\":%d}\n", CAPTURE_W, CAPTURE_H);
}

static void handle_list(struct daemon *d, FILE *out)
{
    struct camera *cam = &d->cam;
    if (cam->synthetic) {
        fprintf(out,
                "{\"ok\":true,\"devices\":[{\"device\":\"synthetic\","
                "\"name\":\"Synthetic test pattern\",\"formats\":[\"SYNTH\"]}]}\n");
        return;
    }
    fprintf(out, "{\"ok\":true,\"devices\":[");
    bool first = true;
    for (int i = 0; i < 10; i++) {
        char path[32];
        snprintf(path, sizeof(path), "/dev/video%d", i);
        char name[64];
        char formats[8][5];
        int nformats = 0;
        if (probe_device(path, name, sizeof(name), formats, &nformats) != 0)
            continue;
        fprintf(out, "%s{\"device\":\"%s\",\"name\":\"", first ? "" : ",", path);
        json_escape(out, name);
        fprintf(out, "\",\"formats\":[");
        for (int j = 0; j < nformats; j++)
            fprintf(out, "%s\"%s\"", j ? "," : "", formats[j]);
        fprintf(out, "]}");
        first = false;
    }
    fprintf(out, "]}\n");
}

static void handle_preview(struct daemon *d, FILE *out, int pw, int ph)
{
    struct camera *cam = &d->cam;
    if (!cam->synthetic) {
        char dev[64];
        if (!find_device(dev, sizeof(dev))) {
            fprintf(out,
                    "{\"ok\":true,\"available\":false,\"width\":%d,\"height\":%d,"
                    "\"timestamp\":%lld}\n",
                    pw, ph, (long long)wall_ms());
            return;
        }
    }
    struct frame fr;
    if (produce_frame(cam, &fr) != 0) {
        reply_err(out, "no frame from camera");
        return;
    }
    uint8_t *rgba = NULL;
    if (frame_preview_rgba(cam, &fr, pw, ph, &rgba) != 0) {
        if (fr.fmt == 0)
            free(fr.raw);
        reply_err(out, "preview conversion failed");
        return;
    }
    d->preview_seq++;
    char png_path[1024];
    char rgba_path[1024];
    snprintf(png_path, sizeof(png_path), "%s/preview-%llu.png", d->data_dir,
             (unsigned long long)d->preview_seq);
    snprintf(rgba_path, sizeof(rgba_path), "%s/preview-%llu.rgba", d->data_dir,
             (unsigned long long)d->preview_seq);
    int rc = png_encode_file(png_path, rgba, pw, ph);
    if (rc == 0)
        rc = write_file(rgba_path, rgba, (size_t)pw * ph * 4);
    free(rgba);
    if (fr.fmt == 0)
        free(fr.raw);
    if (rc != 0) {
        reply_err(out, "preview write failed");
        return;
    }
    /* The painter caches by path: unlink the previous pair so the
     * data dir does not fill with stale frames. */
    if (d->last_preview_png[0] != '\0')
        unlink(d->last_preview_png);
    if (d->last_preview_rgba[0] != '\0')
        unlink(d->last_preview_rgba);
    snprintf(d->last_preview_png, sizeof(d->last_preview_png), "%s", png_path);
    snprintf(d->last_preview_rgba, sizeof(d->last_preview_rgba), "%s", rgba_path);
    fprintf(out,
            "{\"ok\":true,\"available\":true,\"width\":%d,\"height\":%d,"
            "\"png\":\"%s\",\"rgba\":\"%s\",\"timestamp\":%lld,\"source\":\"%s\"}\n",
            pw, ph, png_path, rgba_path, (long long)wall_ms(),
            cam->synthetic ? "synthetic" : "v4l2");
}

static void handle_capture(struct daemon *d, FILE *out, const char *path_arg)
{
    struct camera *cam = &d->cam;
    if (!cam->synthetic) {
        char dev[64];
        if (!find_device(dev, sizeof(dev))) {
            reply_err(out, "No usable Video4Linux capture device was detected.");
            return;
        }
    }
    struct frame fr;
    if (produce_frame(cam, &fr) != 0) {
        reply_err(out, "capture failed: no frame from camera");
        return;
    }
    char path[1024];
    if (path_arg != NULL && path_arg[0] != '\0') {
        if (path_arg[0] != '/') {
            if (fr.fmt == 0)
                free(fr.raw);
            reply_err(out, "capture path must be absolute");
            return;
        }
        snprintf(path, sizeof(path), "%s", path_arg);
    } else {
        snprintf(path, sizeof(path), "%s/camera-%lld.jpg", d->data_dir,
                 (long long)wall_ms());
    }
    if (frame_capture_jpeg(&fr, path) != 0) {
        if (fr.fmt == 0)
            free(fr.raw);
        reply_err(out, "capture failed: JPEG encode failed");
        return;
    }
    struct stat st;
    long bytes = -1;
    if (stat(path, &st) == 0)
        bytes = (long)st.st_size;
    if (fr.fmt == 0)
        free(fr.raw);
    fprintf(out,
            "{\"ok\":true,\"path\":\"%s\",\"width\":%d,\"height\":%d,"
            "\"bytes\":%ld,\"timestamp\":%lld}\n",
            path, fr.w, fr.h, bytes, (long long)wall_ms());
}

static void handle_decode(struct daemon *d, FILE *out, const char *jpeg_path,
                          const char *rgba_path, int max_pixels)
{
    (void)d;
    if (jpeg_path == NULL || rgba_path == NULL || jpeg_path[0] != '/' ||
        rgba_path[0] != '/') {
        reply_err(out, "decode paths must be absolute");
        return;
    }
    if (!is_jpeg_file(jpeg_path)) {
        fprintf(out,
                "{\"ok\":true,\"available\":false,\"width\":0,\"height\":0}\n");
        return;
    }
    uint8_t *rgba = NULL;
    int w = 0, h = 0;
    if (jpeg_decode_rgba(jpeg_path, &rgba, &w, &h, max_pixels) != 0) {
        fprintf(out,
                "{\"ok\":true,\"available\":false,\"width\":0,\"height\":0}\n");
        return;
    }
    char png_path[1024];
    size_t n = strlen(rgba_path);
    if (n > 5 && strcmp(rgba_path + n - 5, ".rgba") == 0) {
        snprintf(png_path, sizeof(png_path), "%.*s.png", (int)(n - 5), rgba_path);
    } else if (n + 5 <= sizeof(png_path)) {
        memcpy(png_path, rgba_path, n);
        memcpy(png_path + n, ".png", 5);
    } else {
        free(rgba);
        reply_err(out, "decode output path too long");
        return;
    }
    int rc = write_file(rgba_path, rgba, (size_t)w * h * 4);
    if (rc == 0)
        rc = png_encode_file(png_path, rgba, w, h);
    free(rgba);
    if (rc != 0) {
        reply_err(out, "decode write failed");
        return;
    }
    fprintf(out,
            "{\"ok\":true,\"available\":true,\"width\":%d,\"height\":%d,"
            "\"path\":\"%s\",\"png\":\"%s\",\"timestamp\":%lld}\n",
            w, h, rgba_path, png_path, (long long)wall_ms());
}

/* One client connection: lines until EOF. Returns true on SHUTDOWN. */
static bool handle_client(struct daemon *d, int fd)
{
    FILE *in = fdopen(fd, "r");
    FILE *out = fdopen(dup(fd), "w");
    if (!in || !out) {
        if (in)
            fclose(in);
        if (out)
            fclose(out);
        return false;
    }
    char line[MAX_LINE];
    bool shutdown = false;
    while (fgets(line, sizeof(line), in) != NULL) {
        size_t n = strlen(line);
        while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
            line[--n] = '\0';
        if (n == 0)
            continue;
        camera_idle_stop(&d->cam);
        char verb[32];
        if (sscanf(line, "%31s", verb) != 1) {
            reply_err(out, "empty command");
            fflush(out);
            continue;
        }
        if (strcmp(verb, "STATUS") == 0) {
            handle_status(d, out);
        } else if (strcmp(verb, "LIST") == 0) {
            handle_list(d, out);
        } else if (strcmp(verb, "PREVIEW") == 0) {
            int pw = PREVIEW_DEFAULT_W;
            int ph = PREVIEW_DEFAULT_H;
            sscanf(line, "%*s %d %d", &pw, &ph);
            if (pw < 16 || ph < 16 || pw > 1280 || ph > 720 || pw % 2 != 0 ||
                ph % 2 != 0) {
                reply_err(out, "preview size out of range");
            } else {
                handle_preview(d, out, pw, ph);
            }
        } else if (strcmp(verb, "CAPTURE") == 0) {
            const char *arg = NULL;
            char path[1024];
            if (sscanf(line, "%*s %1023s", path) == 1)
                arg = path;
            handle_capture(d, out, arg);
        } else if (strcmp(verb, "DECODE") == 0) {
            char jpeg[1024];
            char rgba[1024];
            int max_pixels = DECODE_DEFAULT_MAX_PIXELS;
            int got = sscanf(line, "%*s %1023s %1023s %d", jpeg, rgba, &max_pixels);
            if (got < 2) {
                reply_err(out, "usage: DECODE <jpeg> <rgba> [maxPixels]");
            } else {
                if (max_pixels < 1024)
                    max_pixels = 1024;
                handle_decode(d, out, jpeg, rgba, max_pixels);
            }
        } else if (strcmp(verb, "SHUTDOWN") == 0) {
            reply_ok(out);
            fflush(out);
            shutdown = true;
            break;
        } else {
            reply_err(out, "unknown command");
        }
        fflush(out);
        if (g_stop)
            break;
    }
    fclose(in);
    fclose(out);
    return shutdown;
}

static void usage(void)
{
    fprintf(stderr,
            "usage: sevyn-camd [--socket <path>] [--data <dir>]\n"
            "                   [--device <path>] [--synthetic] [--quality <n>]\n");
}

int main(int argc, char **argv)
{
    struct daemon d;
    memset(&d, 0, sizeof(d));
    d.cam.fd = -1;
    d.quality = JPEG_QUALITY;
    snprintf(d.sock_path, sizeof(d.sock_path), "%s", DEFAULT_SOCK);
    snprintf(d.data_dir, sizeof(d.data_dir), "%s", DEFAULT_DATA);
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc)
            snprintf(d.sock_path, sizeof(d.sock_path), "%s", argv[++i]);
        else if (strcmp(argv[i], "--data") == 0 && i + 1 < argc)
            snprintf(d.data_dir, sizeof(d.data_dir), "%s", argv[++i]);
        else if (strcmp(argv[i], "--device") == 0 && i + 1 < argc)
            snprintf(d.cam.device, sizeof(d.cam.device), "%s", argv[++i]);
        else if (strcmp(argv[i], "--synthetic") == 0)
            d.cam.synthetic = true;
        else if (strcmp(argv[i], "--quality") == 0 && i + 1 < argc)
            d.quality = atoi(argv[++i]);
        else {
            usage();
            return 2;
        }
    }
    if (d.quality < 1 || d.quality > 100)
        d.quality = JPEG_QUALITY;
    if (mkdir_p(d.data_dir) != 0) {
        fprintf(stderr, "CAMD error: cannot create %s\n", d.data_dir);
        return 1;
    }
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGPIPE, SIG_IGN);

    int srv = socket(AF_UNIX, SOCK_STREAM, 0);
    if (srv < 0) {
        perror("socket");
        return 1;
    }
    struct sockaddr_un addr;
    /* sun_path is 108 bytes; a truncated bind would listen on the
     * wrong path and every client would fail to connect. */
    if (strlen(d.sock_path) >= sizeof(addr.sun_path)) {
        fprintf(stderr, "CAMD error: socket path too long: %s\n", d.sock_path);
        close(srv);
        return 1;
    }
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", d.sock_path);
    unlink(d.sock_path);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        close(srv);
        return 1;
    }
    if (listen(srv, 8) != 0) {
        perror("listen");
        close(srv);
        return 1;
    }
    log_msg("listening on %s (synthetic=%s, data=%s)", d.sock_path,
            d.cam.synthetic ? "yes" : "no", d.data_dir);
    bool shutdown = false;
    while (!g_stop && !shutdown) {
        struct pollfd pfd = {.fd = srv, .events = POLLIN};
        int r = poll(&pfd, 1, 1000);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        if (r == 0) {
            camera_idle_stop(&d.cam);
            continue;
        }
        int fd = accept(srv, NULL, NULL);
        if (fd < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        shutdown = handle_client(&d, fd);
        close(fd);
    }
    camera_close_device(&d.cam);
    free(d.cam.raw);
    close(srv);
    unlink(d.sock_path);
    log_msg("stopped");
    return 0;
}
