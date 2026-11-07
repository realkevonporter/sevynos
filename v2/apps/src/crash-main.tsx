// SevynOS v2 M3 — the crash app (test fixture, not a stock app).
//
// Throws during evaluation so the host exits 1 and appd reports APP
// CRASHED. The shell must keep running: the sandbox holds. The
// harness installs this bundle from /usr/share/sevyn/test-bundles/.

throw new Error("crash-app: intentional startup failure");
