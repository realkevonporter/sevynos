/* SevynOS v2 M3 — minimal JSON parser (see json.h). */
#include "json.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *p;
    char *err;
    size_t errcap;
    int failed;
} parser_t;

static void fail(parser_t *ps, const char *msg)
{
    if (!ps->failed && ps->err && ps->errcap > 0)
        snprintf(ps->err, ps->errcap, "%s", msg);
    ps->failed = 1;
}

static jval_t *new_val(jtype_t type)
{
    jval_t *v = (jval_t *)calloc(1, sizeof(*v));
    if (v)
        v->type = type;
    return v;
}

static void skip_ws(parser_t *ps)
{
    while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r')
        ps->p++;
}

static int hex_val(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

/* Append one UTF-8 encoded code point to a growing buffer. */
static int utf8_put(char **buf, size_t *len, size_t *cap, unsigned cp)
{
    char tmp[4];
    int n = 0;
    if (cp < 0x80) {
        tmp[n++] = (char)cp;
    } else if (cp < 0x800) {
        tmp[n++] = (char)(0xC0 | (cp >> 6));
        tmp[n++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        tmp[n++] = (char)(0xE0 | (cp >> 12));
        tmp[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        tmp[n++] = (char)(0x80 | (cp & 0x3F));
    } else {
        tmp[n++] = (char)(0xF0 | (cp >> 18));
        tmp[n++] = (char)(0x80 | ((cp >> 12) & 0x3F));
        tmp[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        tmp[n++] = (char)(0x80 | (cp & 0x3F));
    }
    if (*len + (size_t)n + 1 > *cap) {
        size_t ncap = *cap ? *cap * 2 : 32;
        while (ncap < *len + (size_t)n + 1)
            ncap *= 2;
        char *nb = (char *)realloc(*buf, ncap);
        if (!nb)
            return 0;
        *buf = nb;
        *cap = ncap;
    }
    memcpy(*buf + *len, tmp, (size_t)n);
    *len += (size_t)n;
    (*buf)[*len] = '\0';
    return 1;
}

/* Append one raw byte to a growing buffer. Raw bytes are already
 * UTF-8; they must be copied through unchanged, NOT fed to utf8_put
 * as code points — utf8_put would re-encode each byte >= 0x80 as its
 * own 2-byte sequence, doubling the string on every parse/save
 * round-trip. (That is what corrupted the installer's "↓" glyph:
 * 3 bytes became ~2000 after the seed, until its APP line overflowed
 * appd's LIST buffer and swallowed the messages line.) */
static int buf_put_byte(char **buf, size_t *len, size_t *cap, unsigned char c)
{
    if (*len + 2 > *cap) {
        size_t ncap = *cap ? *cap * 2 : 32;
        while (ncap < *len + 2)
            ncap *= 2;
        char *nb = (char *)realloc(*buf, ncap);
        if (!nb)
            return 0;
        *buf = nb;
        *cap = ncap;
    }
    (*buf)[(*len)++] = (char)c;
    (*buf)[*len] = '\0';
    return 1;
}

static char *parse_string_raw(parser_t *ps)
{
    /* ps->p points at the opening quote. */
    if (*ps->p != '"') {
        fail(ps, "expected string");
        return NULL;
    }
    ps->p++;
    char *buf = NULL;
    size_t len = 0, cap = 0;
    for (;;) {
        unsigned char c = (unsigned char)*ps->p;
        if (c == '\0') {
            fail(ps, "unterminated string");
            free(buf);
            return NULL;
        }
        if (c == '"') {
            ps->p++;
            return buf ? buf : strdup("");
        }
        if (c < 0x20) {
            fail(ps, "control character in string");
            free(buf);
            return NULL;
        }
        if (c == '\\') {
            ps->p++;
            char e = *ps->p;
            if (e == '\0') {
                fail(ps, "unterminated escape");
                free(buf);
                return NULL;
            }
            ps->p++;
            unsigned cp = 0;
            switch (e) {
            case '"': cp = '"'; break;
            case '\\': cp = '\\'; break;
            case '/': cp = '/'; break;
            case 'b': cp = '\b'; break;
            case 'f': cp = '\f'; break;
            case 'n': cp = '\n'; break;
            case 'r': cp = '\r'; break;
            case 't': cp = '\t'; break;
            case 'u': {
                unsigned v = 0;
                for (int i = 0; i < 4; i++) {
                    int h = hex_val(ps->p[i]);
                    if (h < 0) {
                        fail(ps, "bad \\u escape");
                        free(buf);
                        return NULL;
                    }
                    v = (v << 4) | (unsigned)h;
                }
                ps->p += 4;
                if (v >= 0xD800 && v <= 0xDBFF) {
                    /* High surrogate: expect \uDC00-\uDFFF. */
                    if (ps->p[0] == '\\' && ps->p[1] == 'u') {
                        unsigned lo = 0;
                        int ok = 1;
                        for (int i = 0; i < 4; i++) {
                            int h = hex_val(ps->p[2 + i]);
                            if (h < 0)
                                ok = 0;
                            else
                                lo = (lo << 4) | (unsigned)h;
                        }
                        if (ok && lo >= 0xDC00 && lo <= 0xDFFF) {
                            ps->p += 6;
                            cp = 0x10000 + ((v - 0xD800) << 10) +
                                 (lo - 0xDC00);
                        } else {
                            cp = 0xFFFD;
                        }
                    } else {
                        cp = 0xFFFD;
                    }
                } else if (v >= 0xDC00 && v <= 0xDFFF) {
                    cp = 0xFFFD;
                } else {
                    cp = v;
                }
                break;
            }
            default:
                fail(ps, "bad escape");
                free(buf);
                return NULL;
            }
            if (cp == 0) {
                /* NUL in a string: keep it out — manifests never need
                 * it, and C strings cannot hold it. */
                cp = 0xFFFD;
            }
            if (!utf8_put(&buf, &len, &cap, cp)) {
                fail(ps, "out of memory");
                free(buf);
                return NULL;
            }
            continue;
        }
        /* Raw byte (part of a UTF-8 sequence or ASCII). Copy through
         * unchanged — see buf_put_byte. */
        if (!buf_put_byte(&buf, &len, &cap, c)) {
            fail(ps, "out of memory");
            free(buf);
            return NULL;
        }
        ps->p++;
    }
}

static jval_t *parse_value(parser_t *ps);

static int grow(jval_t *v, size_t need)
{
    if (v->len + need <= v->cap)
        return 1;
    size_t ncap = v->cap ? v->cap * 2 : 8;
    while (ncap < v->len + need)
        ncap *= 2;
    if (v->type == J_ARR) {
        jval_t **nb = (jval_t **)realloc(v->items, ncap * sizeof(*nb));
        if (!nb)
            return 0;
        v->items = nb;
    } else {
        jval_t **nb = (jval_t **)realloc(v->items, ncap * sizeof(*nb));
        char **kb = (char **)realloc(v->keys, ncap * sizeof(*kb));
        if (!nb || !kb)
            return 0;
        v->items = nb;
        v->keys = kb;
    }
    v->cap = ncap;
    return 1;
}

static jval_t *parse_value(parser_t *ps)
{
    skip_ws(ps);
    char c = *ps->p;
    if (c == '{') {
        ps->p++;
        jval_t *o = new_val(J_OBJ);
        if (!o) {
            fail(ps, "out of memory");
            return NULL;
        }
        skip_ws(ps);
        if (*ps->p == '}') {
            ps->p++;
            return o;
        }
        for (;;) {
            skip_ws(ps);
            if (*ps->p != '"') {
                fail(ps, "expected object key");
                json_free(o);
                return NULL;
            }
            char *key = parse_string_raw(ps);
            if (!key) {
                json_free(o);
                return NULL;
            }
            /* Duplicate keys are an error. */
            for (size_t i = 0; i < o->len; i++) {
                if (strcmp(o->keys[i], key) == 0) {
                    fail(ps, "duplicate object key");
                    free(key);
                    json_free(o);
                    return NULL;
                }
            }
            skip_ws(ps);
            if (*ps->p != ':') {
                fail(ps, "expected ':'");
                free(key);
                json_free(o);
                return NULL;
            }
            ps->p++;
            jval_t *val = parse_value(ps);
            if (!val) {
                free(key);
                json_free(o);
                return NULL;
            }
            if (!grow(o, 1)) {
                fail(ps, "out of memory");
                free(key);
                json_free(val);
                json_free(o);
                return NULL;
            }
            o->keys[o->len] = key;
            o->items[o->len] = val;
            o->len++;
            skip_ws(ps);
            if (*ps->p == ',') {
                ps->p++;
                continue;
            }
            if (*ps->p == '}') {
                ps->p++;
                return o;
            }
            fail(ps, "expected ',' or '}'");
            json_free(o);
            return NULL;
        }
    }
    if (c == '[') {
        ps->p++;
        jval_t *a = new_val(J_ARR);
        if (!a) {
            fail(ps, "out of memory");
            return NULL;
        }
        skip_ws(ps);
        if (*ps->p == ']') {
            ps->p++;
            return a;
        }
        for (;;) {
            jval_t *val = parse_value(ps);
            if (!val) {
                json_free(a);
                return NULL;
            }
            if (!grow(a, 1)) {
                fail(ps, "out of memory");
                json_free(val);
                json_free(a);
                return NULL;
            }
            a->items[a->len++] = val;
            skip_ws(ps);
            if (*ps->p == ',') {
                ps->p++;
                continue;
            }
            if (*ps->p == ']') {
                ps->p++;
                return a;
            }
            fail(ps, "expected ',' or ']'");
            json_free(a);
            return NULL;
        }
    }
    if (c == '"') {
        char *s = parse_string_raw(ps);
        if (!s)
            return NULL;
        jval_t *v = new_val(J_STR);
        if (!v) {
            free(s);
            fail(ps, "out of memory");
            return NULL;
        }
        v->string = s;
        return v;
    }
    if (c == 't' && strncmp(ps->p, "true", 4) == 0) {
        ps->p += 4;
        jval_t *v = new_val(J_BOOL);
        if (v)
            v->boolean = 1;
        return v;
    }
    if (c == 'f' && strncmp(ps->p, "false", 5) == 0) {
        ps->p += 5;
        jval_t *v = new_val(J_BOOL);
        if (v)
            v->boolean = 0;
        return v;
    }
    if (c == 'n' && strncmp(ps->p, "null", 4) == 0) {
        ps->p += 4;
        return new_val(J_NULL);
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        const char *start = ps->p;
        char *end = NULL;
        double d = strtod(ps->p, &end);
        if (end == ps->p) {
            fail(ps, "bad number");
            return NULL;
        }
        ps->p = end;
        jval_t *v = new_val(J_NUM);
        if (v) {
            v->number = d;
            /* Keep the exact lexeme for byte-exact re-serialization. */
            size_t n = (size_t)(end - start);
            v->numraw = (char *)malloc(n + 1);
            if (v->numraw) {
                memcpy(v->numraw, start, n);
                v->numraw[n] = '\0';
            }
        }
        return v;
    }
    fail(ps, "unexpected character");
    return NULL;
}

jval_t *json_parse(const char *text, char *err, size_t errcap)
{
    parser_t ps;
    ps.p = text;
    ps.err = err;
    ps.errcap = errcap;
    ps.failed = 0;
    if (err && errcap > 0)
        err[0] = '\0';
    jval_t *v = parse_value(&ps);
    if (!v)
        return NULL;
    skip_ws(&ps);
    if (*ps.p != '\0') {
        if (err && errcap > 0)
            snprintf(err, errcap, "trailing data after top-level value");
        json_free(v);
        return NULL;
    }
    if (ps.failed) {
        if (err && errcap > 0 && err[0] == '\0')
            snprintf(err, errcap, "parse error");
        json_free(v);
        return NULL;
    }
    return v;
}

void json_free(jval_t *v)
{
    if (!v)
        return;
    free(v->string);
    free(v->numraw);
    for (size_t i = 0; i < v->len; i++) {
        free(v->keys ? v->keys[i] : NULL);
        json_free(v->items[i]);
    }
    free(v->items);
    free(v->keys);
    free(v);
}

const jval_t *json_obj_get(const jval_t *o, const char *key)
{
    if (!o || o->type != J_OBJ)
        return NULL;
    for (size_t i = 0; i < o->len; i++)
        if (strcmp(o->keys[i], key) == 0)
            return o->items[i];
    return NULL;
}

const char *json_str(const jval_t *v)
{
    if (!v || v->type != J_STR)
        return NULL;
    return v->string;
}

int json_bool(const jval_t *v, int dflt)
{
    if (!v || v->type != J_BOOL)
        return dflt;
    return v->boolean;
}

size_t json_arr_len(const jval_t *v)
{
    if (!v || v->type != J_ARR)
        return 0;
    return v->len;
}

const jval_t *json_arr_get(const jval_t *v, size_t i)
{
    if (!v || v->type != J_ARR || i >= v->len)
        return NULL;
    return v->items[i];
}

char *json_escape(const char *s)
{
    if (!s)
        return strdup("");
    size_t cap = strlen(s) * 2 + 1;
    char *out = (char *)malloc(cap);
    if (!out)
        return NULL;
    size_t len = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        char tmp[8];
        int n = 0;
        switch (*p) {
        case '"': tmp[n++] = '\\'; tmp[n++] = '"'; break;
        case '\\': tmp[n++] = '\\'; tmp[n++] = '\\'; break;
        case '\b': tmp[n++] = '\\'; tmp[n++] = 'b'; break;
        case '\f': tmp[n++] = '\\'; tmp[n++] = 'f'; break;
        case '\n': tmp[n++] = '\\'; tmp[n++] = 'n'; break;
        case '\r': tmp[n++] = '\\'; tmp[n++] = 'r'; break;
        case '\t': tmp[n++] = '\\'; tmp[n++] = 't'; break;
        default:
            if (*p < 0x20) {
                n = snprintf(tmp, sizeof(tmp), "\\u%04x", *p);
            } else {
                tmp[n++] = (char)*p;
            }
            break;
        }
        if (len + (size_t)n + 1 > cap) {
            cap = (cap + (size_t)n) * 2;
            char *nb = (char *)realloc(out, cap);
            if (!nb) {
                free(out);
                return NULL;
            }
            out = nb;
        }
        memcpy(out + len, tmp, (size_t)n);
        len += (size_t)n;
    }
    out[len] = '\0';
    return out;
}
