// SevynOS M6 — expo-web-browser stub. Links open nowhere on the host.
module.exports = {
  openBrowserAsync: () => Promise.resolve({ type: "dismiss" }),
  openAuthSessionAsync: () => Promise.resolve({ type: "dismiss" }),
  dismissBrowser: () => Promise.resolve(),
  warmUpAsync: () => Promise.resolve(),
  coolDownAsync: () => Promise.resolve(),
  mayInitWithUrlAsync: () => Promise.resolve(),
  // Tokrah #353's GoogleSignInButton calls this at MODULE SCOPE
  // (WebBrowser.maybeCompleteAuthSession()) — the stub MUST provide
  // it, or the auth screen's module load throws and the app mounts
  // blank (M6/M7/M9 failure 2026-11-22: "WebBrowser
  // .maybeCompleteAuthSession is not a function"). The real API
  // resolves to the redirect auth result, or null when the app was
  // not opened via a redirect — the harness never is, so null.
  maybeCompleteAuthSession: () => Promise.resolve(null),
};
