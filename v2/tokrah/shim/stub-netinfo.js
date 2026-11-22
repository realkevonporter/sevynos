// SevynOS M6/M7/M9 — @react-native-community/netinfo dedicated stub.
//
// NetInfo graduated from the generic stub (2026-11-22, harness fix
// for the M6/M7/M9 failure): the mount path CALLS it for real, so the
// generic stub's "every call returns undefined" broke the contract.
// Tokrah's offline layer (storage/offline/connectivity.ts, #352) does
// `NetInfo.fetch().then(...)` inside ensureConnectivityListener — with
// the generic stub fetch() returned undefined, `.then` threw
// ("Cannot read properties of undefined (reading 'then')"), and the
// warn masked the real failure. The README's rule 1 applies:
// promises stay promises.
//
// The host has no radio, so the stub reports a fixed ONLINE state —
// the same fail-open answer the app's connectivity layer wants
// (isConnected === true, isInternetReachable === true). fetch()
// resolves a fresh copy; addEventListener delivers the current state
// on subscribe (as the real API does) and returns an unsubscribe
// function. No listener is ever called with an offline state: the
// harness is always online, and an offline transition would only
// make the app queue work it can never drain in the mock host.
const ONLINE_STATE = {
  type: "wifi",
  isConnected: true,
  isInternetReachable: true,
  isWifiEnabled: true,
  details: {
    isConnectionExpensive: false,
    ipAddress: undefined,
    subnet: undefined,
  },
};

function onlineState() {
  return { ...ONLINE_STATE, details: { ...ONLINE_STATE.details } };
}

const listeners = new Set();
function fetch() {
  return Promise.resolve(onlineState());
}
function addEventListener(listener) {
  if (typeof listener === "function") {
    listeners.add(listener);
    // Deliver the current state on subscribe, like the real API.
    listener(onlineState());
  }
  return () => {
    listeners.delete(listener);
  };
}
function refresh() {
  return fetch();
}

const NetInfo = {
  fetch,
  addEventListener,
  refresh,
  // Named enum export (the real package's NetInfoStateType).
  NetInfoStateType: {
    unknown: "unknown",
    none: "none",
    cellular: "cellular",
    wifi: "wifi",
    bluetooth: "bluetooth",
    ethernet: "ethernet",
    wimax: "wimax",
    vpn: "vpn",
    other: "other",
  },
};

module.exports = {
  ...NetInfo,
  default: NetInfo,
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
