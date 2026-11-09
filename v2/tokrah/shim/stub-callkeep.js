// SevynOS M6 — react-native-callkeep stub.
// No CallKit on the SevynOS host (no iOS CallKit, no Android
// ConnectionService): every method resolves / no-ops. The async surface
// must return real promises — voip-push.ts calls RNCallKeep.setup(...)
// .catch(...) and call-manager awaits getAudioRoutes()/setAudioRoute();
// a generic stub returning undefined throws at call time.
const resolved = () => Promise.resolve();
const api = {
  setup: resolved,
  setAvailable: resolved,
  setReachable: resolved,
  displayIncomingCall: resolved,
  reportConnectedOutgoingCallWithUUID: resolved,
  reportConnectingOutgoingCallWithUUID: resolved,
  reportEndCallWithUUID: resolved,
  endCall: resolved,
  endAllCalls: resolved,
  startCall: resolved,
  answerCall: resolved,
  rejectCall: resolved,
  setCurrentCallActive: resolved,
  setOnHold: resolved,
  setMutedCall: resolved,
  setAudioRoute: resolved,
  backToForeground: resolved,
  checkPhoneAccountEnabled: () => Promise.resolve(true),
  hasPhoneAccount: () => Promise.resolve(false),
  hasDefaultPhoneAccount: () => Promise.resolve(false),
  getAudioRoutes: () => Promise.resolve([{ name: "Speaker", type: "Speaker" }]),
  addEventListener: () => {},
  removeEventListener: () => {},
};
module.exports = { default: api, ...api };

Object.defineProperty(module.exports, "__esModule", { value: true });
