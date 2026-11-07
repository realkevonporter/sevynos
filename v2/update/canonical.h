/* SevynOS v2 M8 — canonical update-feed serialization.
 *
 * Byte-identical to tools/update-signing/canonical.mjs, the single
 * source of truth for the byte layout that gets signed:
 *
 *   1. Start from the parsed feed manifest object.
 *   2. Remove the top-level "signatures" field (signatures sign the
 *      body, never themselves).
 *   3. Recursively sort every object's keys by UTF-16 code-unit order
 *      (array order is preserved; JSON has no other ordering).
 *   4. Serialize with compact JSON (no whitespace, no trailing
 *      newline).
 *
 * Notes on the byte parity:
 * - Keys in real feeds are ASCII, where UTF-16 code-unit order is
 *   plain byte order (strcmp). Non-ASCII keys are not expected in
 *   feeds; they would sort by UTF-8 byte order here, which can differ
 *   from UTF-16 order for characters outside the BMP. Accepted: the
 *   feed generator only emits ASCII keys.
 * - Strings are re-emitted with json_escape, whose rules match
 *   JSON.stringify (short escapes for \b \f \n \r \t, \u00XX for other
 *   control chars, UTF-8 passed through, no escaping of '/').
 * - Numbers are re-emitted from the parser's exact lexeme (jval_t
 *   numraw), so a sizeBytes integer round-trips exactly. The feed
 *   generator (tools/qemu/build.mjs) emits sizeBytes as a plain
 *   integer via JSON.stringify, and JSON.stringify prints integers
 *   in plain decimal — so the lexeme IS the signed form for every
 *   feed the pipeline can produce. A hand-crafted feed with a
 *   non-integer number lexeme (1.5, -2e3) would canonicalize to the
 *   lexeme rather than JSON.stringify's normalized form and fail
 *   verification — fail-closed, never falsely accepted.
 * - A lone surrogate in an input string decodes to U+FFFD in the
 *   parser while JSON.stringify would re-emit the escape; feeds are
 *   machine-generated and never contain lone surrogates.
 *
 * Build: gcc, libc. Links json.c + verify.c (only for the header).
 */
#ifndef SEVYN_CANONICAL_H
#define SEVYN_CANONICAL_H

#include "../loader/json.h"

/* Canonical body of a parsed feed manifest (top-level "signatures"
 * stripped, keys sorted recursively, compact JSON). Returns a
 * malloc'd NUL-terminated string the caller frees, or NULL on
 * allocation failure. `manifest` must be a J_OBJ. */
char *canonical_feed_body(const jval_t *manifest);

#endif /* SEVYN_CANONICAL_H */
