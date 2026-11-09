// Empty module: a deep react-native core-setup path that must not run
// on the SevynOS host (it assumes a native bridge). Imported for its
// side effects on real RN; on SevynOS those side effects are the
// shim's job.
"use strict";
module.exports = {};
