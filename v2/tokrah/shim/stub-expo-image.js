// SevynOS M6 — expo-image stub.
// The v2 renderer paints local PNGs; remote images (Tokrah's CDN
// URLs) have no fetch path in the host yet, so they render as a
// tinted placeholder rect with the same layout. Local Metro assets
// (require('./x.png') -> asset id) render through the host Image.
const React = require("react");

function ExpoImage(props) {
  const source = props && props.source;
  const uri = source && typeof source === "object" ? source.uri : null;
  if (typeof source === "number" || (uri && uri.startsWith("asset:"))) {
    return React.createElement("Image", props);
  }
  return React.createElement("View", {
    style: [{ backgroundColor: "#e5e7eb" }, props && props.style],
  });
}
ExpoImage.prefetch = () => Promise.resolve(true);
ExpoImage.clearMemoryCache = () => Promise.resolve(true);
ExpoImage.clearDiskCache = () => Promise.resolve(true);
ExpoImage.loadAsync = () => Promise.resolve();
module.exports = { Image: ExpoImage, default: ExpoImage };

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
