/* SevynOS v2 M8 — canonical update-feed serialization.
 * See canonical.h for the byte-parity contract with
 * tools/update-signing/canonical.mjs. */
#include "canonical.h"

#include <stdlib.h>
#include <string.h>

/* Growing output buffer. */
struct buf {
    char *data;
    size_t len;
    size_t cap;
};

static int buf_put(struct buf *b, const char *s, size_t n)
{
    if (b->len + n + 1 > b->cap) {
        size_t nc = (b->cap + n + 1) * 2;
        char *nb = (char *)realloc(b->data, nc);
        if (!nb)
            return -1;
        b->data = nb;
        b->cap = nc;
    }
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
    return 0;
}

static int buf_puts(struct buf *b, const char *s)
{
    return buf_put(b, s, strlen(s));
}

static int buf_putc(struct buf *b, char c)
{
    return buf_put(b, &c, 1);
}

static int emit_value(struct buf *b, const jval_t *v, int top);

static int emit_object(struct buf *b, const jval_t *o, int top)
{
    if (buf_putc(b, '{') != 0)
        return -1;
    /* Collect the indices, skipping "signatures" at the top level. */
    size_t n = o->len;
    size_t *idx = (size_t *)malloc((n ? n : 1) * sizeof(*idx));
    if (!idx)
        return -1;
    size_t m = 0;
    for (size_t i = 0; i < n; i++) {
        if (top && strcmp(o->keys[i], "signatures") == 0)
            continue;
        idx[m++] = i;
    }
    /* Insertion sort (objects are small; qsort_r portability is not
     * worth it). */
    for (size_t i = 1; i < m; i++) {
        size_t t = idx[i];
        size_t j = i;
        while (j > 0 && strcmp(o->keys[idx[j - 1]], o->keys[t]) > 0) {
            idx[j] = idx[j - 1];
            j--;
        }
        idx[j] = t;
    }
    for (size_t k = 0; k < m; k++) {
        size_t i = idx[k];
        if (k > 0 && buf_putc(b, ',') != 0) {
            free(idx);
            return -1;
        }
        char *esc = json_escape(o->keys[i]);
        if (!esc) {
            free(idx);
            return -1;
        }
        if (buf_putc(b, '"') != 0 || buf_puts(b, esc) != 0 ||
            buf_puts(b, "\":") != 0) {
            free(esc);
            free(idx);
            return -1;
        }
        free(esc);
        if (emit_value(b, o->items[i], 0) != 0) {
            free(idx);
            return -1;
        }
    }
    free(idx);
    return buf_putc(b, '}');
}

static int emit_value(struct buf *b, const jval_t *v, int top)
{
    switch (v->type) {
    case J_NULL:
        return buf_puts(b, "null");
    case J_BOOL:
        return buf_puts(b, v->boolean ? "true" : "false");
    case J_NUM:
        /* Exact input lexeme (see json.h numraw). */
        return buf_puts(b, v->numraw ? v->numraw : "0");
    case J_STR: {
        char *esc = json_escape(v->string ? v->string : "");
        if (!esc)
            return -1;
        int rc = buf_putc(b, '"') != 0 || buf_puts(b, esc) != 0 ||
                 buf_putc(b, '"') != 0;
        free(esc);
        return rc ? -1 : 0;
    }
    case J_ARR: {
        if (buf_putc(b, '[') != 0)
            return -1;
        for (size_t i = 0; i < v->len; i++) {
            if (i > 0 && buf_putc(b, ',') != 0)
                return -1;
            if (emit_value(b, v->items[i], 0) != 0)
                return -1;
        }
        return buf_putc(b, ']');
    }
    case J_OBJ:
        return emit_object(b, v, top);
    }
    return -1;
}

char *canonical_feed_body(const jval_t *manifest)
{
    if (!manifest || manifest->type != J_OBJ)
        return NULL;
    struct buf b;
    b.cap = 512;
    b.len = 0;
    b.data = (char *)malloc(b.cap);
    if (!b.data)
        return NULL;
    b.data[0] = '\0';
    if (emit_value(&b, manifest, 1) != 0) {
        free(b.data);
        return NULL;
    }
    return b.data;
}
