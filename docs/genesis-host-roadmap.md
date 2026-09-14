# Genesis host roadmap

The Genesis desktop has one host-independent execution boundary:

`Runtime -> desktop shell -> scene composition -> display planning -> frame execution -> host presenter`

## Current hosts

1. **Electron** provides the fastest development loop, isolated application
   workers, persistence, desktop packaging, and targeted application reload.
2. **Headless Linux** runs the same runtime and scene composer with deterministic
   display, input, persistence, and frame logging for tests.
3. **Native Linux/Wayland** uses a Rust client for the Wayland registry, XDG
   toplevel, shared-memory buffers, output, seat, keyboard, pointer, clipboard,
   frame callbacks, and controlled shutdown. TypeScript owns Genesis state and
   raster composition; binary frames cross a bounded dedicated pipe.
4. **Bootable x86-64 SevynOS** combines Linux, initramfs/live-boot, firmware,
   Weston, Genesis, system applications, optional persistence, and the installer
   in hybrid BIOS/UEFI media.

These are implemented paths, not placeholder interfaces. Automated gates cover
native Wayland presentation, Linux services, no-disk live boot, guest keyboard
and pointer input, focus latency, and installation/boot under BIOS and UEFI.

## Next host milestones

- physical-device qualification profiles and automated hardware reports;
- broader DRM/GPU acceleration with reliable software fallback;
- libinput/touch/gesture depth and complete IME/text input;
- AT-SPI semantics and assistive-technology testing;
- production sandboxing for isolated applications;
- a graphical installer and signed update/recovery environment;
- additional device shells without duplicating runtime or platform services.

Weston is intentionally retained as the compositor today. Replacing it with a
standalone Genesis DRM/KMS compositor would be a separate architecture decision,
not an incremental cleanup.
