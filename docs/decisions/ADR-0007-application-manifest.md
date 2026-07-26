# ADR-0007: Define the SevynOS Application Manifest

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

Every application running on SevynOS must describe itself before it can be installed or executed.

The operating system must be able to determine:

* what the application is
* who published it
* how it should be launched
* which framework host should execute it
* what permissions it requests
* which devices it supports
* how it integrates with the platform

This information must exist independently of the application's implementation language or framework.

The Sevyn Runtime will use this metadata to validate, install, launch, update, secure, and manage applications.

## Decision

Every SevynOS application must contain a manifest file.

The initial filename will be:

```text
sevyn.json
```

The manifest is required for every application type, including:

* React Native
* Native
* Web
* WebAssembly
* System applications

Applications without a valid manifest cannot be installed or launched.

## Design Goals

The manifest should be:

* human-readable
* version-controlled
* deterministic
* framework-independent
* extensible
* easy to validate
* stable across releases

The Runtime—not the framework host—owns interpretation of the manifest.

## Minimum Manifest

Every application must include:

```json
{
  "manifestVersion": 1,
  "id": "com.projectsevyn.settings",
  "name": "Settings",
  "version": "1.0.0",
  "publisher": "Project Sevyn",
  "applicationType": "react-native",
  "entryPoint": "./dist/index.bundle"
}
```

These fields are mandatory.

## Application Identity

The `id` uniquely identifies an application.

Rules:

* globally unique
* immutable after release
* reverse-domain notation
* lowercase
* periods as separators

Examples:

```text
com.projectsevyn.settings
com.projectsevyn.files
com.spotify.client
org.mozilla.firefox
```

Identity is used for:

* installation
* permissions
* storage
* updates
* IPC
* notifications
* logs
* crash reports
* window ownership

Changing an application's identity creates a different application.

## Versioning

Versions follow Semantic Versioning.

Example:

```json
"version": "2.4.1"
```

Future update services may use this field to determine upgrade paths.

## Application Types

Initial supported types:

```text
react-native
native
web
wasm
```

The Runtime uses this field to select the correct framework host.

Applications never launch themselves.

## Entry Point

The Runtime passes the entry point to the selected framework host.

Examples:

React Native

```text
./dist/index.bundle
```

Native

```text
./bin/editor
```

Web

```text
./dist/index.html
```

The Runtime validates the entry point before launch.

## Display Information

Applications may provide display metadata.

```json
"display": {
  "name": "Settings",
  "description": "Configure SevynOS",
  "icon": "./assets/icon.png"
}
```

This information is intended for:

* launcher
* app library
* installer
* search
* settings
* application switcher

## Permissions

Applications explicitly declare requested permissions.

Example:

```json
"permissions": [
  "files.documents",
  "notifications.post",
  "camera"
]
```

Declaring a permission does not grant it.

The Runtime evaluates each request through the permission system defined in ADR-0010.

## Supported Devices

Applications may declare supported device classes.

```json
"devices": [
  "desktop",
  "tablet",
  "phone"
]
```

An omitted list means:

> Compatible with all supported device classes.

## Runtime Requirements

Applications may declare minimum platform requirements.

Example:

```json
"runtime": {
  "minimumVersion": "0.1.0",
  "sdkVersion": "0.1"
}
```

This allows the Runtime to reject incompatible applications before launch.

## Capabilities

Applications may optionally declare platform capabilities.

Example:

```json
"capabilities": [
  "multiple-windows",
  "background-audio"
]
```

Capabilities describe optional platform features rather than security permissions.

## Launch Behavior

Applications may define preferred launch behavior.

```json
"launch": {
  "singleton": false,
  "background": false
}
```

These are requests.

The Runtime makes the final decision.

## Manifest Validation

Before launch the Runtime validates:

* schema
* required fields
* identifier
* version
* application type
* entry point
* manifest version

Invalid manifests are rejected with descriptive errors.

## Framework Independence

Framework hosts may read the manifest.

Only the Runtime interprets platform policy.

For example:

* permissions
* application identity
* updates
* installation
* compatibility

remain Runtime responsibilities.

## Future Extensions

Later manifest versions may include:

* digital signatures
* package hashes
* localization
* protocol handlers
* file associations
* startup tasks
* services
* widgets
* extensions
* AI models
* sandbox profiles
* update channels

Version 1 intentionally excludes these.

## Example

```json
{
  "manifestVersion": 1,
  "id": "com.projectsevyn.settings",
  "name": "Settings",
  "version": "1.0.0",
  "publisher": "Project Sevyn",
  "applicationType": "react-native",
  "entryPoint": "./dist/index.bundle",

  "display": {
    "name": "Settings",
    "description": "Configure SevynOS",
    "icon": "./assets/icon.png"
  },

  "permissions": [
    "notifications.post"
  ],

  "devices": [
    "desktop",
    "tablet",
    "phone"
  ],

  "runtime": {
    "minimumVersion": "0.1.0",
    "sdkVersion": "0.1"
  }
}
```

## Consequences

### Positive

* One manifest format for every application.
* Framework-independent installation.
* Consistent identity model.
* Easier validation.
* Predictable updates.
* Better tooling.

### Negative

* Every application requires metadata.
* Manifest versions must be maintained.
* Future changes require migration.

## Alternatives Considered

### Framework-specific manifests

Rejected because each framework would define installation differently.

### Multiple manifest formats

Rejected because it complicates Runtime validation and tooling.

### Code-only metadata

Rejected because applications should describe themselves before execution.

## Validation Criteria

This decision is validated when:

1. Every application contains `sevyn.json`.
2. The Runtime validates the manifest before launch.
3. Applications are identified by immutable IDs.
4. Framework hosts receive validated launch information.
5. Invalid manifests are rejected cleanly.

## Revisit Conditions

Revisit if:

* a different serialization format becomes clearly superior
* application types fundamentally change
* packaging architecture changes significantly

## Final Position

Every SevynOS application is defined by a framework-independent manifest.

The Runtime owns interpretation of the manifest.

Framework hosts consume validated launch information.

The manifest defines what an application is before any code executes.
