/* SevynOS v2 M3 — tiny Ed25519 signing helper.
 *
 * The openssl CLI cannot sign Ed25519 in one shot (pkeyutl -sign
 * fails for this key type in OpenSSL 3.0), so the bundle tooling uses
 * this helper instead. It reads the message on stdin and writes the
 * 64-byte raw signature on stdout.
 *
 * Usage: ed25519-sign <private-key.pem> < message > signature.bin
 *
 * The verifier (sevyn-loader) uses the same libcrypto calls, so a
 * signature made here is exactly what the loader checks.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/evp.h>
#include <openssl/pem.h>

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: ed25519-sign <private-key.pem>\n");
        return 1;
    }
    FILE *kf = fopen(argv[1], "r");
    if (!kf) {
        perror("open private key");
        return 1;
    }
    EVP_PKEY *pkey = PEM_read_PrivateKey(kf, NULL, NULL, NULL);
    fclose(kf);
    if (!pkey) {
        fprintf(stderr, "ed25519-sign: cannot read private key\n");
        return 1;
    }
    /* Read stdin fully. */
    size_t cap = 4096, len = 0;
    unsigned char *msg = (unsigned char *)malloc(cap);
    if (!msg) {
        EVP_PKEY_free(pkey);
        return 1;
    }
    size_t n;
    while ((n = fread(msg + len, 1, cap - len, stdin)) > 0) {
        len += n;
        if (len == cap) {
            cap *= 2;
            unsigned char *nb =
                (unsigned char *)realloc(msg, cap);
            if (!nb) {
                free(msg);
                EVP_PKEY_free(pkey);
                return 1;
            }
            msg = nb;
        }
    }
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    if (!ctx) {
        free(msg);
        EVP_PKEY_free(pkey);
        return 1;
    }
    size_t siglen = 0;
    unsigned char sig[64];
    int ok = 0;
    if (EVP_DigestSignInit(ctx, NULL, NULL, NULL, pkey) == 1 &&
        EVP_DigestSign(ctx, NULL, &siglen, msg, len) == 1 &&
        siglen == 64 &&
        EVP_DigestSign(ctx, sig, &siglen, msg, len) == 1)
        ok = 1;
    EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(pkey);
    free(msg);
    if (!ok) {
        fprintf(stderr, "ed25519-sign: signing failed\n");
        return 1;
    }
    if (fwrite(sig, 1, 64, stdout) != 64) {
        fprintf(stderr, "ed25519-sign: write failed\n");
        return 1;
    }
    return 0;
}
