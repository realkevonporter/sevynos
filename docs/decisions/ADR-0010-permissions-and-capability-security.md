# ADR-0010: Permissions and Capability Security

**Status:** Accepted
**Date:** July 26, 2026
**Applies to:** SevynOS runtime, hosts, frameworks, services, and applications

## Context

Applications need controlled access to files, devices, notifications, network
resources, and other operating-system services. Trusting an application merely
because it can reach an internal module would make host implementations and
framework choice part of the security boundary.

## Decision

The runtime is the authority for application identity and permission policy.
Applications receive explicit capabilities scoped to an application session.
Access is denied unless the capability is granted, and a host must not provide
an alternate path around runtime policy.

Capabilities are least-privilege, revocable, attributable to an application
identity, and safe to audit. Framework APIs request capabilities through public
contracts; trusted hosts translate approved operations to platform mechanisms.
System applications use the same public capability path unless a documented
security boundary requires a privileged service.

Persisted permission decisions must be versioned and validated before use.
Malformed, unknown, or stale decisions fail closed. Sensitive grants require a
user-visible explanation and remain revocable.

## Consequences

- Runtime policy remains independent of Electron, Linux, React Native, and
  future hosts.
- Services validate caller identity and capability on every protected request.
- Tests must cover denial, revocation, malformed state, and host-bypass cases.
- New privileged APIs require an architecture and threat-model review.
