/* SevynOS v2 M3 — .sevyn bundle loader (sevyn-loader).
 *
 * Installs, verifies, lists, uninstalls and reinstalls .sevyn app
 * bundles (zip: manifest.json + app.hbc + assets/). Owns the system
 * registry at /var/lib/sevyn/apps/ (registry.json + per-app dirs).
 *
 * Usage:
 *   sevyn-loader install <bundle.sevyn>   install (or replace) an app
 *   sevyn-loader uninstall <id>          remove an installed app
 *   sevyn-loader reinstall <id>          reinstall from pristine
 *   sevyn-loader list                    print installed apps
 *   sevyn-loader verify <bundle.sevyn>   verify only, do not install
 *
 * Exit codes: 0 ok; 1 usage error; 2 operation failed (bad bundle,
 * missing file, I/O); 3 policy refusal (protected app, system-app
 * signature rule, app is running).
 *
 * Manifest (all fields are validated; unknown top-level fields are
 * ignored for forward compatibility):
 *   id            "files" — ^[a-z][a-z0-9_-]{0,63}$; "shell" is reserved
 *   name          display name, 1-64 chars, no control chars
 *   version       "1.2.3"
 *   entry         must be "app.hbc"
 *   color         "#rrggbb" tile colour; glyph: 1-4 byte tile letter
 *   system        bool, default false
 *   protected     bool, default false — honoured ONLY for system apps
 *                 with a trusted signature (a regular app cannot make
 *                 itself undeletable by claiming protected)
 *   permissions   array of strings, each from the known set
 *                 {"status.read"} — unknown permissions refuse install
 *   bundleHash    sha256 hex of app.hbc; the loader verifies it
 *   signature     optional {algorithm:"ed25519", keyId, publicKey,
 *                 value}. Signed data is the ASCII string
 *                 "sevyn-bundle-v1\n<id>\n<version>\n<bundleHash>\n".
 *                 keyId must be the first 16 hex chars of
 *                 sha256(publicKey). A present-but-invalid signature
 *                 refuses install; a valid self-signed (untrusted key)
 *                 installs as a normal app with a LOADER note.
 *
 * Signature policy (the locked rule): a signature is required to
 * replace or become a system app. Concretely:
 *   - installing a bundle with system:true requires a valid signature
 *     whose public key is in the trusted-keys dir.
 *   - replacing an installed system app requires the new bundle to
 *     carry a valid trusted signature (even if it claims system:false).
 *   - reinstalling a protected app from pristine is allowed (it is the
 *     recovery path); the pristine bundle goes through the same checks.
 * Uninstall refuses protected apps and running apps (a live pid file
 * under the run dir).
 *
 * Paths come from the environment for the host-side unit tests:
 *   SEVYN_APPS_DIR (default /var/lib/sevyn/apps)
 *   SEVYN_PRISTINE_DIR (default /usr/share/sevyn/pristine)
 *   SEVYN_TRUSTED_KEYS_DIR (default /usr/share/sevyn/trusted-keys)
 *   SEVYN_RUN_DIR (default /run/sevyn/apps)
 *
 * Build: gcc, libc + libcrypto (SHA-256 + Ed25519 verify).
 * Unzip is done by forking busybox unzip (fallback: unzip on PATH).
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "json.h"
#include "verify.h" /* sha256, base64, Ed25519 (shared with the M8 updater) */

#define DEFAULT_APPS_DIR "/var/lib/sevyn/apps"
#define DEFAULT_PRISTINE_DIR "/usr/share/sevyn/pristine"
#define DEFAULT_TRUSTED_KEYS_DIR "/usr/share/sevyn/trusted-keys"
#define DEFAULT_RUN_DIR "/run/sevyn/apps"
#define REGISTRY_NAME "registry.json"

static const char *g_apps_dir;
static const char *g_pristine_dir;
static const char *g_trusted_dir;
static const char *g_run_dir;
static int g_console_fd = -1;

/* Retrying console writer (same pattern as statusd): the guest console
 * is O_NONBLOCK, so a single write can fail when the serial buffer is
 * momentarily full. Capped so a wedged console cannot stall the loader. */
static void write_all_console(const char *buf, size_t n)
{
    size_t off = 0;
    int tries = 0;
    while (off < n && tries < 50) {
        ssize_t w = write(g_console_fd, buf + off, n - off);
        if (w > 0) {
            off += (size_t)w;
            continue;
        }
        if (w < 0 && errno != EAGAIN && errno != EINTR)
            break;
        struct pollfd pfd = { .fd = g_console_fd, .events = POLLOUT };
        (void)!poll(&pfd, 1, 100);
        tries++;
    }
}

static void log_line(const char *fmt, ...)
{
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    if (buf[n - 1] != '\n')
        buf[n++] = '\n';
    if (g_console_fd >= 0)
        write_all_console(buf, (size_t)n);
    (void)!fwrite(buf, 1, (size_t)n, stderr);
}

/* --- small file helpers --- */

static char *path_join(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b);
    char *out = (char *)malloc(la + lb + 2);
    if (!out)
        return NULL;
    memcpy(out, a, la);
    if (la > 0 && out[la - 1] != '/')
        out[la++] = '/';
    memcpy(out + la, b, lb + 1);
    return out;
}

static int file_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0;
}

static int mkdir_p(const char *path)
{
    if (path[0] == '\0')
        return 0;
    char tmp[PATH_MAX];
    size_t n = strlen(path);
    if (n >= sizeof(tmp))
        return -1;
    memcpy(tmp, path, n + 1);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) < 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, 0755) < 0 && errno != EEXIST)
        return -1;
    return 0;
}

/* Recursively delete a file or directory tree. Returns 0 on success. */
static int rm_rf(const char *path)
{
    struct stat st;
    if (lstat(path, &st) < 0)
        return errno == ENOENT ? 0 : -1;
    if (!S_ISDIR(st.st_mode))
        return unlink(path);
    DIR *d = opendir(path);
    if (!d)
        return -1;
    struct dirent *de;
    int rc = 0;
    while ((de = readdir(d)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0)
            continue;
        char *child = path_join(path, de->d_name);
        if (!child) {
            rc = -1;
            break;
        }
        if (rm_rf(child) != 0)
            rc = -1;
        free(child);
    }
    closedir(d);
    if (rc == 0 && rmdir(path) < 0)
        rc = -1;
    return rc;
}

static char *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    long size = ftell(f);
    if (size < 0) {
        fclose(f);
        return NULL;
    }
    rewind(f);
    char *buf = (char *)malloc((size_t)size + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (size > 0 && fread(buf, 1, (size_t)size, f) != (size_t)size) {
        free(buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    buf[size] = '\0';
    if (out_len)
        *out_len = (size_t)size;
    return buf;
}

static int write_file_atomic(const char *path, const char *data, size_t len)
{
    char tmp[PATH_MAX];
    if (snprintf(tmp, sizeof(tmp), "%s.tmp.%ld", path, (long)getpid()) >=
        (int)sizeof(tmp))
        return -1;
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return -1;
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, data + off, len - off);
        if (w < 0) {
            if (errno == EINTR)
                continue;
            close(fd);
            unlink(tmp);
            return -1;
        }
        off += (size_t)w;
    }
    if (fsync(fd) < 0) {
        close(fd);
        unlink(tmp);
        return -1;
    }
    if (close(fd) < 0) {
        unlink(tmp);
        return -1;
    }
    if (rename(tmp, path) < 0) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

/* --- crypto helpers --- */

/* --- manifest --- */

/* Known permissions (M3: status.read; M4: cli.exec — run the `sevyn`
 * CLI via the host's Sevyn.exec bridge. The host enforces the same
 * set; an app without cli.exec gets an ERR from Sevyn.exec. */
static const char *kKnownPermissions[] = { "status.read", "cli.exec",
                                           NULL };

static int permission_known(const char *p)
{
    for (int i = 0; kKnownPermissions[i]; i++)
        if (strcmp(p, kKnownPermissions[i]) == 0)
            return 1;
    return 0;
}

struct manifest {
    char *id;
    char *name;
    char *version;
    char *entry;
    char *color;
    char *glyph;
    int system;
    int protected_;
    char **permissions;
    size_t npermissions;
    char *bundle_hash;
    /* Signature (optional). */
    int has_signature;
    char *sig_key_id;
    unsigned char sig_pubkey[32];
    unsigned char sig_value[64];
};

static void manifest_free(struct manifest *m)
{
    if (!m)
        return;
    free(m->id);
    free(m->name);
    free(m->version);
    free(m->entry);
    free(m->color);
    free(m->glyph);
    for (size_t i = 0; i < m->npermissions; i++)
        free(m->permissions[i]);
    free(m->permissions);
    free(m->bundle_hash);
    free(m->sig_key_id);
    memset(m, 0, sizeof(*m));
}

static int valid_id(const char *id)
{
    if (!id)
        return 0;
    size_t n = strlen(id);
    if (n < 1 || n > 64)
        return 0;
    if (strcmp(id, "shell") == 0)
        return 0; /* reserved: the shell is not a registry app */
    if (!islower((unsigned char)id[0]) && !isdigit((unsigned char)id[0]))
        return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)id[i];
        if (!(islower(c) || isdigit(c) || c == '-' || c == '_'))
            return 0;
    }
    return 1;
}

static int valid_version(const char *v)
{
    if (!v)
        return 0;
    /* X.Y.Z, each 1-5 digits. */
    int dots = 0;
    size_t n = strlen(v);
    if (n < 5 || n > 17)
        return 0;
    int digits = 0;
    for (size_t i = 0; i < n; i++) {
        if (isdigit((unsigned char)v[i])) {
            digits++;
            if (digits > 5)
                return 0;
        } else if (v[i] == '.') {
            if (digits == 0)
                return 0;
            digits = 0;
            dots++;
        } else {
            return 0;
        }
    }
    return dots == 2 && digits > 0;
}

static int valid_color(const char *c)
{
    if (!c || strlen(c) != 7 || c[0] != '#')
        return 0;
    for (int i = 1; i < 7; i++)
        if (!isxdigit((unsigned char)c[i]))
            return 0;
    return 1;
}

static const char *req_str(const jval_t *obj, const char *key, char *err,
                           size_t errcap)
{
    const jval_t *v = json_obj_get(obj, key);
    if (!v) {
        snprintf(err, errcap, "manifest: missing field '%s'", key);
        return NULL;
    }
    const char *s = json_str(v);
    if (!s) {
        snprintf(err, errcap, "manifest: field '%s' must be a string", key);
        return NULL;
    }
    return s;
}

/* Parse + validate a manifest object. On error returns -1 with err set.
 * `sig_ok` is set to 1 when a signature is present AND valid, 0 when
 * absent; a present-but-invalid signature is an error (-1). */
static int parse_manifest(const jval_t *obj, struct manifest *m, char *err,
                          size_t errcap, int *sig_ok)
{
    memset(m, 0, sizeof(*m));
    *sig_ok = 0;
    if (!obj || obj->type != J_OBJ) {
        snprintf(err, errcap, "manifest: top level must be an object");
        return -1;
    }
    const char *s;
    if (!(s = req_str(obj, "id", err, errcap)))
        return -1;
    if (!valid_id(s)) {
        snprintf(err, errcap, "manifest: invalid id '%s'", s);
        return -1;
    }
    m->id = strdup(s);
    if (!(s = req_str(obj, "name", err, errcap)))
        goto fail;
    if (strlen(s) < 1 || strlen(s) > 64 || strchr(s, '\n') ||
        strchr(s, '/')) {
        snprintf(err, errcap, "manifest: invalid name");
        goto fail;
    }
    m->name = strdup(s);
    if (!(s = req_str(obj, "version", err, errcap)))
        goto fail;
    if (!valid_version(s)) {
        snprintf(err, errcap, "manifest: invalid version '%s'", s);
        goto fail;
    }
    m->version = strdup(s);
    if (!(s = req_str(obj, "entry", err, errcap)))
        goto fail;
    if (strcmp(s, "app.hbc") != 0) {
        snprintf(err, errcap, "manifest: entry must be 'app.hbc'");
        goto fail;
    }
    m->entry = strdup(s);
    if (!(s = req_str(obj, "color", err, errcap)))
        goto fail;
    if (!valid_color(s)) {
        snprintf(err, errcap, "manifest: invalid color '%s'", s);
        goto fail;
    }
    m->color = strdup(s);
    if (!(s = req_str(obj, "glyph", err, errcap)))
        goto fail;
    if (strlen(s) < 1 || strlen(s) > 4) {
        snprintf(err, errcap, "manifest: invalid glyph");
        goto fail;
    }
    m->glyph = strdup(s);
    const jval_t *v = json_obj_get(obj, "system");
    m->system = v ? json_bool(v, 0) : 0;
    v = json_obj_get(obj, "protected");
    m->protected_ = v ? json_bool(v, 0) : 0;
    v = json_obj_get(obj, "permissions");
    if (v) {
        if (v->type != J_ARR) {
            snprintf(err, errcap, "manifest: permissions must be an array");
            goto fail;
        }
        size_t n = json_arr_len(v);
        m->permissions = (char **)calloc(n ? n : 1, sizeof(char *));
        if (!m->permissions) {
            snprintf(err, errcap, "out of memory");
            goto fail;
        }
        for (size_t i = 0; i < n; i++) {
            const char *p = json_str(json_arr_get(v, i));
            if (!p) {
                snprintf(err, errcap,
                         "manifest: permissions must be strings");
                goto fail;
            }
            if (!permission_known(p)) {
                snprintf(err, errcap,
                         "manifest: unknown permission '%s'", p);
                goto fail;
            }
            m->permissions[m->npermissions++] = strdup(p);
        }
    }
    if (!(s = req_str(obj, "bundleHash", err, errcap)))
        goto fail;
    if (!is_hex(s, 64)) {
        snprintf(err, errcap, "manifest: bundleHash must be 64 hex chars");
        goto fail;
    }
    m->bundle_hash = strdup(s);
    /* Optional signature. */
    v = json_obj_get(obj, "signature");
    if (v) {
        if (v->type != J_OBJ) {
            snprintf(err, errcap, "manifest: signature must be an object");
            goto fail;
        }
        const char *alg = req_str(v, "algorithm", err, errcap);
        if (!alg)
            goto fail;
        if (strcmp(alg, "ed25519") != 0) {
            snprintf(err, errcap,
                     "manifest: unsupported signature algorithm '%s'", alg);
            goto fail;
        }
        const char *key_id = req_str(v, "keyId", err, errcap);
        if (!key_id)
            goto fail;
        if (!is_hex(key_id, 16)) {
            snprintf(err, errcap, "manifest: keyId must be 16 hex chars");
            goto fail;
        }
        m->sig_key_id = strdup(key_id);
        const char *pub = req_str(v, "publicKey", err, errcap);
        if (!pub)
            goto fail;
        const char *val = req_str(v, "value", err, errcap);
        if (!val)
            goto fail;
        size_t pub_len = 0, sig_len = 0;
        unsigned char *pub_bytes = b64_decode(pub, &pub_len);
        unsigned char *sig_bytes = b64_decode(val, &sig_len);
        if (!pub_bytes || pub_len != 32 || !sig_bytes || sig_len != 64) {
            free(pub_bytes);
            free(sig_bytes);
            snprintf(err, errcap, "manifest: bad signature encoding");
            goto fail;
        }
        memcpy(m->sig_pubkey, pub_bytes, 32);
        memcpy(m->sig_value, sig_bytes, 64);
        free(pub_bytes);
        free(sig_bytes);
        m->has_signature = 1;
        /* keyId must be the first 16 hex chars of sha256(publicKey). */
        char kid[17];
        if (key_id_for_pubkey(m->sig_pubkey, kid) != 0) {
            snprintf(err, errcap, "manifest: cannot hash public key");
            goto fail;
        }
        if (strncmp(kid, key_id, 16) != 0) {
            snprintf(err, errcap,
                     "manifest: keyId does not match publicKey");
            goto fail;
        }
        /* Verify the signature over the signing input. */
        char input[512];
        int n = snprintf(input, sizeof(input),
                         "sevyn-bundle-v1\n%s\n%s\n%s\n", m->id, m->version,
                         m->bundle_hash);
        if (n < 0 || (size_t)n >= sizeof(input)) {
            snprintf(err, errcap, "manifest: signing input too long");
            goto fail;
        }
        if (!ed25519_verify(m->sig_pubkey, m->sig_value,
                            (const unsigned char *)input, (size_t)n)) {
            snprintf(err, errcap,
                     "manifest: signature verification failed");
            goto fail;
        }
        *sig_ok = 1;
    }
    if (!m->id || !m->name || !m->version || !m->entry || !m->color ||
        !m->glyph || !m->bundle_hash) {
        snprintf(err, errcap, "out of memory");
        goto fail;
    }
    return 0;

fail:
    manifest_free(m);
    return -1;
}

/* Is this public key trusted? The trusted-keys dir holds one file per
 * key: <keyId>.pub, 32 raw bytes. */
static int key_trusted(const char *key_id, const unsigned char *pubkey)
{
    char *path = path_join(g_trusted_dir, "");
    if (!path)
        return 0;
    /* path_join(dir, "") gives dir + "/"; append keyId + ".pub". */
    size_t n = strlen(path) + strlen(key_id) + 5;
    char *full = (char *)malloc(n + 1);
    if (!full) {
        free(path);
        return 0;
    }
    snprintf(full, n + 1, "%s%s.pub", path, key_id);
    free(path);
    size_t len = 0;
    char *data = read_file(full, &len);
    free(full);
    if (!data)
        return 0;
    int ok = (len == 32 && memcmp(data, pubkey, 32) == 0);
    free(data);
    return ok;
}

/* --- registry --- */

struct reg_entry {
    char *id;
    char *name;
    char *version;
    char *path;
    char *color; /* "#rrggbb" tile colour (default #6b7280) */
    char *glyph; /* 1-4 byte tile letter (default "?") */
    int system;
    int protected_;
    char **permissions;
    size_t npermissions;
    char *sig_key_id; /* NULL when unsigned */
};

struct registry {
    struct reg_entry *entries;
    size_t n, cap;
};

static void registry_free(struct registry *r)
{
    for (size_t i = 0; i < r->n; i++) {
        struct reg_entry *e = &r->entries[i];
        free(e->id);
        free(e->name);
        free(e->version);
        free(e->path);
        free(e->color);
        free(e->glyph);
        for (size_t j = 0; j < e->npermissions; j++)
            free(e->permissions[j]);
        free(e->permissions);
        free(e->sig_key_id);
    }
    free(r->entries);
    memset(r, 0, sizeof(*r));
}

static struct reg_entry *registry_find(struct registry *r, const char *id)
{
    for (size_t i = 0; i < r->n; i++)
        if (strcmp(r->entries[i].id, id) == 0)
            return &r->entries[i];
    return NULL;
}

static int registry_remove(struct registry *r, const char *id)
{
    for (size_t i = 0; i < r->n; i++) {
        if (strcmp(r->entries[i].id, id) == 0) {
            struct reg_entry *e = &r->entries[i];
            free(e->id);
            free(e->name);
            free(e->version);
            free(e->path);
            free(e->color);
            free(e->glyph);
            for (size_t j = 0; j < e->npermissions; j++)
                free(e->permissions[j]);
            free(e->permissions);
            free(e->sig_key_id);
            memmove(&r->entries[i], &r->entries[i + 1],
                    (r->n - i - 1) * sizeof(*e));
            r->n--;
            return 0;
        }
    }
    return -1;
}

static char *registry_path(void)
{
    return path_join(g_apps_dir, REGISTRY_NAME);
}

static int registry_load(struct registry *r, char *err, size_t errcap)
{
    memset(r, 0, sizeof(*r));
    char *path = registry_path();
    if (!path) {
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    size_t len = 0;
    char *data = read_file(path, &len);
    free(path);
    if (!data)
        return 0; /* missing registry = empty registry */
    char jerr[256];
    jval_t *root = json_parse(data, jerr, sizeof(jerr));
    free(data);
    if (!root) {
        snprintf(err, errcap, "registry: parse error: %s", jerr);
        return -1;
    }
    const jval_t *apps = json_obj_get(root, "apps");
    if (!apps || apps->type != J_ARR) {
        json_free(root);
        snprintf(err, errcap, "registry: missing 'apps' array");
        return -1;
    }
    size_t n = json_arr_len(apps);
    for (size_t i = 0; i < n; i++) {
        const jval_t *o = json_arr_get(apps, i);
        if (!o || o->type != J_OBJ)
            continue;
        const char *id = json_str(json_obj_get(o, "id"));
        const char *name = json_str(json_obj_get(o, "name"));
        const char *version = json_str(json_obj_get(o, "version"));
        const char *appath = json_str(json_obj_get(o, "path"));
        if (!id || !name || !version || !appath)
            continue;
        if (r->n == r->cap) {
            size_t ncap = r->cap ? r->cap * 2 : 8;
            struct reg_entry *nb = (struct reg_entry *)realloc(
                r->entries, ncap * sizeof(*nb));
            if (!nb) {
                json_free(root);
                snprintf(err, errcap, "out of memory");
                return -1;
            }
            r->entries = nb;
            r->cap = ncap;
        }
        struct reg_entry *e = &r->entries[r->n++];
        memset(e, 0, sizeof(*e));
        e->id = strdup(id);
        e->name = strdup(name);
        e->version = strdup(version);
        e->path = strdup(appath);
        const char *color = json_str(json_obj_get(o, "color"));
        e->color = strdup(color ? color : "#6b7280");
        const char *glyph = json_str(json_obj_get(o, "glyph"));
        e->glyph = strdup(glyph ? glyph : "?");
        e->system = json_bool(json_obj_get(o, "system"), 0);
        e->protected_ = json_bool(json_obj_get(o, "protected"), 0);
        const jval_t *perms = json_obj_get(o, "permissions");
        if (perms && perms->type == J_ARR) {
            size_t pn = json_arr_len(perms);
            e->permissions = (char **)calloc(pn ? pn : 1, sizeof(char *));
            for (size_t j = 0; j < pn; j++) {
                const char *p = json_str(json_arr_get(perms, j));
                if (p)
                    e->permissions[e->npermissions++] = strdup(p);
            }
        }
        const char *kid = json_str(json_obj_get(o, "signatureKeyId"));
        if (kid)
            e->sig_key_id = strdup(kid);
    }
    json_free(root);
    return 0;
}

static int registry_save(struct registry *r, char *err, size_t errcap)
{
    /* Build the JSON by hand; all values go through json_escape. */
    size_t cap = 4096, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    buf[0] = '\0';
#define REG_APPEND(fmt, ...)                                                  \
    do {                                                                      \
        int need = snprintf(NULL, 0, fmt, ##__VA_ARGS__);                    \
        if (need < 0) {                                                     \
            free(buf);                                                      \
            snprintf(err, errcap, "out of memory");                         \
            return -1;                                                      \
        }                                                                   \
        while (len + (size_t)need + 1 > cap) {                              \
            cap *= 2;                                                       \
            char *nb = (char *)realloc(buf, cap);                           \
            if (!nb) {                                                      \
                free(buf);                                                  \
                snprintf(err, errcap, "out of memory");                     \
                return -1;                                                  \
            }                                                               \
            buf = nb;                                                       \
        }                                                                   \
        len += (size_t)snprintf(buf + len, cap - len, fmt, ##__VA_ARGS__);  \
    } while (0)
    REG_APPEND("{\"version\":1,\"apps\":[");
    for (size_t i = 0; i < r->n; i++) {
        struct reg_entry *e = &r->entries[i];
        char *eid = json_escape(e->id);
        char *ename = json_escape(e->name);
        char *ever = json_escape(e->version);
        char *epath = json_escape(e->path);
        char *ecolor = json_escape(e->color);
        char *eglyph = json_escape(e->glyph);
        if (!eid || !ename || !ever || !epath || !ecolor || !eglyph) {
            free(eid);
            free(ename);
            free(ever);
            free(epath);
            free(ecolor);
            free(eglyph);
            free(buf);
            snprintf(err, errcap, "out of memory");
            return -1;
        }
        REG_APPEND("%s{\"id\":\"%s\",\"name\":\"%s\",\"version\":\"%s\","
                   "\"path\":\"%s\",\"color\":\"%s\",\"glyph\":\"%s\","
                   "\"system\":%s,\"protected\":%s,"
                   "\"permissions\":[",
                   i ? "," : "", eid, ename, ever, epath, ecolor, eglyph,
                   e->system ? "true" : "false",
                   e->protected_ ? "true" : "false");
        free(eid);
        free(ename);
        free(ever);
        free(epath);
        free(ecolor);
        free(eglyph);
        for (size_t j = 0; j < e->npermissions; j++) {
            char *ep = json_escape(e->permissions[j]);
            if (!ep) {
                free(buf);
                snprintf(err, errcap, "out of memory");
                return -1;
            }
            REG_APPEND("%s\"%s\"", j ? "," : "", ep);
            free(ep);
        }
        if (e->sig_key_id) {
            char *ek = json_escape(e->sig_key_id);
            if (!ek) {
                free(buf);
                snprintf(err, errcap, "out of memory");
                return -1;
            }
            REG_APPEND("],\"signatureKeyId\":\"%s\"}", ek);
            free(ek);
        } else {
            REG_APPEND("],\"signatureKeyId\":null}");
        }
    }
    REG_APPEND("]}\n");
#undef REG_APPEND
    char *path = registry_path();
    if (!path) {
        free(buf);
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    int rc = write_file_atomic(path, buf, len);
    free(buf);
    free(path);
    if (rc != 0) {
        snprintf(err, errcap, "registry: cannot write: %s",
                 strerror(errno));
        return -1;
    }
    return 0;
}

/* --- running check (pid file written by appd) --- */

static int app_running(const char *id)
{
    char *path = path_join(g_run_dir, "");
    if (!path)
        return 0;
    size_t n = strlen(path) + strlen(id) + 5;
    char *full = (char *)malloc(n + 1);
    if (!full) {
        free(path);
        return 0;
    }
    snprintf(full, n + 1, "%s%s.pid", path, id);
    free(path);
    size_t len = 0;
    char *data = read_file(full, &len);
    free(full);
    if (!data)
        return 0;
    long pid = strtol(data, NULL, 10);
    free(data);
    if (pid <= 0)
        return 0;
    if (kill((pid_t)pid, 0) == 0)
        return 1;
    return errno != ESRCH && errno != EPERM ? 1 : 0;
}

/* --- unzip --- */

/* Extract a .sevyn zip into dest (must exist). Forks busybox unzip,
 * falling back to unzip on PATH. Returns 0 on success. */
static int unzip_bundle(const char *bundle, const char *dest)
{
    pid_t pid = fork();
    if (pid < 0)
        return -1;
    if (pid == 0) {
        /* Child: silence stdout, keep stderr for diagnostics. */
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            dup2(devnull, STDOUT_FILENO);
            if (devnull > 2)
                close(devnull);
        }
        execl("/bin/busybox", "busybox", "unzip", "-o", "-q", bundle, "-d",
              dest, (char *)NULL);
        execlp("unzip", "unzip", "-o", "-q", bundle, "-d", dest,
               (char *)NULL);
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR)
            return -1;
    }
    return (WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : -1;
}

/* --- install --- */

/* Install the bundle at bundle_path. Returns 0 on success, 2 on
 * failure, 3 on policy refusal. */
static int cmd_install(const char *bundle_path)
{
    char err[512];
    if (!file_exists(bundle_path)) {
        log_line("LOADER install failed: bundle not found: %s", bundle_path);
        return 2;
    }
    if (mkdir_p(g_apps_dir) != 0) {
        log_line("LOADER install failed: cannot create %s: %s", g_apps_dir,
                 strerror(errno));
        return 2;
    }
    /* Extract to a temp dir inside the apps dir (same filesystem, so
     * the final rename is atomic). */
    char tmp_tmpl[PATH_MAX];
    if (snprintf(tmp_tmpl, sizeof(tmp_tmpl), "%s/.install-XXXXXX",
                 g_apps_dir) >= (int)sizeof(tmp_tmpl)) {
        log_line("LOADER install failed: path too long");
        return 2;
    }
    char *tmp_dir = mkdtemp(tmp_tmpl);
    if (!tmp_dir) {
        log_line("LOADER install failed: mkdtemp: %s", strerror(errno));
        return 2;
    }
    int rc = 2;
    struct manifest m;
    memset(&m, 0, sizeof(m));
    char *manifest_path = path_join(tmp_dir, "manifest.json");
    char *hbc_path = path_join(tmp_dir, "app.hbc");
    if (!manifest_path || !hbc_path) {
        log_line("LOADER install failed: out of memory");
        goto out;
    }
    if (unzip_bundle(bundle_path, tmp_dir) != 0) {
        log_line("LOADER install failed: cannot unzip %s", bundle_path);
        goto out;
    }
    {
        size_t mlen = 0;
        char *mdata = read_file(manifest_path, &mlen);
        if (!mdata) {
            log_line("LOADER install failed: bundle has no manifest.json");
            goto out;
        }
        char jerr[256];
        jval_t *root = json_parse(mdata, jerr, sizeof(jerr));
        free(mdata);
        if (!root) {
            log_line("LOADER install failed: manifest parse error: %s",
                     jerr);
            goto out;
        }
        int sig_ok = 0;
        if (parse_manifest(root, &m, err, sizeof(err), &sig_ok) != 0) {
            json_free(root);
            log_line("LOADER install failed: %s", err);
            goto out;
        }
        json_free(root);
        if (!file_exists(hbc_path)) {
            log_line("LOADER install failed: bundle has no app.hbc");
            goto out;
        }
        /* Verify the bytecode hash. */
        char hash[65];
        if (sha256_file_hex(hbc_path, hash) != 0) {
            log_line("LOADER install failed: cannot hash app.hbc");
            goto out;
        }
        if (strcmp(hash, m.bundle_hash) != 0) {
            log_line("LOADER install failed: bundleHash mismatch for %s "
                     "(manifest %s, actual %s)",
                     m.id, m.bundle_hash, hash);
            goto out;
        }
        /* Signature policy. */
        int trusted = (m.has_signature &&
                       key_trusted(m.sig_key_id, m.sig_pubkey));
        if (m.system && !trusted) {
            log_line("LOADER install refused: %s claims system but has "
                     "no valid trusted signature",
                     m.id);
            rc = 3;
            goto out;
        }
        struct registry reg;
        if (registry_load(&reg, err, sizeof(err)) != 0) {
            log_line("LOADER install failed: %s", err);
            goto out;
        }
        struct reg_entry *existing = registry_find(&reg, m.id);
        if (existing && existing->system && !trusted) {
            log_line("LOADER install refused: replacing system app %s "
                     "requires a trusted signature",
                     m.id);
            registry_free(&reg);
            rc = 3;
            goto out;
        }
        if (!m.system && m.has_signature && !trusted)
            log_line("LOADER note: %s is self-signed (key %s)", m.id,
                     m.sig_key_id);
        /* Move the extracted tree into place. If an app with this id
         * already exists, move it aside first, then restore on error. */
        char *dest = path_join(g_apps_dir, m.id);
        char *backup = NULL;
        if (!dest) {
            log_line("LOADER install failed: out of memory");
            registry_free(&reg);
            goto out;
        }
        if (file_exists(dest)) {
            char bak_tmpl[PATH_MAX];
            if (snprintf(bak_tmpl, sizeof(bak_tmpl),
                         "%s/.backup-XXXXXX", g_apps_dir) >=
                (int)sizeof(bak_tmpl)) {
                free(dest);
                registry_free(&reg);
                log_line("LOADER install failed: path too long");
                goto out;
            }
            backup = mkdtemp(bak_tmpl);
            if (!backup) {
                free(dest);
                registry_free(&reg);
                log_line("LOADER install failed: mkdtemp: %s",
                         strerror(errno));
                goto out;
            }
            /* mkdtemp created the dir; replace it with the old app dir. */
            rmdir(backup);
            if (rename(dest, backup) != 0) {
                log_line("LOADER install failed: cannot move aside %s: %s",
                         dest, strerror(errno));
                free(dest);
                registry_free(&reg);
                goto out;
            }
        }
        if (rename(tmp_dir, dest) != 0) {
            log_line("LOADER install failed: cannot install %s: %s", dest,
                     strerror(errno));
            if (backup)
                rename(backup, dest);
            free(dest);
            registry_free(&reg);
            goto out;
        }
        /* tmp_dir is now the app dir; do not delete it in cleanup. */
        tmp_dir[0] = '\0';
        if (backup)
            rm_rf(backup); /* backup is the stack bak_tmpl buffer: no free */
        /* Update the registry. */
        if (existing)
            registry_remove(&reg, m.id);
        if (reg.n == reg.cap) {
            size_t ncap = reg.cap ? reg.cap * 2 : 8;
            struct reg_entry *nb = (struct reg_entry *)realloc(
                reg.entries, ncap * sizeof(*nb));
            if (!nb) {
                registry_free(&reg);
                free(dest);
                log_line("LOADER install failed: out of memory");
                goto out;
            }
            reg.entries = nb;
            reg.cap = ncap;
        }
        struct reg_entry *e = &reg.entries[reg.n++];
        memset(e, 0, sizeof(*e));
        e->id = strdup(m.id);
        e->name = strdup(m.name);
        e->version = strdup(m.version);
        e->path = strdup(dest);
        e->color = strdup(m.color);
        e->glyph = strdup(m.glyph);
        e->system = m.system;
        /* protected is honoured only for trusted system apps. */
        e->protected_ = (m.protected_ && m.system && trusted) ? 1 : 0;
        e->npermissions = m.npermissions;
        e->permissions = (char **)calloc(m.npermissions ? m.npermissions : 1,
                                         sizeof(char *));
        for (size_t i = 0; i < m.npermissions; i++)
            e->permissions[i] = strdup(m.permissions[i]);
        if (m.has_signature)
            e->sig_key_id = strdup(m.sig_key_id);
        free(dest);
        if (registry_save(&reg, err, sizeof(err)) != 0) {
            registry_free(&reg);
            log_line("LOADER install failed: %s", err);
            goto out;
        }
        registry_free(&reg);
        log_line("LOADER installed %s %s", m.id, m.version);
        rc = 0;
    }
out:
    if (tmp_dir[0] != '\0')
        rm_rf(tmp_dir);
    free(manifest_path);
    free(hbc_path);
    manifest_free(&m);
    return rc;
}

static int cmd_uninstall(const char *id)
{
    char err[512];
    if (!valid_id(id)) {
        log_line("LOADER uninstall failed: invalid id '%s'", id);
        return 2;
    }
    struct registry reg;
    if (registry_load(&reg, err, sizeof(err)) != 0) {
        log_line("LOADER uninstall failed: %s", err);
        return 2;
    }
    struct reg_entry *e = registry_find(&reg, id);
    if (!e) {
        log_line("LOADER uninstall failed: %s is not installed", id);
        registry_free(&reg);
        return 2;
    }
    if (e->protected_) {
        log_line("LOADER uninstall refused: %s is protected", id);
        registry_free(&reg);
        return 3;
    }
    if (app_running(id)) {
        log_line("LOADER uninstall refused: %s is running", id);
        registry_free(&reg);
        return 3;
    }
    char *dir = strdup(e->path);
    registry_remove(&reg, id);
    if (registry_save(&reg, err, sizeof(err)) != 0) {
        free(dir);
        registry_free(&reg);
        log_line("LOADER uninstall failed: %s", err);
        return 2;
    }
    registry_free(&reg);
    if (rm_rf(dir) != 0) {
        log_line("LOADER uninstall warning: could not remove %s: %s", dir,
                 strerror(errno));
    }
    free(dir);
    log_line("LOADER uninstalled %s", id);
    return 0;
}

static int cmd_reinstall(const char *id)
{
    char err[512];
    if (!valid_id(id)) {
        log_line("LOADER reinstall failed: invalid id '%s'", id);
        return 2;
    }
    /* The pristine bundle must exist; reinstall is the same verified
     * install path, so a damaged pristine bundle is refused like any
     * other bad bundle. */
    char *bundle = path_join(g_pristine_dir, "");
    if (!bundle) {
        log_line("LOADER reinstall failed: out of memory");
        return 2;
    }
    size_t n = strlen(bundle) + strlen(id) + 8;
    char *full = (char *)malloc(n + 1);
    if (!full) {
        free(bundle);
        log_line("LOADER reinstall failed: out of memory");
        return 2;
    }
    snprintf(full, n + 1, "%s%s.sevyn", bundle, id);
    free(bundle);
    if (!file_exists(full)) {
        log_line("LOADER reinstall failed: %s is not in pristine", id);
        free(full);
        return 2;
    }
    int rc = cmd_install(full);
    free(full);
    if (rc == 0) {
        /* cmd_install already logged "installed"; add the reinstall
         * marker the harness waits for. */
        log_line("LOADER reinstalled %s from pristine", id);
        (void)err;
    }
    return rc;
}

static int cmd_list(void)
{
    char err[512];
    struct registry reg;
    if (registry_load(&reg, err, sizeof(err)) != 0) {
        log_line("LOADER list failed: %s", err);
        return 2;
    }
    for (size_t i = 0; i < reg.n; i++) {
        struct reg_entry *e = &reg.entries[i];
        printf("%s|%s|%s|%s|%s|system=%d|protected=%d|perms=", e->id, e->name,
               e->version, e->color, e->glyph, e->system, e->protected_);
        for (size_t j = 0; j < e->npermissions; j++)
            printf("%s%s", j ? "," : "", e->permissions[j]);
        printf("|key=%s\n", e->sig_key_id ? e->sig_key_id : "-");
    }
    registry_free(&reg);
    return 0;
}

static int cmd_verify(const char *bundle_path)
{
    char err[512];
    if (!file_exists(bundle_path)) {
        log_line("LOADER verify failed: bundle not found: %s", bundle_path);
        return 2;
    }
    char tmp_tmpl[PATH_MAX];
    if (snprintf(tmp_tmpl, sizeof(tmp_tmpl), "/tmp/.sevyn-verify-XXXXXX") >=
        (int)sizeof(tmp_tmpl)) {
        log_line("LOADER verify failed: path too long");
        return 2;
    }
    char *tmp_dir = mkdtemp(tmp_tmpl);
    if (!tmp_dir) {
        log_line("LOADER verify failed: mkdtemp: %s", strerror(errno));
        return 2;
    }
    int rc = 2;
    if (unzip_bundle(bundle_path, tmp_dir) != 0) {
        log_line("LOADER verify failed: cannot unzip %s", bundle_path);
        goto out;
    }
    {
        char *manifest_path = path_join(tmp_dir, "manifest.json");
        char *hbc_path = path_join(tmp_dir, "app.hbc");
        size_t mlen = 0;
        char *mdata = manifest_path ? read_file(manifest_path, &mlen) : NULL;
        if (!mdata) {
            log_line("LOADER verify failed: bundle has no manifest.json");
            free(manifest_path);
            free(hbc_path);
            goto out;
        }
        char jerr[256];
        jval_t *root = json_parse(mdata, jerr, sizeof(jerr));
        free(mdata);
        if (!root) {
            log_line("LOADER verify failed: manifest parse error: %s", jerr);
            free(manifest_path);
            free(hbc_path);
            goto out;
        }
        struct manifest m;
        int sig_ok = 0;
        if (parse_manifest(root, &m, err, sizeof(err), &sig_ok) != 0) {
            json_free(root);
            log_line("LOADER verify failed: %s", err);
            free(manifest_path);
            free(hbc_path);
            goto out;
        }
        json_free(root);
        if (!hbc_path || !file_exists(hbc_path)) {
            log_line("LOADER verify failed: bundle has no app.hbc");
            manifest_free(&m);
            free(manifest_path);
            free(hbc_path);
            goto out;
        }
        char hash[65];
        if (sha256_file_hex(hbc_path, hash) != 0 ||
            strcmp(hash, m.bundle_hash) != 0) {
            log_line("LOADER verify failed: bundleHash mismatch for %s",
                     m.id);
            manifest_free(&m);
            free(manifest_path);
            free(hbc_path);
            goto out;
        }
        int trusted = (m.has_signature &&
                       key_trusted(m.sig_key_id, m.sig_pubkey));
        if (m.system && !trusted) {
            log_line("LOADER verify failed: %s claims system without a "
                     "trusted signature",
                     m.id);
            manifest_free(&m);
            free(manifest_path);
            free(hbc_path);
            rc = 3;
            goto out;
        }
        log_line("LOADER verified %s %s (system=%d signature=%s trusted=%d)",
                 m.id, m.version, m.system,
                 m.has_signature ? "yes" : "no", trusted);
        manifest_free(&m);
        free(manifest_path);
        free(hbc_path);
        rc = 0;
    }
out:
    rm_rf(tmp_dir);
    return rc;
}

int main(int argc, char **argv)
{
    g_apps_dir = getenv("SEVYN_APPS_DIR");
    if (!g_apps_dir || !*g_apps_dir)
        g_apps_dir = DEFAULT_APPS_DIR;
    g_pristine_dir = getenv("SEVYN_PRISTINE_DIR");
    if (!g_pristine_dir || !*g_pristine_dir)
        g_pristine_dir = DEFAULT_PRISTINE_DIR;
    g_trusted_dir = getenv("SEVYN_TRUSTED_KEYS_DIR");
    if (!g_trusted_dir || !*g_trusted_dir)
        g_trusted_dir = DEFAULT_TRUSTED_KEYS_DIR;
    g_run_dir = getenv("SEVYN_RUN_DIR");
    if (!g_run_dir || !*g_run_dir)
        g_run_dir = DEFAULT_RUN_DIR;

    g_console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    signal(SIGPIPE, SIG_IGN);

    if (argc < 2) {
        fprintf(stderr,
                "usage: sevyn-loader <install|uninstall|reinstall|list|"
                "verify> [arg]\n");
        return 1;
    }
    const char *cmd = argv[1];
    if (strcmp(cmd, "install") == 0) {
        if (argc != 3) {
            fprintf(stderr, "usage: sevyn-loader install <bundle.sevyn>\n");
            return 1;
        }
        return cmd_install(argv[2]);
    }
    if (strcmp(cmd, "uninstall") == 0) {
        if (argc != 3) {
            fprintf(stderr, "usage: sevyn-loader uninstall <id>\n");
            return 1;
        }
        return cmd_uninstall(argv[2]);
    }
    if (strcmp(cmd, "reinstall") == 0) {
        if (argc != 3) {
            fprintf(stderr, "usage: sevyn-loader reinstall <id>\n");
            return 1;
        }
        return cmd_reinstall(argv[2]);
    }
    if (strcmp(cmd, "list") == 0) {
        if (argc != 2) {
            fprintf(stderr, "usage: sevyn-loader list\n");
            return 1;
        }
        return cmd_list();
    }
    if (strcmp(cmd, "verify") == 0) {
        if (argc != 3) {
            fprintf(stderr, "usage: sevyn-loader verify <bundle.sevyn>\n");
            return 1;
        }
        return cmd_verify(argv[2]);
    }
    fprintf(stderr, "sevyn-loader: unknown command '%s'\n", cmd);
    return 1;
}
