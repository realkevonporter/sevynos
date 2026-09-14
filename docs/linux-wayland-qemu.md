# Genesis native Linux, Wayland, and QEMU

The Linux host reuses the desktop-independent Genesis runtime, scene composer,
display planner, frame executor, React applications, settings, workspaces, and
lifecycle coordinator. Electron is not imported by `hosts/linux`.

## Native Wayland boundary

`hosts/linux/src/native-ipc-protocol.ts` defines protocol version 1. Input,
clipboard, lifecycle, and display control messages use bounded newline-delimited
JSON with monotonic sequence numbers. Frames use a separate inherited binary
pipe with a fixed header, display/trace IDs, damage regions, and exact RGBA8888
bytes. Multi-megabyte pixels never enter JSON, and native handles never cross
the boundary.

The Rust bridge owns the real Wayland objects: display connection and registry,
compositor, XDG toplevel, shared-memory buffers, frame callbacks, output, seat,
pointer, and XKB-backed keyboard. It converts RGBA into Wayland ARGB byte order,
uses a released-buffer fallback for double buffering, and acknowledges a frame
only after attaching and committing it.

The TypeScript presentation scheduler permits one submitted frame and one dirty
latest-state replacement. Synchronous focus/z-order notifications are coalesced,
stale pending binary frames are replaced, and pointer motion is reduced to the
latest event per visual update. Framebuffer storage is pooled and released only
after the binary writer no longer owns it.

Run the reproducible Linux build and real headless-compositor smoke test with:

```sh
pnpm --filter @sevynos/linux-host native:docker:test
```

The smoke test starts Weston, waits for an XDG configure, submits an exact RGBA
frame, observes `frame-presented`, and performs controlled shutdown.

## Live USB and QEMU development image

`pnpm usb:build` creates `tools/qemu/build/sevynos-live.iso`, a hybrid x86-64
BIOS/UEFI image suitable for optical media or a USB flash drive. The kernel and
complete SevynOS userspace load from the image into memory. An internal HDD or
SSD is not required, read, formatted, or mounted during startup.

Write `sevynos-live.iso` to a USB drive with a raw-image tool such as Raspberry
Pi Imager, balenaEtcher, GNOME Disks, or Rufus, then select that drive from the
computer's firmware boot menu. Writing an image erases the selected USB drive,
so verify the destination in the imaging tool before starting. Secure Boot is
not supported yet and must be disabled. The current live image targets x86-64
PCs and includes BIOS and x86-64 UEFI boot loaders.

The default session is intentionally volatile. A separate ext4 volume explicitly
labeled `SEVYN_DATA` can provide persistence, but it is optional. SevynOS never
probes or mounts an unlabeled internal disk as its data volume.

`pnpm usb:run` boots the exact ISO in a visible QEMU window without attaching a
hard disk. `pnpm usb:smoke` performs the same no-disk boot unattended and succeeds
only after the live-root marker, volatile-storage marker, and first Genesis frame
are observed.

If older live media reports `error: no suitable video mode found`, rebuild and
rewrite the USB. Current media no longer asks GRUB to preserve an unsupported
firmware graphics mode: legacy BIOS boots hand Linux a text console, while UEFI
boots let Linux select from the firmware framebuffer and native DRM modes.

`pnpm qemu:build` produces the same live ISO plus an immutable x86-64 kernel and
initramfs pair and a separate 512 MiB ext4 `data.img` for VM development. The data
image stores desktop settings, restored sessions, window/workspace state, and
isolated application storage across VM boots. A missing or damaged data filesystem
puts the guest in explicit tmpfs mode instead of preventing Genesis from starting.

`pnpm qemu:run` requires a local QEMU installation and opens the graphical VM
with virtio GPU, USB keyboard/tablet input, a QMP socket, serial logging at
`tools/qemu/build/serial.log`, and persistent storage. Weston uses its DRM backend,
pixman renderer, and kiosk shell; the fullscreen Genesis surface is the only
user-facing shell. Local QEMU runs use Apple's HVF hardware virtualization
automatically on Intel Macs; explicit accelerator arguments remain unchanged.

`pnpm qemu:headless` retains the deterministic Weston headless backend and can
use the containerized QEMU fallback. `pnpm qemu:input:test` starts the graphical
guest without a host display and uses QMP to inject real USB tablet and keyboard
events, then requires native/TypeScript input-path markers.

Run the repeatable local 20-click focus benchmark with:

```sh
pnpm --filter @sevynos/linux-host benchmark:focus
```

After building the guest, `pnpm qemu:focus:test` performs the same alternating
focus benchmark through QMP at 1280×720 and reports min, median, p95, maximum,
raster, and native-copy durations. Set `SEVYN_QEMU_FOCUS_TRACE=1` when using
`pnpm qemu:run` to enable the gated per-stage trace in a visible guest.

Use `pnpm qemu:stop` to send an ACPI power-button event through QMP. The guest
then blocks launches, terminates isolated processes, flushes persistence, stops
graphics and the Wayland bridge, and powers off. Closing QEMU forcibly should be
reserved for a guest that no longer responds.

The automated smoke requires both of these guest serial markers:

```text
SEVYN_QEMU_KERNEL_BOOTED
SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED
```

The second marker is emitted only after Weston starts inside the guest, creates
the Wayland socket, configures the Genesis XDG toplevel, accepts a real `wl_shm`
RGBA frame, and the bridge shuts down cleanly.

The live desktop includes the SevynOS installer. The automated installer smoke
partitions blank virtual disks, copies the system, installs the bootloader, and
boots the installed result under both BIOS and UEFI. The current installer is a
functional text workflow launched from the desktop; a fully graphical,
hardware-guided installer remains planned.

Hardware support is limited to what the bundled Linux kernel, firmware, udev,
and Weston DRM backend recognize. Wi-Fi, touch, camera, audio routing, suspend,
and GPU behavior still require broader physical-device coverage. Weston remains
the system compositor; Genesis does not yet replace it with a standalone DRM/KMS
compositor.
