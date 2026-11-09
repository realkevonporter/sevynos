// SevynOS M6 — expo-media-library stub. Empty library.
module.exports = {
  getPermissionsAsync: () =>
    Promise.resolve({ status: "undetermined", canAskAgain: true }),
  requestPermissionsAsync: () =>
    Promise.resolve({ status: "denied", canAskAgain: false }),
  getAssetsAsync: () =>
    Promise.resolve({ assets: [], totalCount: 0, endCursor: "", hasNextPage: false }),
  getAssetInfoAsync: () => Promise.resolve(null),
  createAssetAsync: () => Promise.resolve(null),
  saveToLibraryAsync: () => Promise.resolve(),
  createAlbumAsync: () => Promise.resolve(null),
  getAlbumsAsync: () => Promise.resolve([]),
  deleteAssetsAsync: () => Promise.resolve(true),
  MediaType: { audio: "audio", photo: "photo", video: "video", unknown: "unknown" },
  SortBy: {
    creationTime: "creationTime",
    modificationTime: "modificationTime",
    mediaType: "mediaType",
    width: "width",
    height: "height",
    duration: "duration",
  },
};
