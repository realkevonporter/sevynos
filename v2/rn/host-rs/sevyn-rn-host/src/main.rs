// SevynOS v2 — the RN host, in Rust.
//
// Phase 0 stub: the binary exists so the toolchain (rustup, pinned
// 1.100.0) and the cargo workspace are proven in CI. It does nothing
// yet — the C++ host (v2/rn/host/sevyn-rn-host.cc) still ships, and
// the Rust host's logic arrives in Phases 1–3 (leaves, JSI shim, core)
// with the cutover in Phase 5.
//
// See the scope doc (~/workspace/sevynos-rust-host/SCOPE.md).

fn main() {
    // Not wired up yet; exit cleanly so `cargo build` proves the
    // toolchain, not the program.
}
