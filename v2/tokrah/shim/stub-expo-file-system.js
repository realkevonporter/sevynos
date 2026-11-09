const React = require("react");
// SevynOS M6 — expo-file-system stub. A tmp-only filesystem: reads
// report missing, writes resolve into the void. No persistence in M6.
const ok = () => Promise.resolve();
module.exports = {
  documentDirectory: "/tmp/",
  cacheDirectory: "/tmp/",
  bundleDirectory: null,
  getInfoAsync: () =>
    Promise.resolve({
      exists: false,
      isDirectory: false,
      uri: "",
      size: 0,
      modificationTime: 0,
    }),
  readAsStringAsync: () => Promise.resolve(""),
  writeAsStringAsync: ok,
  deleteAsync: ok,
  moveAsync: ok,
  copyAsync: ok,
  makeDirectoryAsync: ok,
  readDirectoryAsync: () => Promise.resolve([]),
  downloadAsync: (uri) =>
    Promise.resolve({ uri: uri || "", status: 200, headers: {}, md5: "" }),
  getContentUriAsync: (uri) => Promise.resolve(uri || ""),
  getFreeDiskStorageAsync: () => Promise.resolve(0),
  getTotalDiskCapacityAsync: () => Promise.resolve(0),
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  // The new File API (expo-file-system/legacy is the old string API):
  // `new File(uri)` with async/sync read/write. The app persists the
  // saved-user file through it; the stub keeps one in-memory file per
  // uri so a write followed by a read round-trips within a session.
  File: class {
    static _store = new Map();
    constructor(uri) {
      this.uri = uri;
    }
    get exists() {
      // Named class expression would be needed for `File._store`
      // (the anonymous class has no in-scope name; the global File
      // has no _store). Use the constructor instead.
      return this.constructor._store.has(this.uri);
    }
    async write(data) {
      this.constructor._store.set(this.uri, String(data));
    }
    writeSync(data) {
      this.constructor._store.set(this.uri, String(data));
    }
    async create() {
      if (!this.constructor._store.has(this.uri))
        this.constructor._store.set(this.uri, "");
    }
    createSync() {
      if (!this.constructor._store.has(this.uri))
        this.constructor._store.set(this.uri, "");
    }
    async read() {
      return this.constructor._store.get(this.uri) || "";
    }
    readSync() {
      return this.constructor._store.get(this.uri) || "";
    }
    async delete() {
      this.constructor._store.delete(this.uri);
    }
    async info() {
      const data = this.constructor._store.get(this.uri);
      return {
        exists: data != null,
        isDirectory: false,
        uri: this.uri,
        size: data ? data.length : 0,
        modificationTime: 0,
      };
    }
  },
  Paths: { document: "/tmp/", cache: "/tmp/", bundle: null },
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
};
