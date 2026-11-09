// SevynOS M6 — expo-clipboard stub. No clipboard in the guest.
module.exports = {
  getStringAsync: () => Promise.resolve(""),
  setStringAsync: () => Promise.resolve(),
  hasStringAsync: () => Promise.resolve(false),
  getImageAsync: () => Promise.resolve(null),
  setImageAsync: () => Promise.resolve(false),
  setUrlAsync: () => Promise.resolve(false),
  getUrlAsync: () => Promise.resolve(""),
  addClipboardListener: () => ({ remove() {} }),
  removeClipboardListener: () => {},
};
