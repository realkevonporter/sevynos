// SevynOS M6 — expo-web-browser stub. Links open nowhere on the host.
module.exports = {
  openBrowserAsync: () => Promise.resolve({ type: "dismiss" }),
  openAuthSessionAsync: () => Promise.resolve({ type: "dismiss" }),
  dismissBrowser: () => Promise.resolve(),
  warmUpAsync: () => Promise.resolve(),
  coolDownAsync: () => Promise.resolve(),
  mayInitWithUrlAsync: () => Promise.resolve(),
};
