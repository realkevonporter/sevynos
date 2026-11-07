/* SevynOS v2 — shared verification primitives (M3 loader, M8 updater).
 *
 * Factored out of sevyn-loader.c (M8) so the loader and the update
 * daemon share exactly one copy of the crypto: SHA-256 (hex + file),
 * base64 decode, lowercase-hex check, Ed25519 verify, and the keyId
 * rule (first 16 hex chars of sha256(publicKey)).
 *
 * Build: gcc, libc + libcrypto (SHA-256 + Ed25519).
 */
#ifndef SEVYN_VERIFY_H
#define SEVYN_VERIFY_H

#include <stddef.h>

/* SHA-256 of data as 64 lowercase hex chars + NUL in out[65]. 0 ok. */
int sha256_hex(const unsigned char *data, size_t len, char out[65]);
/* SHA-256 of a file's contents, same format. 0 ok, -1 on I/O/crypto error. */
int sha256_file_hex(const char *path, char out[65]);

/* Standard base64 decode. Returns malloc'd bytes (or NULL on error);
 * the length goes into *out_len. Padding '=' is required at the end. */
unsigned char *b64_decode(const char *s, size_t *out_len);

/* Base64url decode (JWK "x": '-' for '+', '_' for '/', padding
 * optional). Returns malloc'd bytes (or NULL on error); length in
 * *out_len. */
unsigned char *b64url_decode(const char *s, size_t *out_len);

/* 1 when s is exactly len lowercase hex chars, else 0. */
int is_hex(const char *s, size_t len);

/* Ed25519 verify: 1 when sig (64 bytes) is a valid signature by pubkey
 * (32 bytes) over msg[0..msglen). 0 on failure. Pure verification —
 * no trust decision: callers check the key against the trusted-keys
 * dir themselves (key_trusted in the loader, same rule in the updater). */
int ed25519_verify(const unsigned char *pubkey, const unsigned char *sig,
                   const unsigned char *msg, size_t msglen);

/* keyId for a public key: first 16 hex chars of sha256(pubkey), plus
 * NUL, in out[17]. 0 ok. */
int key_id_for_pubkey(const unsigned char *pubkey, char out[17]);

#endif /* SEVYN_VERIFY_H */
