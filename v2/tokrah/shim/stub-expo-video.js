const React = require("react");
// SevynOS M6 — expo-video stub. Video is a dark placeholder rect;
// the player reports not-playing, zero duration.
function VideoView(props) {
  return React.createElement(
    "View",
    { style: [{ backgroundColor: "#000000" }, props && props.style] },
    props && props.children,
  );
}
const player = {
  play: () => {},
  pause: () => {},
  seekTo: () => {},
  replace: () => {},
  remove: () => {},
  currentTime: 0,
  duration: 0,
  playing: false,
  muted: false,
  loop: false,
  playbackRate: 1,
  volume: 1,
};
module.exports = {
  VideoView,
  useVideoPlayer: () => player,
  useVideoPlayerStatus: () => ({
    playing: false,
    currentTime: 0,
    duration: 0,
    isBuffering: false,
    isLoaded: false,
    didJustFinish: false,
    error: null,
  }),
};
