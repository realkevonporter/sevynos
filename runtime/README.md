# Sevyn Runtime

The Sevyn Runtime is the authoritative policy and application-management
component of SevynOS.

## Responsibilities

- Application discovery
- Application sessions
- Application lifecycle
- IPC identity
- Service registry
- Permission policy
- Capability issuance
- Framework-host coordination

## Architectural Boundary

The Runtime must remain independent of application frameworks.

Runtime source code must not import React Native, Wayland compositor, Shell,
or application implementation packages.

Framework-specific behavior belongs in `hosts/`.

## Current Genesis State

The initial implementation provides:

- Runtime process startup
- Runtime lifecycle validation
- Structured logging
- Graceful signal handling

Application lifecycle management will be added next.
