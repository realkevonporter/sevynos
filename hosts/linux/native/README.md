# SevynOS Wayland bridge

The native bridge is a narrow, versioned NDJSON boundary. The current bridge owns
display negotiation, frame acknowledgements, and clipboard state; Genesis receives
plain validated data only. Its next Linux-side step is binding these operations to
`wl_surface`, `wl_shm`, and `wl_seat`. Build requirements are Rust 1.82+, a Wayland compositor,
`libwayland-client`, `wayland-protocols`, and `pkg-config`.

Build with `cargo build --manifest-path hosts/linux/native/Cargo.toml --release`.
Set `SEVYN_WAYLAND_BRIDGE` when the binary is installed outside the default target
directory. `WAYLAND_DISPLAY` selects the compositor socket.
