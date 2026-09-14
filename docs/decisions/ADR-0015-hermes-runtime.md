# ADR-0015: Hermes Runtime for React Native Applications

## Status

Accepted and in progress.

## Decision

SevynOS React Native application packages carry optimized Hermes bytecode beside
their JavaScript compatibility bundle. The bytecode file uses the convention
`<manifest entrypoint>.hbc` and is covered by the package SHA-256 integrity
record.

The Linux application host embeds the Hermes VM and JSI directly. It
provide only bounded SevynOS host functions for rendering, lifecycle, timers,
and brokered services. Node.js globals and filesystem access are not part of the
application environment. V8 remains available to the Electron development host;
the Linux Wayland host uses Hermes for isolated applications.

Electron development workers may continue using Chromium V8 for Fast Refresh.
Release compatibility must also be tested against Hermes bytecode because V8
execution does not prove device compatibility.

## Required completion gates

1. The Linux image contains an embedded Hermes VM whose bytecode version matches
   the packaged compiler.
2. AppRegistry registration, rendering, input, timers, promises, lifecycle, and
   brokered services execute inside Hermes.
3. Invalid or incompatible bytecode fails closed with a structured diagnostic.
4. The same public React Native application suite passes on Hermes and the
   Electron development host.
5. Hermes inspector support is available only in explicitly enabled development
   builds.

## Consequences

Package size increases while both JavaScript and bytecode are shipped. Once the
Hermes host reaches parity, production packages may omit JavaScript source while
development packages retain it for diagnostics and fallback execution.

## Implemented foundation

- The package compiler and Linux VM are pinned to Hermes `250829098.0.10`.
- The CLI emits optimized HBC and includes it in package integrity metadata.
- The Linux image builds and installs a native `sevyn-hermes-host` executable.
- The host executes HBC directly through `facebook::hermes::makeHermesRuntime()`.
- Native JSI functions provide engine discovery and a newline-framed JSON
  channel with a 256 KiB limit in each direction.
- A real Linux smoke program verifies bytecode evaluation and a host-to-Hermes-
  to-host bridge round trip.
- The Linux executor routes renderer surfaces, input, lifecycle, timers,
  microtasks, service requests and shutdown through the Hermes transport.

The remaining completion gates concern React Native renderer and service parity;
they do not block using the VM and JSI transport as the next executor foundation.
