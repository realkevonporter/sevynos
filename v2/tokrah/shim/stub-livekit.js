const React = require("react");
// SevynOS M6 — @livekit/react-native stub. Rooms never connect on
// the host (no WebRTC adapter yet); the room renders its children
// and hooks return inert state. The live session proof drives the
// app's session logic against a mock transport, not a real room.
function LiveKitRoom(props) {
  return React.createElement(React.Fragment, null, props && props.children);
}
function VideoTrack() {
  return React.createElement("View", { style: { backgroundColor: "#000000" } });
}
// Fake local participant: no media tracks publish on the host (no
// camera/mic adapter yet), so getTrackPublication returns undefined
// and the enable calls resolve without doing anything. The identity
// matches the mock API's test user.
const fakeLocalParticipant = {
  identity: "m6-user-1",
  sid: "m6-local-participant",
  isMicrophoneEnabled: false,
  isCameraEnabled: false,
  audioTrackPublications: new Map(),
  videoTrackPublications: new Map(),
  getTrackPublication: () => undefined,
  setMicrophoneEnabled: () => Promise.resolve(undefined),
  setCameraEnabled: () => Promise.resolve(undefined),
  // EventEmitter-style chaining: on()/off() return the participant (the
  // media room chains room.on(...).on(...)).
  on: function () {
    return fakeLocalParticipant;
  },
  off: function () {
    return fakeLocalParticipant;
  },
};
// Fake room: never connects (state "disconnected"), so the media room's
// publish/recovery effects early-return instead of touching media.
const fakeRoom = {
  state: "disconnected",
  name: "m6-live",
  sid: "m6-room",
  localParticipant: fakeLocalParticipant,
  remoteParticipants: new Map(),
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  on: function () {
    return fakeRoom;
  },
  off: function () {
    return fakeRoom;
  },
  engine: {},
  options: {},
};
module.exports = {
  LiveKitRoom,
  VideoTrack,
  registerGlobals: () => {},
  useRoomContext: () => fakeRoom,
  useLocalParticipant: () => ({ localParticipant: fakeLocalParticipant, isLocal: true }),
  useTracks: () => [],
  useConnectionState: () => "disconnected",
  useRemoteParticipants: () => [],
  useIsConnected: () => false,
  AudioSession: {
    startAudioSession: () => Promise.resolve(),
    stopAudioSession: () => Promise.resolve(),
    setAppleAudioConfiguration: () => Promise.resolve(),
  },
  AudioDeviceModule: {
    getAudioDevices: () => Promise.resolve([]),
    setAudioDevice: () => Promise.resolve(),
  },
  AndroidAudioTypePresets: { COMMUNICATION: {}, MEDIA: {} },
};
