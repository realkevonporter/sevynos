// SevynOS M6 — expo-image-picker stub. Picker always cancels.
module.exports = {
  launchImageLibraryAsync: () => Promise.resolve({ canceled: true, assets: [] }),
  launchCameraAsync: () => Promise.resolve({ canceled: true, assets: [] }),
  requestMediaLibraryPermissionsAsync: () =>
    Promise.resolve({ status: "denied", canAskAgain: false }),
  getMediaLibraryPermissionsAsync: () =>
    Promise.resolve({ status: "undetermined", canAskAgain: true }),
  requestCameraPermissionsAsync: () =>
    Promise.resolve({ status: "denied", canAskAgain: false }),
  MediaTypeOptions: { All: "All", Videos: "Videos", Images: "Images" },
  MediaType: { Images: "images", Videos: "videos", All: "all" },
  ImagePickerAsset: {},
};
