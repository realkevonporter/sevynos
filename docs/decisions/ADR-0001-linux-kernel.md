# ADR-0001: Use the Linux Kernel

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

SevynOS requires a stable low-level foundation capable of managing:

* processes
* memory
* filesystems
* networking
* hardware drivers
* power management
* device input and output
* security primitives
* multiple processor architectures

Writing a new kernel would require substantial engineering effort before SevynOS could begin developing the areas that distinguish the platform.

The primary innovation of SevynOS is not intended to be its kernel. The project is focused on creating:

* a React Native-first application platform
* a TypeScript-first developer experience
* an open and user-controlled computing environment
* a consistent runtime across device categories
* a polished cross-device shell
* a stable SevynOS SDK

The project therefore needs a proven kernel that allows development to begin at the runtime, services, shell, and application layers.

## Decision

SevynOS will use the Linux kernel as its foundational kernel.

The project will not initially maintain a custom Linux kernel fork.

During early development, SevynOS may run on top of an existing Linux distribution or minimal Linux environment. This development environment is temporary infrastructure and should not define the public identity or long-term application model of SevynOS.

Applications will target SevynOS APIs rather than directly targeting Linux-specific interfaces.

Linux will provide the underlying operating-system primitives, while the Sevyn Runtime, system services, SDK, shell, security model, application lifecycle, and package model will define the SevynOS platform.

## Rationale

### Proven foundation

Linux is a mature, widely deployed kernel used across:

* servers
* desktops
* mobile devices
* televisions
* vehicles
* embedded systems
* networking equipment
* development boards
* supercomputers

Using Linux allows SevynOS to build on decades of engineering, testing, security work, and production deployment.

### Hardware support

Linux supports a broad range of processor architectures and hardware categories.

Potential SevynOS targets include:

* x86-64 desktop and laptop computers
* ARM64 development boards
* tablets
* mobile devices
* embedded devices
* televisions
* automotive systems
* wearable devices

Not every device will work automatically. Hardware vendors may still require proprietary firmware, drivers, or board-support packages. However, Linux gives SevynOS a significantly stronger starting point than a new kernel would provide.

### Existing ecosystem

Linux provides access to established components for:

* graphics
* audio
* networking
* Bluetooth
* USB
* filesystems
* encryption
* containers
* process isolation
* device management
* power management

SevynOS can evaluate and reuse these components rather than recreating them without a clear platform benefit.

### Open development

The Linux kernel's open development model aligns with Project Sevyn's commitment to transparency, user ownership, and community participation.

SevynOS can inspect, modify, build, and redistribute the kernel subject to its licensing obligations.

### Engineering focus

Using Linux allows Project Sevyn to direct its limited early resources toward the parts of the platform that users and developers will directly experience.

These include:

* Sevyn Runtime
* Sevyn Shell
* Sevyn SDK
* React Native platform support
* developer tooling
* application packaging
* permissions
* system services
* cross-device continuity

## Architectural Boundaries

The Linux kernel is part of the SevynOS architecture, but Linux itself is not the developer-facing platform.

The intended boundary is:

```text
Applications
    │
SevynOS SDK
    │
React Native Platform Layer
    │
Sevyn Runtime
    │
System Services
    │
Linux System Interfaces
    │
Linux Kernel
    │
Hardware
```

Third-party applications should not require direct access to kernel interfaces for ordinary application behavior.

Direct low-level access may be permitted for:

* trusted system services
* device drivers
* approved native extensions
* developer tools
* explicitly authorized advanced applications
* user-enabled unrestricted development environments

These capabilities must remain under the device owner's control.

## Consequences

### Positive consequences

* SevynOS can begin development without creating a kernel.
* The project gains access to extensive hardware and driver support.
* The platform can initially target common desktop and ARM hardware.
* Existing Linux debugging and development tools can be used.
* The project can reuse mature system components.
* Contributors can work from established documentation and tooling.
* The architecture can support multiple device categories over time.
* More engineering effort can be invested in the SevynOS-specific platform layers.

### Negative consequences

* SevynOS will inherit some Linux architectural constraints.
* Hardware support may still depend on proprietary vendor components.
* Kernel and userspace licensing obligations must be understood and respected.
* Some Linux components may not fit the long-term SevynOS architecture.
* Supporting many hardware configurations may create significant testing complexity.
* The project may need to maintain selected kernel configurations or patches later.
* Linux terminology and implementation details could leak into the developer experience unless platform boundaries are carefully maintained.

### Risks

The largest architectural risk is that SevynOS becomes a customized Linux desktop environment rather than a distinct computing platform.

To reduce this risk:

* applications must target SevynOS APIs
* the Runtime must own the application lifecycle
* system capabilities must be exposed through SevynOS services
* the Shell must remain separate from the Runtime
* public documentation must describe SevynOS concepts rather than requiring Linux knowledge
* Linux-specific dependencies must not become part of the public SDK without deliberate review

## Alternatives Considered

### Build a custom kernel

A custom kernel would provide complete architectural control.

It was rejected for the initial project because it would require major work in:

* scheduling
* memory management
* device drivers
* networking
* filesystems
* security
* power management
* hardware initialization
* debugging infrastructure

This work would delay the React Native platform, shell, runtime, SDK, and developer experience.

A custom kernel may be explored as a research project in the future, but it is not required to achieve the current SevynOS vision.

### Use a BSD kernel

BSD systems offer mature kernels, permissive licensing, and strong networking foundations.

They were not selected because Linux currently provides broader hardware support, a larger device ecosystem, and a stronger foundation for the wide range of devices SevynOS intends to explore.

### Use the Android kernel and platform stack

Android uses the Linux kernel and provides a mature mobile hardware stack.

The complete Android platform was not selected as the architectural foundation because SevynOS does not want its runtime, application model, SDK, shell, permissions, and system services to be defined by Android.

Selected Android technologies may still be researched where they provide clear value, especially for future mobile hardware enablement.

### Use an existing Linux distribution as SevynOS

An existing distribution could accelerate the first desktop prototype.

A distribution may be used as a development host, but it will not define the long-term SevynOS platform.

The goal is not to reskin or rebrand an existing Linux desktop. SevynOS must establish its own runtime, application model, SDK, system services, and user experience.

### Use a microkernel

A microkernel could provide stronger isolation and a smaller trusted computing base.

It was not selected because it would substantially increase early implementation complexity and reduce immediate access to the Linux hardware ecosystem.

Microkernel concepts may still influence the design of SevynOS services and process isolation.

## Licensing Considerations

The Linux kernel is licensed under the GNU General Public License version 2.

Project Sevyn must comply with all applicable licensing obligations when distributing:

* kernel binaries
* modified kernel source code
* kernel modules
* derivative kernel components

The Linux kernel license does not require every SevynOS component to use the same license.

Userspace services, SDK packages, applications, shell components, developer tools, and other independently developed components may use licenses selected by Project Sevyn, subject to the licenses of any dependencies they include.

A separate licensing review should be completed before SevynOS distributes system images publicly.

## Implementation Guidance

During the Genesis prototype, SevynOS should:

1. Use a supported Linux development environment.
2. Avoid modifying the kernel unless absolutely necessary.
3. Target one hardware architecture initially.
4. Access system functionality through small, defined service interfaces.
5. Prevent Linux implementation details from leaking into the public SDK.
6. Document every direct Linux dependency.
7. Keep the Runtime portable enough to support different Linux environments.
8. Evaluate long-term system components only after prototype requirements are understood.

## Initial Target

The initial development target should be:

* desktop-class hardware
* x86-64 or ARM64
* a Linux development environment
* a Wayland-capable graphics stack
* one known and documented machine configuration

The exact distribution and hardware target will be decided in a separate ADR.

## Validation Criteria

This decision will be validated when:

1. The SevynOS prototype runs on Linux.
2. The Sevyn Shell starts without requiring a custom kernel.
3. The Runtime launches a React Native application.
4. The application accesses a system capability through the SevynOS SDK.
5. The application does not require direct knowledge of the Linux environment.
6. The same high-level architecture appears viable for an ARM64 development board.

## Revisit Conditions

This decision should be reconsidered if:

* Linux prevents a critical SevynOS platform requirement
* licensing obligations become incompatible with the project
* required hardware cannot be supported
* the platform requires security properties Linux cannot reasonably provide
* another kernel provides a clearly superior path
* Project Sevyn eventually has the resources and technical reason to build a new kernel

Reconsidering this decision does not imply that a custom kernel is necessary. Any replacement must demonstrate meaningful benefits that justify the migration cost.

## Final Position

SevynOS will use the Linux kernel because it provides the strongest practical foundation for an open, cross-device operating system platform.

Project Sevyn will build its innovation above the kernel.

Linux will manage the machine.

SevynOS will define the experience.
