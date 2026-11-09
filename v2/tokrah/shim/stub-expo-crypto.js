// SevynOS M6 — expo-crypto stub.
module.exports = {
  getRandomBytesAsync: (n) => Promise.resolve(new Uint8Array(n || 0)),
  getRandomBytes: (n) => new Uint8Array(n || 0),
  digestStringAsync: () => Promise.resolve(""),
  CryptoDigestAlgorithm: {
    SHA256: "SHA-256",
    SHA384: "SHA-384",
    SHA512: "SHA-512",
    MD5: "MD5",
    SHA1: "SHA-1",
  },
  CryptoEncoding: { HEX: "hex", BASE64: "base64" },
};
