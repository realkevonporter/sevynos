// SevynOS M6 — expo-document-picker stub. Picker always cancels.
module.exports = {
  getDocumentAsync: () => Promise.resolve({ canceled: true, assets: [] }),
  types: {
    all: "*/*",
    images: "image/*",
    audio: "audio/*",
    video: "video/*",
    pdf: "application/pdf",
  },
};
