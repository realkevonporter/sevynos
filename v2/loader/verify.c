/* SevynOS v2 — shared verification primitives (M3 loader, M8 updater).
 *
 * Moved verbatim out of sevyn-loader.c (M8); the loader links this file
 * instead of carrying its own copies, and the update daemon links it
 * too. No behaviour change: the byte-for-byte functions are the ones
 * the loader's 30 checks already exercise.
 */
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/evp.h>

#include "verify.h"

int sha256_hex(const unsigned char *data, size_t len, char out[65])
{
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int dlen = 0;
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    if (!ctx)
        return -1;
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), NULL) != 1 ||
        EVP_DigestUpdate(ctx, data, len) != 1 ||
        EVP_DigestFinal_ex(ctx, digest, &dlen) != 1) {
        EVP_MD_CTX_free(ctx);
        return -1;
    }
    EVP_MD_CTX_free(ctx);
    static const char hexd[] = "0123456789abcdef";
    for (unsigned int i = 0; i < dlen; i++) {
        out[i * 2] = hexd[digest[i] >> 4];
        out[i * 2 + 1] = hexd[digest[i] & 0xF];
    }
    out[dlen * 2] = '\0';
    return 0;
}

int sha256_file_hex(const char *path, char out[65])
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return -1;
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    if (!ctx) {
        fclose(f);
        return -1;
    }
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), NULL) != 1) {
        EVP_MD_CTX_free(ctx);
        fclose(f);
        return -1;
    }
    unsigned char buf[8192];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        if (EVP_DigestUpdate(ctx, buf, n) != 1) {
            EVP_MD_CTX_free(ctx);
            fclose(f);
            return -1;
        }
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int dlen = 0;
    if (EVP_DigestFinal_ex(ctx, digest, &dlen) != 1) {
        EVP_MD_CTX_free(ctx);
        fclose(f);
        return -1;
    }
    EVP_MD_CTX_free(ctx);
    fclose(f);
    static const char hexd[] = "0123456789abcdef";
    for (unsigned int i = 0; i < dlen; i++) {
        out[i * 2] = hexd[digest[i] >> 4];
        out[i * 2 + 1] = hexd[digest[i] & 0xF];
    }
    out[dlen * 2] = '\0';
    return 0;
}

static int b64_val(char c)
{
    if (c >= 'A' && c <= 'Z')
        return c - 'A';
    if (c >= 'a' && c <= 'z')
        return c - 'a' + 26;
    if (c >= '0' && c <= '9')
        return c - '0' + 52;
    if (c == '+')
        return 62;
    if (c == '/')
        return 63;
    return -1;
}

unsigned char *b64_decode(const char *s, size_t *out_len)
{
    size_t n = strlen(s);
    if (n % 4 != 0)
        return NULL;
    size_t cap = n / 4 * 3;
    unsigned char *out = (unsigned char *)malloc(cap + 1);
    if (!out)
        return NULL;
    size_t o = 0;
    for (size_t i = 0; i < n; i += 4) {
        int v[4];
        int pad = 0;
        for (int j = 0; j < 4; j++) {
            char c = s[i + (size_t)j];
            if (c == '=') {
                v[j] = 0;
                pad++;
            } else {
                v[j] = b64_val(c);
                if (v[j] < 0) {
                    free(out);
                    return NULL;
                }
            }
        }
        if (pad > 2 || (i + 4 < n && pad > 0)) {
            free(out);
            return NULL;
        }
        unsigned triple = (unsigned)((v[0] << 18) | (v[1] << 12) |
                                     (v[2] << 6) | v[3]);
        out[o++] = (unsigned char)((triple >> 16) & 0xFF);
        if (pad < 2)
            out[o++] = (unsigned char)((triple >> 8) & 0xFF);
        if (pad < 1)
            out[o++] = (unsigned char)(triple & 0xFF);
    }
    *out_len = o;
    return out;
}

/* Decode a base64url string (JWK "x": '-' for '+', '_' for '/', no
 * padding) into a malloc'd buffer. Returns NULL on bad input.
 * Caller frees the buffer; *out_len gets its length. */
unsigned char *b64url_decode(const char *s, size_t *out_len)
{
    if (!s)
        return NULL;
    size_t n = strlen(s);
    /* Drop any padding, then normalize to standard base64. */
    while (n > 0 && s[n - 1] == '=')
        n--;
    if (n % 4 == 1)
        return NULL; /* no valid base64 string has this length */
    char *norm = (char *)malloc(n + 4);
    if (!norm)
        return NULL;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (c == '-')
            c = '+';
        else if (c == '_')
            c = '/';
        else if (!isalnum((unsigned char)c) && c != '+' && c != '/') {
            free(norm);
            return NULL;
        }
        norm[i] = c;
    }
    size_t m = n;
    while (m % 4 != 0)
        norm[m++] = '=';
    norm[m] = '\0';
    unsigned char *out = b64_decode(norm, out_len);
    free(norm);
    return out;
}

int is_hex(const char *s, size_t len)
{
    if (strlen(s) != len)
        return 0;
    for (size_t i = 0; i < len; i++)
        if (!isxdigit((unsigned char)s[i]) ||
            (s[i] >= 'A' && s[i] <= 'F'))
            return 0; /* lowercase hex only */
    return 1;
}

int ed25519_verify(const unsigned char *pubkey, const unsigned char *sig,
                   const unsigned char *msg, size_t msglen)
{
    EVP_PKEY *pkey = EVP_PKEY_new_raw_public_key(
        EVP_PKEY_ED25519, NULL, pubkey, 32);
    if (!pkey)
        return 0;
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    int ok = 0;
    if (ctx &&
        EVP_DigestVerifyInit(ctx, NULL, NULL, NULL, pkey) == 1 &&
        EVP_DigestVerify(ctx, sig, 64, msg, msglen) == 1)
        ok = 1;
    EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(pkey);
    return ok;
}

int key_id_for_pubkey(const unsigned char *pubkey, char out[17])
{
    char pub_hash[65];
    if (sha256_hex(pubkey, 32, pub_hash) != 0)
        return -1;
    memcpy(out, pub_hash, 16);
    out[16] = '\0';
    return 0;
}
