// SevynOS M6 — expo-iap stub. No store on the host.
module.exports = {
  getProductsAsync: () => Promise.resolve([]),
  requestPurchaseAsync: () => Promise.reject(new Error("IAP unavailable on SevynOS")),
  finishTransactionAsync: () => Promise.resolve(),
  getPurchaseHistoryAsync: () => Promise.resolve([]),
  connectAsync: () => Promise.resolve(),
  disconnectAsync: () => Promise.resolve(),
};
