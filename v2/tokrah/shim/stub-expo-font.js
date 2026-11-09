// SevynOS M6 — expo-font stub. Fonts never load (the host paints
// with DejaVu); loadAsync resolves immediately, isLoaded is false.
module.exports = {
  loadAsync: () => Promise.resolve(),
  isLoaded: () => false,
  isLoading: () => false,
  useFonts: () => [false, null],
  FontDisplay: { AUTO: 0, BLOCK: 1, SWAP: 2, FALLBACK: 3, OPTIONAL: 4 },
};
