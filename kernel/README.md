# Kernel integration

This directory owns future SevynOS kernel and low-level hardware integration.
The current x86-64 live-boot path uses the Linux kernel and a memory-resident
initramfs, with hybrid BIOS/UEFI USB media assembled under `tools/qemu/`. Host
adapters and userspace Wayland code remain under `hosts/`.
