# ADR-0002: Use TypeScript as the Primary Platform Language

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

SevynOS is intended to provide a modern, accessible, cross-device application platform centered on React Native.

The platform will include:

- a graphical shell
- system applications
- developer tooling
- command-line tools
- an application SDK
- application manifests
- lifecycle APIs
- system-service clients
- development utilities
- package-management tools
- cross-device application interfaces

Project Sevyn needs a primary language that supports rapid development, strong tooling, broad developer familiarity, and close alignment with the React Native ecosystem.

No single programming language is appropriate for every layer of an operating system.

Low-level components such as kernel integration, graphics bindings, process control, hardware access, and security-sensitive services may require native languages.

However, most SevynOS developers should not need to work directly with native system code.

The platform therefore requires a clear language strategy that makes high-level development approachable while preserving native capabilities where necessary.

## Decision

TypeScript will be the primary platform language for SevynOS.

TypeScript should be used by default for:

- the Sevyn Shell
- system applications
- the public SDK
- developer tooling
- command-line tools
- application templates
- package metadata tooling
- application lifecycle APIs
- service client libraries
- test utilities
- build orchestration where practical
- documentation examples
- third-party application development

TypeScript will not be required for components where it is technically unsuitable.

Native languages may be used for:

- Linux integration
- graphics and compositor integration
- device access
- process management
- inter-process communication infrastructure
- performance-critical code
- cryptographic operations
- sandboxing and security enforcement
- React Native platform bindings
- hardware-specific services
- boot and early system initialization

The architectural goal is:

> Use TypeScript wherever it can solve the problem reliably, safely, and efficiently. Use native code where the system requires it, then expose that capability through stable TypeScript interfaces.

## Rationale

### Alignment with React Native

React Native applications are commonly written using JavaScript or TypeScript.

Making TypeScript the primary language creates a consistent development experience across:

- applications
- system applications
- SDK packages
- shell components
- developer tools
- examples
- documentation

A developer familiar with React Native should be able to understand a meaningful portion of the SevynOS codebase without first learning a low-level systems language.

### Strong type system

TypeScript provides static type checking while retaining compatibility with the JavaScript ecosystem.

This can help detect:

- incorrect API usage
- invalid application manifests
- mismatched event payloads
- unsupported device capabilities
- incompatible lifecycle states
- malformed permission requests
- incorrect service responses
- breaking SDK changes

TypeScript does not eliminate runtime errors, but it provides a stronger foundation than untyped JavaScript for a large platform codebase.

### Developer accessibility

A major goal of SevynOS is to lower the barrier to platform development.

TypeScript is widely used by:

- web developers
- React developers
- React Native developers
- Node.js developers
- full-stack developers
- tooling engineers

Using TypeScript allows more developers to contribute to the shell, SDK, system applications, tools, and documentation without requiring expertise in kernel development or native systems programming.

### Development speed

TypeScript supports rapid iteration and has mature tooling for:

- editor integration
- automatic completion
- refactoring
- testing
- formatting
- linting
- package management
- documentation generation
- build systems
- debugging

This is especially valuable during the early SevynOS prototype phase, when the architecture will change frequently.

### Cross-device reuse

TypeScript is well suited to sharing code across:

- desktop
- phone
- tablet
- watch
- television
- embedded interfaces
- development tools
- cloud services

Shared platform logic can remain portable while native components implement device-specific behavior behind stable APIs.

### Public platform identity

TypeScript can become part of the identity of SevynOS.

The intended developer experience is that developers work primarily with:

```ts
import {
  AppLifecycle,
  Device,
  Files,
  Notifications,
  Permissions,
  Storage,
  Windows,
} from "@sevynos/sdk";
```

Developers should not need to understand Linux system calls, native bindings, or hardware implementation details for ordinary application development.

## Language Boundaries

The following model defines the intended language boundary:

```text
┌────────────────────────────────────────────┐
│             TypeScript Layer               │
│                                            │
│ Shell, Apps, SDK, CLI, Tools, Services API │
└──────────────────────┬─────────────────────┘
                       │ Typed Native Boundary
┌──────────────────────▼─────────────────────┐
│              Native Platform               │
│                                            │
│ Runtime Host, Graphics, IPC, Security,     │
│ Linux Integration, Hardware Services       │
└──────────────────────┬─────────────────────┘
                       │
┌──────────────────────▼─────────────────────┐
│                Linux Kernel                │
└────────────────────────────────────────────┘
```

The boundary between TypeScript and native code must be explicit and documented.

TypeScript code should not depend on undocumented native behavior.

Native components should expose:

- typed interfaces
- stable error codes
- validated inputs
- versioned protocols
- predictable lifecycle behavior
- documented security constraints

## Proposed Language Responsibilities

### TypeScript

TypeScript is expected to be used for:

- launcher interface
- desktop workspace
- notification center
- quick settings
- application switcher
- lock-screen interface
- Settings application
- Files application
- Terminal interface
- package-manager interface
- app manifests and validation
- developer CLI
- project scaffolding
- test harnesses
- SDK modules
- application state models
- device-capability APIs
- service clients
- system-event definitions
- extension APIs
- developer documentation examples

### C++

C++ may be used for:

- React Native platform integration
- Fabric renderer integration
- TurboModules
- native component hosting
- Hermes embedding
- graphics bindings
- existing native libraries
- performance-sensitive runtime components

C++ is likely to be necessary because React Native itself includes significant C++ infrastructure.

### Rust

Rust may be considered for:

- security-sensitive services
- IPC infrastructure
- process supervisors
- package validation
- permissions enforcement
- system daemons
- parsers
- networking services
- components where memory safety is especially important

Rust is not required for the initial prototype.

The project should not introduce Rust merely because it is considered a modern systems language. It should be selected only where it provides a clear technical advantage.

### C

C may be used for:

- Linux system interfaces
- compatibility with existing libraries
- small low-level components
- hardware and driver integration
- boot-related code
- APIs where C is the established interface

### Shell scripting

Shell scripts may be used for temporary development automation and environment setup.

Critical build, release, installation, or platform logic should eventually move into tested and maintainable tooling rather than remaining in large shell scripts.

## TypeScript Runtime Strategy

TypeScript does not execute directly.

SevynOS applications and system interfaces will rely on a JavaScript engine and React Native runtime.

Hermes is the initial preferred JavaScript engine because it is designed for React Native and provides:

- bytecode compilation
- optimized startup behavior
- garbage collection
- debugging support
- close integration with React Native
- support across multiple processor architectures

Hermes must receive its own Architecture Decision Record before becoming a permanent platform dependency.

TypeScript source code will typically be transformed into JavaScript before execution.

A possible flow is:

```text
TypeScript Source
       │
       ▼
Type Checking
       │
       ▼
JavaScript Transformation
       │
       ▼
Bundle or Hermes Bytecode
       │
       ▼
SevynOS React Native Host
       │
       ▼
Sevyn Runtime
```

## Public SDK Requirements

All public SevynOS TypeScript APIs should provide:

- strict types
- documented errors
- promise-based asynchronous interfaces where appropriate
- cancellable operations where appropriate
- stable event payloads
- capability detection
- permission-aware behavior
- versioned compatibility
- runtime validation at trust boundaries

Example:

```ts
import { Permissions, PermissionStatus } from "@sevynos/permissions";

const status: PermissionStatus = await Permissions.request("device.camera");

if (status === "granted") {
  // The application may access the camera API.
}
```

Static typing alone must not be treated as a security boundary.

Inputs crossing application, process, package, or native boundaries must also be validated at runtime.

## Coding Standards

SevynOS TypeScript code should initially use:

- TypeScript strict mode
- explicit public API types
- consistent formatting
- automated linting
- unit tests for platform logic
- runtime schema validation at external boundaries
- minimal use of `any`
- documented exceptions when unsafe types are unavoidable
- semantic versioning for public packages

The project should prefer readable code over clever abstractions.

Platform APIs should be designed for clarity and long-term compatibility rather than minimum line count.

## Example Configuration

A future shared TypeScript configuration may resemble:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

The exact configuration will be selected after the initial monorepo and tooling strategy are defined.

## Consequences

### Positive consequences

- React Native developers receive a familiar platform language.
- The shell and system applications can be developed rapidly.
- Application and platform types can be shared.
- SDK documentation can use one primary language.
- Tooling and editor support are mature.
- More developers can contribute to the project.
- Cross-device code reuse becomes easier.
- The public platform can hide low-level implementation complexity.
- System applications can exercise the same SDK offered to third parties.
- Typed interfaces can improve API stability.

### Negative consequences

- TypeScript cannot safely or efficiently implement every system component.
- The platform will require a native interoperability layer.
- JavaScript garbage collection may be unsuitable for hard real-time behavior.
- Startup time and memory usage must be measured carefully.
- Runtime errors remain possible despite static types.
- Native and TypeScript types may drift without code generation or validation.
- Excessive dependency on the JavaScript package ecosystem could introduce supply-chain risk.
- Developers may incorrectly assume TypeScript code is automatically secure because it is typed.
- Multiple languages will still exist within the project.

### Risks

The primary risk is attempting to use TypeScript in layers where it is not appropriate.

This could produce:

- weak security boundaries
- excessive memory usage
- poor startup performance
- unreliable process management
- complex native workarounds
- hidden latency
- fragile system services

To reduce this risk:

- all performance claims must be measured
- security enforcement must occur below untrusted applications
- native services must own privileged operations
- TypeScript should orchestrate rather than directly control unsafe low-level resources
- architectural boundaries must remain explicit
- native code should expose narrow, typed APIs
- system-critical components must not depend on an application-level event loop unless deliberately designed to do so

## Alternatives Considered

### JavaScript without TypeScript

JavaScript would provide similar ecosystem compatibility and faster initial experimentation.

It was rejected as the primary platform language because SevynOS will require stable APIs, long-lived interfaces, refactoring, and collaboration across a large potential codebase.

JavaScript may still be supported as an application language, but Project Sevyn's own platform code should default to TypeScript.

### C++ as the primary language

C++ provides strong performance and direct integration with React Native internals.

It was rejected as the primary high-level platform language because it would significantly increase the contribution barrier and slow development of the shell, SDK, tools, and system applications.

C++ remains an important native implementation language.

### Rust as the primary language

Rust provides strong memory-safety guarantees and modern systems-programming features.

It was not selected as the primary platform language because the public platform is centered on React Native, and requiring Rust for shell and application development would weaken that developer experience.

Rust remains a strong candidate for selected native services.

### Java or Kotlin

Java and Kotlin provide mature tooling and strong Android ecosystems.

They were not selected because SevynOS is not intended to inherit Android's application model, and they do not align as directly with React Native application development as TypeScript does.

### Swift

Swift provides modern language features and is suitable for application and systems development.

It was not selected because its ecosystem remains strongly associated with Apple platforms and does not align as closely with the open cross-platform React Native strategy.

### Dart

Dart supports cross-platform application development and is closely associated with Flutter.

It was not selected because SevynOS is explicitly centered on React Native and the React ecosystem.

## Licensing and Dependency Considerations

TypeScript itself is open source.

However, Project Sevyn must carefully review dependencies used throughout the TypeScript ecosystem.

Platform packages should avoid unnecessary dependencies, especially for:

- permissions
- package validation
- cryptography
- update systems
- application installation
- manifest parsing
- security-sensitive tooling

Dependency selection should consider:

- maintenance activity
- license compatibility
- package ownership
- release history
- known vulnerabilities
- transitive dependency size
- reproducible builds
- ability to vendor or replace the dependency

The public SDK should remain as lightweight as reasonably possible.

## Validation Criteria

This decision will be validated when:

1. The initial shell is implemented primarily in TypeScript.
2. At least one system application is written in TypeScript.
3. A React Native application uses a typed SevynOS SDK package.
4. TypeScript code communicates successfully with a native system service.
5. Lifecycle and system events use shared typed definitions.
6. Strict type checking is enabled across the initial monorepo.
7. The TypeScript layer does not own privileged security enforcement.
8. Performance measurements show acceptable behavior for the first desktop prototype.

## Revisit Conditions

This decision should be reconsidered if:

- TypeScript prevents acceptable shell performance
- React Native changes its primary language or architecture significantly
- the runtime introduces unacceptable memory or startup costs
- critical platform components become overly dependent on unsafe native bridges
- another language provides a significantly better developer experience while maintaining ecosystem compatibility
- TypeScript tooling or governance changes in a way that threatens the project
- cross-device requirements cannot be met reliably

Reconsidering this decision does not require removing TypeScript support from applications. It may instead change which internal platform layers use it.

## Implementation Guidance

During the Genesis prototype, Project Sevyn should:

1. Enable strict TypeScript settings.
2. Use TypeScript for the shell prototype.
3. Define shared types for application manifests.
4. Define shared types for lifecycle events.
5. Create a small typed SDK package.
6. Create one native boundary.
7. Validate all data crossing that boundary.
8. Measure startup time and memory usage.
9. Avoid large frameworks beyond React Native unless clearly justified.
10. Document every component that requires native code.

## Initial Success Target

The first demonstration should include a TypeScript React Native application that:

- launches through the Sevyn Runtime
- renders inside the Sevyn Shell
- receives a typed lifecycle event
- reads typed platform information
- calls one native-backed SevynOS API
- closes cleanly through the Runtime

Example:

```ts
import { AppLifecycle, System } from "@sevynos/sdk";

AppLifecycle.on("foreground", () => {
  console.log("Running on", System.platformName);
});
```

Expected output:

```text
Running on SevynOS
```

## Final Position

TypeScript will be the primary language through which developers experience and contribute to SevynOS.

It will power the shell, SDK, tools, system applications, and most application-facing platform logic.

Native languages will remain essential below the TypeScript layer.

The purpose of the native layer is to make the system powerful.

The purpose of the TypeScript layer is to make that power accessible.
