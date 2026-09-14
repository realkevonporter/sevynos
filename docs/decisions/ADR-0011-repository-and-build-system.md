# ADR-0011: Define the SevynOS Repository and Build System

**Status:** Accepted
**Date:** July 26, 2026
**Decision owners:** Project Sevyn
**Applies to:** Project Sevyn / SevynOS
**Architecture version:** v0.1 Genesis

> The monorepository decision remains active. The original directory layout is
> superseded by ADR-0012 where implementation experience established clearer
> responsibility boundaries.

---

# Context

Project Sevyn will eventually contain:

- the Runtime
- the Shell
- the compositor
- framework hosts
- SDKs
- platform services
- developer tools
- documentation
- sample applications
- test suites
- build tooling

Although these components evolve independently, they define a single operating system.

The repository structure should reflect the architecture rather than the implementation language.

A contributor should be able to understand the platform simply by looking at the top-level directories.

---

# Decision

Project Sevyn will use a **single monorepository**.

The repository is organized by **architectural responsibility**, not programming language.

Every major subsystem owns one clearly defined directory.

The repository should remain understandable even as languages change.

---

# Repository Principles

The repository should satisfy the following goals:

- architecture is obvious
- boundaries are explicit
- dependencies point inward
- reusable code is isolated
- documentation lives beside implementation
- generated code is separated from handwritten code
- tests mirror production code
- every directory has one responsibility

---

# Repository Layout

Genesis adopts the following structure.

```text
sevynos/

├── docs/
│
├── runtime/
│
├── shell/
│
├── compositor/
│
├── hosts/
│
├── sdk/
│
├── services/
│
├── protocols/
│
├── tools/
│
├── packages/
│
├── applications/
│
├── examples/
│
├── tests/
│
├── scripts/
│
├── assets/
│
└── third_party/
```

---

# docs/

Contains documentation only.

Examples:

```text
docs/

VISION.md

ARCHITECTURE.md

ROADMAP.md

GLOSSARY.md

decisions/

guides/

reference/
```

No implementation code belongs here.

---

# runtime/

Contains the Sevyn Runtime.

Responsibilities:

- application lifecycle
- sessions
- permissions
- IPC
- service registry
- application loading
- capability management

The Runtime owns platform policy.

---

# shell/

Contains the graphical shell.

Responsibilities:

- launcher
- desktop
- lock screen
- task switcher
- notification center
- settings UI
- widgets
- system UI

The Shell owns user experience.

It does **not** own policy.

---

# compositor/

Contains the Wayland compositor.

Responsibilities:

- Wayland protocols
- rendering
- outputs
- surfaces
- input routing
- window composition

The compositor owns graphics.

---

# hosts/

Framework integrations.

Example:

```text
hosts/

react-native/

native/

web/

wasm/
```

Each host translates Runtime behavior into framework behavior.

Hosts never replace Runtime decisions.

---

# sdk/

Developer SDKs.

Possible layout:

```text
sdk/

typescript/

c/

cpp/

rust/

future/
```

Every SDK implements the same public platform APIs.

Language should not change platform behavior.

---

# services/

Platform services.

Example:

```text
services/

notifications/

permissions/

files/

settings/

media/

clipboard/

updates/

accounts/
```

Each service owns:

- implementation
- tests
- protocol handlers

---

# protocols/

Every public protocol.

Example:

```text
protocols/

runtime-shell/

runtime-host/

runtime-compositor/

notifications/

permissions/

files/
```

Versioning:

```text
runtime-shell/

v1/

v2/
```

Generated code never edits these definitions.

---

# packages/

Reusable libraries.

Example:

```text
packages/

logging/

config/

errors/

utils/

serialization/

crypto/
```

Packages must not become dumping grounds.

If a package gains architectural ownership, promote it into its own subsystem.

---

# tools/

Developer tooling.

Examples:

```text
tools/

cli/

inspector/

package-manager/

profiler/

benchmark/
```

Developer tooling should not become runtime dependencies.

---

# applications/

Official SevynOS applications.

Examples:

```text
applications/

settings/

files/

terminal/

calculator/

browser/

camera/
```

Applications follow the same application model as third-party software whenever practical.

This keeps the platform honest.

---

# examples/

Reference applications.

Purpose:

teach

Examples:

```text
hello-world

camera-demo

notifications-demo

background-service

file-picker
```

---

# tests/

System-level tests.

Examples:

```text
tests/

integration/

performance/

security/

compatibility/

stress/
```

Unit tests remain beside source code.

---

# scripts/

Repository automation.

Examples:

```text
bootstrap

generate

lint

format

release

docs
```

---

# assets/

Shared artwork.

Examples:

- icons
- logos
- branding
- wallpapers

---

# third_party/

Vendored dependencies.

Only include code when absolutely necessary.

Never modify third-party code without documenting patches.

---

# Build Philosophy

The build system exists to:

- build
- test
- package
- generate code

Nothing more.

Business logic never belongs inside build scripts.

---

# Monorepo Tooling

Genesis adopts:

- pnpm workspaces
- Turbo

Reasons:

- fast incremental builds
- excellent TypeScript support
- caching
- task graph
- scalable workspace management

Native projects integrate through Turbo tasks rather than replacing it.

---

# Language Strategy

Repository language choices:

Runtime:

TypeScript

Shell:

TypeScript

SDK:

TypeScript initially

Compositor:

C

Native libraries:

C

Future SDKs:

Rust

C++

Swift

Kotlin

The repository should not be organized around these languages.

---

# Dependency Rules

Dependencies always point toward lower layers.

Allowed direction:

```text
Applications

↓

SDK

↓

Runtime protocols

↓

Runtime

↓

Kernel
```

Not allowed:

Applications

↓

Runtime internals

---

Shell

↓

Host internals

---

Compositor

↓

Shell

---

Hosts

↓

Applications

---

Services

↓

Application code

---

Circular dependencies are prohibited.

---

# Generated Code

Generated code belongs in dedicated directories.

Example:

```text
generated/
```

Never edit generated code.

Protocol definitions remain authoritative.

---

# Configuration

Repository configuration belongs at the root.

Examples:

```text
package.json

pnpm-workspace.yaml

turbo.json

.editorconfig

.prettierrc

.eslintrc

.gitignore
```

Keep configuration minimal.

---

# Documentation

Every subsystem should contain:

```text
README.md
```

explaining:

- purpose
- dependencies
- public APIs
- ownership

A new contributor should understand a subsystem within minutes.

---

# Naming Rules

Directories:

lowercase

kebab-case

Examples:

```text
runtime

permission-service

react-native
```

TypeScript:

PascalCase for classes

camelCase for variables

UPPER_CASE for constants

C:

snake_case

Consistency matters more than preference.

---

# Versioning

The repository has one canonical source version.

Protocols version independently.

SDK packages version independently.

Applications version independently.

These versions must never be confused.

---

# Branch Strategy

Primary branch:

```text
main
```

Feature branches:

```text
feature/runtime-lifecycle

feature/react-native-host

feature/file-service
```

Release branches may be added later.

---

# Commit Convention

Preferred format:

```text
runtime: implement lifecycle manager

shell: add launcher

docs: write ADR-0010

protocols: add runtime-host v1
```

Commit messages describe intent.

---

# Testing Strategy

Every subsystem owns:

- unit tests

Repository owns:

- integration tests
- security tests
- performance tests

Builds fail on failing tests.

---

# CI Pipeline

Every pull request should execute:

1. format
2. lint
3. type check
4. unit tests
5. protocol validation
6. generated code verification
7. integration tests (where applicable)

Main should always be releasable.

---

# Build Outputs

Separate:

```text
build/

dist/

generated/

artifacts/
```

Temporary outputs never belong beside source code.

---

# Documentation Generation

Future documentation should be generated from:

- protocol definitions
- SDK metadata
- source comments
- ADR references

Avoid duplicated documentation.

---

# Ownership

Every major subsystem should eventually have maintainers.

Example:

```text
Runtime

Shell

Compositor

SDK

Services

Protocols
```

Clear ownership improves review quality.

---

# Security

Secrets never belong inside the repository.

Development credentials use:

```text
.env.local
```

ignored by Git.

---

# Genesis Scope

Genesis includes:

- Runtime
- Shell
- React Native host
- Runtime protocols
- Permission service
- Notification service
- Settings application
- File service prototype
- TypeScript SDK
- Documentation
- Example applications

Everything else may evolve later.

---

# Alternatives Considered

## Multiple repositories

Rejected.

Reasons:

- harder refactoring
- duplicated tooling
- version synchronization
- fragmented documentation

---

## Organizing by language

Rejected.

Architecture should outlive implementation language.

---

## Organizing by team

Rejected.

Teams change.

Architecture should not.

---

## Runtime inside Shell

Rejected.

The Runtime is platform infrastructure.

The Shell is only one client.

---

# Validation Criteria

This decision succeeds when:

- contributors immediately understand repository structure
- dependencies remain one-directional
- builds are reproducible
- generated code stays isolated
- documentation remains close to implementation
- new framework hosts integrate without restructuring the repository
- official applications behave like third-party applications

---

# Immediate Implementation Tasks

1. Create the monorepo.
2. Configure pnpm workspaces.
3. Configure Turbo.
4. Create every top-level directory.
5. Add README.md to each subsystem.
6. Configure ESLint, Prettier, and EditorConfig.
7. Add CI.
8. Add protocol generation.
9. Add testing pipeline.
10. Bootstrap the Runtime.
11. Bootstrap the React Native host.
12. Bootstrap the Shell.
13. Bootstrap the compositor.

---

# Final Position

Project Sevyn will use a single architecture-first monorepository.

The repository mirrors the operating system itself.

Subsystems own responsibilities.

Dependencies flow inward.

Documentation stays close to implementation.

Languages may evolve.

Frameworks may evolve.

The architecture remains stable.

The repository should teach the platform as clearly as the code implements it.
