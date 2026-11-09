// SevynOS M6 — expo-audio stub. Audio is inert.
const player = {
  play: () => {},
  pause: () => {},
  seekTo: () => {},
  remove: () => {},
  replace: () => {},
  currentTime: 0,
  duration: 0,
  playing: false,
  muted: false,
  loop: false,
  volume: 1,
  playbackRate: 1,
};
module.exports = {
  createAudioPlayer: () => player,
  useAudioPlayer: () => player,
  useAudioPlayerStatus: () => ({
    playing: false,
    currentTime: 0,
    duration: 0,
    isBuffering: false,
    isLoaded: false,
    didJustFinish: false,
  }),
  useAudioRecorder: () => ({
    record: () => {},
    stop: () => {},
    pause: () => {},
    getStatus: () => ({ isRecording: false }),
  }),
  useAudioRecorderState: () => ({ isRecording: false, durationMillis: 0, url: null }),
  setAudioModeAsync: () => Promise.resolve(),
  requestNotificationPermissionsAsync: () => Promise.resolve({ status: "denied" }),
  requestRecordingPermissionsAsync: () => Promise.resolve({ status: "denied" }),
  RecordingPresets: {},
  AudioModule: {},
};
