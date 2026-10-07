# SevynOS Recovery Procedure (Non-Linux Appliance Workflow)

## Overview

SevynOS does not use traditional Linux TTY fallbacks, root rescue prompts, or single-user runlevels for disaster recovery. Because SevynOS is an appliance operating system, all recovery and maintenance operations are conducted strictly through SevynOS interfaces.

This guide details the procedures for recovering a non-booting or corrupted SevynOS system, repairing damaged applications, and reinstalling core components without ever dropping into a Linux shell.

---

## 1. Boot-Level Recovery Options

If the graphical desktop fails to start due to GPU driver incompatibility or display connector misconfiguration:

1. **Reboot the device** and access the boot menu:
   - On UEFI/BIOS machines, power on and hold `Esc` or `F12` if needed to access the GRUB menu.
2. **Select Safe Graphics Mode**:
   - Choose: **"Start SevynOS Live (safe graphics / software)"**
   - This boots the system with `nomodeset` and `sevyn.gpu=0`, utilizing the high-speed CPU Pixman software rasterizer instead of hardware DRM/EGL drivers.
3. **Select Diagnostic Logging Mode**:
   - If troubleshooting kernel devices or early hardware initialization, select **"Start SevynOS Live (diagnostic logging)"** to enable verbose boot reporting directly on screen.

### The SevynOS Recovery environment

On installed systems the GRUB menu also offers **"SevynOS Recovery"** —
a self-contained repair environment that boots without the installed
system (on UEFI machines it loads from the ESP, so even a destroyed root
partition cannot stop it). It is menu-driven and never drops to a shell.
From it you can:

- **Roll back to the previous OS update** (restores the pre-update system
  snapshot; your files and accounts are kept),
- **Reinstall SevynOS from install media** (pristine system files; your
  files are kept),
- **Factory reset** (erase all user data, keep the OS),
- **Check disks for errors**, **view system logs**, and reboot/power off.

See `docs/recovery.md` for the full design, the rollback contract, and
the exact semantics of each operation.

---

## 2. In-Session System Diagnostics: `sevyn doctor`

Once the desktop or Terminal surface is accessible, run the automated SevynOS system integrity diagnostics:

```bash
sevynos:/var/lib/sevynos$ sevyn doctor
```

The doctor utility audits:

- **Genesis Window Server**: Confirms Wayland connection, surface presentation, and EGL status.
- **Render Protocol**: Verifies protocol version alignment across compositor, framework, and decoders.
- **App Sandbox Boundary**: Confirms isolation of guest worker processes and Hermes bytecode runtime.
- **Console Security**: Validates that virtual console switching (`VT_LOCKSWITCH`) is active.
- **Kernel Integrity**: Checks that Magic SysRq is disabled.
- **Installed Packages**: Verifies application registry integrity.
- **Pristine Recovery Store**: Confirms pristine packages are intact in `/usr/share/sevyn/pristine/`.

---

## 3. Restoring Damaged or Uninstalled System Applications

SevynOS maintains an immutable pristine store of all stock and system packages located at `/usr/share/sevyn/pristine/`.

### Viewing Application Status

```bash
sevynos:/var/lib/sevynos$ sevyn list
```

Displays all currently installed applications, version numbers, system protection status, and granted permissions.

### Restoring Stock Applications

If a user uninstalled a stock application (e.g., Browser, Notes, Music, Camera) or if an application file is corrupted:

```bash
sevynos:/var/lib/sevynos$ sevyn restore org.sevynos.browser
```

Output:

```
✓ Successfully restored Browser (org.sevynos.browser v1.0.0) from pristine storage.
```

### Reinstalling Core Desktop Components

If the Desktop Shell or Settings experience issues, restore the pristine package:

```bash
sevynos:/var/lib/sevynos$ sevyn restore org.sevynos.shell
```

This reloads the verified stock package without affecting user data in `/var/lib/sevynos`.

---

## 4. Sideloading and Installing Applications

To install an updated `.sevyn` application bundle:

```bash
sevynos:/var/lib/sevynos$ sevyn install /var/lib/sevynos/Downloads/update.sevyn
```

Output:

```
✓ Successfully installed My App (org.example.myapp v1.1.0) [deletable]
```

To remove a faulty user-installed application:

```bash
sevynos:/var/lib/sevynos$ sevyn uninstall org.example.myapp
```

Note: Core protected system applications (`org.sevynos.shell`, `org.sevynos.terminal`) are protected against accidental removal.

---

## 5. Genesis Native Recovery Surface

In the rare event that the window manager experiences an unrecoverable rendering crash:

1. The Genesis host activates the native `DesktopRecoveryController`.
2. The display presents the SevynOS Recovery Screen:
   - Displays failure error reason.
   - Offers two options:
     - **Restart Desktop**: Reinitializes the compositor surface while preserving background services.
     - **Reboot System**: Performs an orderly sync and system restart into safe graphics.
3. No raw Linux console or bash shell is ever displayed.
