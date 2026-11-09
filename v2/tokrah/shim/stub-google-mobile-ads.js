const React = require("react");
// SevynOS M6 — react-native-google-mobile-ads stub. Ads never load.
function BannerAd(props) {
  return React.createElement("View", { style: props && props.style });
}
const makeAd = () => ({
  load: () => {},
  show: () => Promise.resolve(),
  addAdEventListener: () => () => {},
});
// The package's default export is a function returning the MobileAds
// singleton (ads.init calls MobileAds().setRequestConfiguration).
const MobileAds = () => ({
  setRequestConfiguration: () => Promise.resolve(),
  initialize: () => Promise.resolve(),
});
module.exports = {
  BannerAd,
  MobileAds,
  default: MobileAds,
  MaxAdContentRating: { G: "G", PG: "PG", T: "T", MA: "MA" },
  InterstitialAd: { createForAdRequest: () => makeAd() },
  RewardedAd: { createForAdRequest: () => makeAd() },
  RewardedInterstitialAd: { createForAdRequest: () => makeAd() },
  AppOpenAd: { createForAdRequest: () => makeAd() },
  TestIds: {
    BANNER: "ca-app-pub-test/banner",
    INTERSTITIAL: "ca-app-pub-test/interstitial",
    REWARDED: "ca-app-pub-test/rewarded",
  },
  AdEventType: {
    LOADED: "loaded",
    ERROR: "error",
    OPENED: "opened",
    CLICKED: "clicked",
    CLOSED: "closed",
  },
  BannerAdSize: {
    BANNER: "BANNER",
    LARGE_BANNER: "LARGE_BANNER",
    MEDIUM_RECTANGLE: "MEDIUM_RECTANGLE",
    FULL_BANNER: "FULL_BANNER",
    LEADERBOARD: "LEADERBOARD",
    ANCHORED_ADAPTIVE_BANNER: "ANCHORED_ADAPTIVE_BANNER",
  },
};

// Mark as an ES module (the real package is ESM with a default
// export): without this, Babel wraps the stub as { default: exports }
// and `X.default` resolves to the exports object, not the default.
Object.defineProperty(module.exports, "__esModule", { value: true });
