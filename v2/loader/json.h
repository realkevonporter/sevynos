/* SevynOS v2 M3 — minimal JSON parser for the app runtime.
 *
 * Parses the flat manifests and registry files the loader and appd
 * read (objects, arrays, strings, numbers, true/false/null). It is
 * deliberately small and strict: duplicate object keys are an error,
 * trailing data after the top-level value is an error, and control
 * characters must be escaped in strings. No streaming, no comments.
 *
 * The loader writes registry.json by hand (fprintf with json_escape),
 * so this file only needs the parse side plus the escaper.
 */
#ifndef SEVYN_JSON_H
#define SEVYN_JSON_H

#include <stddef.h>

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } jtype_t;

typedef struct jval jval_t;

struct jval {
    jtype_t type;
    /* J_BOOL: boolean value. J_NUM: number. */
    int boolean;
    double number;
    /* J_NUM: the exact number lexeme from the input (owned). The
     * canonical feed serializer (M8) re-emits numbers verbatim, so a
     * large integer such as sizeBytes round-trips exactly instead of
     * going through a double. */
    char *numraw;
    /* J_STR: NUL-terminated string (owned). */
    char *string;
    /* J_ARR: items[0..len). J_OBJ: keys/vals pairs, keys owned. */
    jval_t **items;
    char **keys;
    size_t len;
    size_t cap;
};

/* Parse a NUL-terminated JSON document. Returns NULL on error and
 * writes a one-line message into err (if err is non-NULL). */
jval_t *json_parse(const char *text, char *err, size_t errcap);
void json_free(jval_t *v);

/* Object lookup: NULL when `o` is not an object or the key is absent. */
const jval_t *json_obj_get(const jval_t *o, const char *key);
/* String value, or NULL when `v` is not a string. */
const char *json_str(const jval_t *v);
/* Boolean value (dflt when `v` is not a bool). */
int json_bool(const jval_t *v, int dflt);
/* Array helpers. */
size_t json_arr_len(const jval_t *v);
const jval_t *json_arr_get(const jval_t *v, size_t i);

/* Escape `s` for inclusion inside JSON double quotes (no surrounding
 * quotes). Returns a malloc'd string the caller frees. */
char *json_escape(const char *s);

#endif /* SEVYN_JSON_H */
