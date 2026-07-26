# ADR-0004: Keep the Sevyn Runtime Framework-Independent

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

React Native is the flagship application framework for SevynOS.

It will receive the deepest integration, strongest tooling, best documentation, and most complete first-party support.

However, React Native is not the operating system.

SevynOS must also be capable of supporting applications that use other technologies, including:

* native C, C++, or Rust applications
* command-line applications
* games and custom rendering engines
* WebAssembly applications
* web applications
* Qt applications
* Flutter applications
* background services
* system daemons
* future application frameworks

If the Sevyn Runtime is designed around React Native-specific concepts, every future application type would either need to imitate React Native or bypass the Runtime entirely.

That would create several architectural problems:

* platform services would become tied to one framework
* permissions could be enforced inconsistently
* application lifecycle rules would fragment
* non-React-Native applications could become second-class
* framework upgrades could destabilize the core platform
* replacing or supplementing React Native would become unnecessarily difficult
* system security boundaries could leak into application-framework code

The Runtime must therefore define what a SevynOS application is without assuming how that application renders its interface or which programming language it uses.

## Decision

The Sevyn Runtime will remain framework-independent.

The Runtime will manage all applications through a common application contract.

That contract will describe platform-level concerns such as:

* application identity
* package metadata
* executable entry point
* application type
* requested permissions
* granted capabilities
* lifecycle state
* process ownership
* resource limits
* communication endpoints
* supported device classes
* launch behavior
* shutdown behavior

Framework-specific behavior will be implemented by separate application hosts or adapters.

Examples include:

```text
React Native App
      │
React Native Host
      │
Sevyn Runtime
```

```text
Web App
   │
Web Host
   │
Sevyn Runtime
```

```text
Native App
    │
Native App Adapter
    │
Sevyn Runtime
```

The Runtime will not directly depend on React components, JavaScript bundles, Hermes, Fabric, TurboModules, or other React Native implementation details.

The architectural rule is:

> The Runtime manages applications. Framework hosts manage frameworks.

## Rationale

### Long-term platform flexibility

SevynOS is intended to become a broad computing platform rather than a single-framework execution environment.

A framework-independent Runtime preserves the ability to support new application models without redesigning the core operating system.

### Stable platform boundary

Application frameworks change more quickly than operating-system contracts.

React Native may change its renderer, module system, build architecture, JavaScript engine, or packaging model.

The Runtime should not need major architectural changes whenever a framework evolves.

Instead, only the affected framework host should need adaptation.

### Consistent security

Permissions and privileged access must be enforced by SevynOS, not by a user-interface framework.

A framework-independent Runtime allows all application types to use the same:

* identity model
* permission system
* capability grants
* IPC rules
* process policies
* resource controls
* package validation
* lifecycle authority

This avoids creating separate security models for each application framework.

### Consistent lifecycle

The Runtime should define application lifecycle states independently of framework-specific events.

A React Native host may translate a Runtime event into a JavaScript callback.

A native application may receive the same event through IPC or a native library.

The platform behavior remains consistent even though the delivery mechanism changes.

### Support for specialized applications

React Native is well suited to many interfaces, but not every application should use it.

Examples include:

* high-performance games
* graphics tools
* compilers
* device-management services
* media-processing software
* background daemons
* terminal utilities
* low-latency applications
* hardware-control software

These applications should still participate fully in the SevynOS application model.

### Reduced architectural lock-in

Making the Runtime independent from React Native protects SevynOS if:

* React Native changes direction
* a different framework becomes important
* Project Sevyn supports additional programming models
* some devices require lighter application environments
* particular workloads require native execution
* React Native becomes unsuitable for selected system components

React Native can remain the flagship framework without becoming a mandatory dependency for the entire platform.

## Architectural Model

```text
┌─────────────────────────────────────────────┐
│                Applications                 │
│                                             │
│ React Native │ Native │ Web │ WASM │ Other  │
└───────┬──────────┬──────┬──────┬────────────┘
        │          │      │      │
┌───────▼──────────▼──────▼──────▼────────────┐
│             Framework Hosts                 │
│                                             │
│ RN Host │ Native Adapter │ Web Host │ WASM  │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│               Sevyn Runtime                 │
│                                             │
│ Identity, Lifecycle, Permissions, Packages, │
│ IPC, Resources, Sessions, App Registry      │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│              System Services                │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│               Linux Kernel                  │
└─────────────────────────────────────────────┘
```

Framework hosts may depend on the Runtime.

The Runtime must not depend on a specific framework host.

## Runtime Responsibilities

The Runtime should own responsibilities that apply to every SevynOS application.

### Application identity

Each application must have a unique identifier.

Example:

```text
com.projectsevyn.settings
```

Identity should be used for:

* permissions
* storage scopes
* IPC addressing
* package updates
* application ownership
* logs
* crash reports
* notification routing
* process tracking

### Application registry

The Runtime should maintain a registry of installed applications.

The registry may include:

* application ID
* display name
* version
* package location
* framework type
* entry point
* permissions
* supported device classes
* developer identity
* installation state
* enabled or disabled status

### Package validation

Before launching an application, the Runtime should validate:

* manifest structure
* package identity
* entry-point existence
* framework support
* permission declarations
* package integrity
* platform compatibility
* signature information when supported

### Application launch

The Runtime should:

1. receive a launch request
2. locate the application
3. validate its package
4. determine the application type
5. choose the correct framework host
6. create an application session
7. provide approved capabilities
8. start the application
9. track its lifecycle
10. report startup success or failure

### Lifecycle authority

The Runtime should own the canonical application state.

Possible states include:

```text
Installed
Starting
Running
Background
Suspended
Stopping
Stopped
Crashed
```

Framework hosts may translate these states into framework-specific events, but they must not invent contradictory platform states.

### Permission enforcement

The Runtime should coordinate with the permission service to determine what an application may access.

Applications should receive capability handles or service access only after authorization.

A framework host must not grant permissions independently.

### Resource management

The Runtime may eventually manage:

* memory limits
* CPU policies
* background execution
* storage quotas
* network policies
* open windows
* graphics surfaces
* device access
* process priorities
* energy usage

The first prototype may implement only a small subset.

### Inter-process communication

The Runtime should help establish authenticated communication between:

* applications
* framework hosts
* system services
* shell components
* developer tools

The exact IPC technology will be decided separately.

### Shutdown and recovery

The Runtime should:

* request graceful shutdown
* enforce termination when required
* release application resources
* record crash information
* clean up stale sessions
* notify the Shell of state changes
* support application restart policies

## Framework Host Responsibilities

A framework host adapts a specific application technology to the Runtime.

A host is responsible for framework-specific work such as:

* loading framework code
* initializing language runtimes
* loading bundles or executables
* creating render surfaces
* forwarding input
* translating lifecycle events
* exposing SDK bindings
* returning logs and errors
* cleaning up framework resources

A host must not independently control:

* system-wide permissions
* application identity
* package installation
* trusted capability issuance
* global lifecycle policy
* unrelated application processes
* security decisions owned by the Runtime

## Proposed Application Contract

A conceptual application manifest may include:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "applicationType": "react-native",
  "entryPoint": "./dist/index.bundle",
  "permissions": [
    "files.user-documents",
    "notifications.post"
  ],
  "devices": [
    "desktop",
    "tablet",
    "phone"
  ]
}
```

The Runtime should interpret `applicationType` and select a compatible host.

A conceptual internal launch request may resemble:

```ts
type ApplicationLaunchRequest = {
  applicationId: string;
  reason:
    | "user"
    | "system"
    | "notification"
    | "file"
    | "protocol"
    | "background";
  arguments?: string[];
  environment?: Record<string, string>;
};
```

The Runtime may resolve this into:

```ts
type ApplicationSession = {
  sessionId: string;
  applicationId: string;
  applicationType: string;
  state: ApplicationState;
  grantedCapabilities: string[];
  processId?: number;
  hostId: string;
};
```

These examples are illustrative and are not final public APIs.

## Application Host Selection

The Runtime should use a host registry.

Conceptually:

```ts
type ApplicationHostDescriptor = {
  id: string;
  supportedTypes: string[];
  executable: string;
  version: string;
};
```

Example host registrations:

```text
Host: org.sevynos.host.react-native
Types:
- react-native
```

```text
Host: org.sevynos.host.web
Types:
- web
- pwa
```

```text
Host: org.sevynos.host.wasm
Types:
- wasm
```

The host-selection process should reject unsupported application types with a clear error rather than attempting an unsafe fallback.

## React Native Integration

The React Native host will be the first framework host implemented.

It may be responsible for:

* starting Hermes
* loading JavaScript or Hermes bytecode
* initializing React Native
* registering SevynOS native components
* registering SDK modules
* creating Fabric surfaces
* connecting lifecycle events
* forwarding logs
* handling Fast Refresh in development
* shutting down the JavaScript runtime

The Runtime should only need to know that the application uses the `react-native` application type and that a compatible host is installed.

The Runtime should not need to know:

* component names
* React trees
* JavaScript module formats
* Metro configuration
* Fabric internals
* TurboModule definitions
* React hooks
* application UI state

## Shell Integration

The Sevyn Shell should request application operations through the Runtime.

Example:

```ts
await Runtime.launchApplication(
  "com.projectsevyn.settings",
);
```

The Shell should not launch framework executables directly.

The Shell may subscribe to Runtime events such as:

```ts
Runtime.on("applicationStarted", handleStarted);
Runtime.on("applicationStopped", handleStopped);
Runtime.on("applicationCrashed", handleCrash);
Runtime.on("applicationStateChanged", handleState);
```

This ensures that the Shell remains independent from application implementation details.

## System Application Policy

System applications should use the same Runtime contract as third-party applications whenever practical.

A Settings application built with React Native should still:

* have an application identity
* have a manifest
* launch through the Runtime
* receive permissions
* follow lifecycle rules
* use documented APIs

Some trusted components may receive elevated capabilities.

Those exceptions must be explicit and documented rather than hidden inside the framework implementation.

## Versioning

The Runtime application contract should be versioned independently from individual frameworks.

Possible version domains include:

* package manifest version
* Runtime protocol version
* framework-host protocol version
* SDK API version
* service protocol version

A framework host should declare which Runtime protocol versions it supports.

Example:

```json
{
  "host": "org.sevynos.host.react-native",
  "hostVersion": "0.1.0",
  "runtimeProtocol": "^1.0.0",
  "applicationTypes": [
    "react-native"
  ]
}
```

The exact format will be decided later.

## Error Model

The Runtime should return framework-neutral errors.

Possible error categories include:

```text
APPLICATION_NOT_FOUND
INVALID_MANIFEST
UNSUPPORTED_APPLICATION_TYPE
HOST_NOT_AVAILABLE
PERMISSION_DENIED
PACKAGE_INCOMPATIBLE
LAUNCH_FAILED
APPLICATION_CRASHED
RESOURCE_LIMIT_EXCEEDED
SHUTDOWN_TIMEOUT
```

Framework hosts may include additional diagnostic information, but callers should be able to handle the main failure without understanding the framework.

Example:

```ts
type RuntimeError = {
  code: string;
  message: string;
  applicationId?: string;
  hostId?: string;
  details?: unknown;
};
```

## Security Model

The framework host should be treated as a privileged platform component because it may:

* create application processes
* load untrusted code
* access graphics surfaces
* forward permissions
* connect to system services
* handle application data

Each host must:

* validate Runtime requests
* isolate application sessions
* avoid sharing capabilities between applications
* validate messages from untrusted code
* release capabilities at shutdown
* report crashes accurately
* avoid exposing unrestricted operating-system access

The Runtime must authenticate framework hosts.

Applications must not be able to impersonate a host or another application.

## Prototype Scope

The Genesis prototype only needs one host:

```text
org.sevynos.host.react-native
```

The prototype should still preserve the framework-independent boundary.

### Included

* an application-type field in the manifest
* a framework-neutral application registry
* a host interface
* one registered React Native host
* framework-neutral lifecycle states
* framework-neutral launch and stop operations
* host-selection logic
* clear unsupported-type errors
* host crash reporting

### Not included

* multiple production-ready hosts
* hot-swappable hosts
* third-party host installation
* complete host sandboxing
* public host-development SDK
* production protocol compatibility
* framework marketplace
* automatic host downloads
* fallback compatibility environments

The goal is to prove the boundary before the codebase becomes dependent on React Native assumptions.

## Prototype Interface

A minimal internal interface may resemble:

```ts
export type ApplicationState =
  | "starting"
  | "running"
  | "background"
  | "suspended"
  | "stopping"
  | "stopped"
  | "crashed";

export type ApplicationDefinition = {
  id: string;
  name: string;
  applicationType: string;
  entryPoint: string;
  permissions: string[];
};

export type LaunchContext = {
  sessionId: string;
  application: ApplicationDefinition;
  grantedCapabilities: string[];
};

export interface ApplicationHost {
  readonly id: string;

  supports(
    applicationType: string,
  ): boolean;

  launch(
    context: LaunchContext,
  ): Promise<void>;

  stop(
    sessionId: string,
  ): Promise<void>;
}
```

A React Native host could implement it:

```ts
export class ReactNativeHost
  implements ApplicationHost
{
  readonly id =
    "org.sevynos.host.react-native";

  supports(
    applicationType: string,
  ): boolean {
    return applicationType === "react-native";
  }

  async launch(
    context: LaunchContext,
  ): Promise<void> {
    // Start the React Native application.
  }

  async stop(
    sessionId: string,
  ): Promise<void> {
    // Shut down the React Native application.
  }
}
```

The exact implementation may use native code rather than TypeScript. The important part is the separation of responsibilities.

## Consequences

### Positive consequences

* The Runtime remains stable as frameworks evolve.
* SevynOS can support new application types later.
* Security and permissions remain consistent.
* React Native stays first-class without becoming mandatory.
* Framework-specific code remains isolated.
* Application lifecycle rules can be shared.
* The Shell does not need framework knowledge.
* Specialized native and high-performance applications remain possible.
* Framework-host compatibility can be tested independently.
* Future devices can choose appropriate hosts without redefining the Runtime.

### Negative consequences

* The architecture requires an additional abstraction layer.
* Host protocols must be designed and maintained.
* Framework-neutral concepts may initially feel more complex.
* Some framework features may not map cleanly to shared lifecycle rules.
* Debugging may cross application, host, Runtime, and service boundaries.
* Host registration and compatibility add startup and packaging complexity.
* The first prototype may take slightly longer than directly embedding React Native into the Runtime.
* Poorly designed abstractions could become overly generic or difficult to use.

### Risks

The largest risk is creating an abstraction so generic that it becomes vague, inflexible, or difficult to implement.

To reduce this risk:

* design around the React Native host first
* generalize only proven platform responsibilities
* avoid speculative support for unknown frameworks
* keep the initial host interface small
* separate required capabilities from optional extensions
* allow host-specific metadata without placing it in the core contract
* test the design with at least one non-React-Native mock host
* revise the contract before declaring it stable

Another risk is allowing framework-specific concepts to leak gradually into the Runtime.

To reduce that risk:

* review Runtime dependencies
* prohibit imports from React Native packages in Runtime code
* keep framework code in separate packages
* use protocol-level messages between Runtime and hosts
* create architecture tests where practical
* document every exception

## Alternatives Considered

### Embed React Native directly into the Runtime

This would make the first prototype simpler.

It was rejected because it would tie application lifecycle, process management, and system behavior directly to React Native.

That would make future framework support difficult and place too much platform responsibility inside the React Native integration.

### Make React Native the SevynOS application model

This would treat React Native applications as the only true SevynOS applications.

It was rejected because games, native tools, system services, command-line software, and future frameworks require different execution models.

React Native is the flagship application framework, not the definition of an application.

### Allow each framework to bypass the Runtime

Each framework could launch and manage applications independently.

This was rejected because it would fragment:

* permissions
* lifecycle
* package management
* identity
* resource control
* crash reporting
* security
* user experience

All applications must remain visible to and governed by the Runtime.

### Build separate runtimes for each framework

SevynOS could maintain a React Native Runtime, Web Runtime, Native Runtime, and others.

This was rejected because shared platform responsibilities would be duplicated and likely become inconsistent.

Framework hosts provide the necessary specialization without duplicating the full application-management layer.

### Delay framework independence until later

The first implementation could embed React Native and refactor afterward.

This was rejected because architectural boundaries are most difficult to introduce after assumptions have spread throughout the codebase.

The initial implementation should be minimal, but the separation must exist from the start.

## Validation Criteria

This decision will be validated when:

1. The Runtime launches a React Native application through a host interface.
2. Runtime code does not import React Native framework packages.
3. The manifest identifies the application type.
4. The Runtime selects the React Native host dynamically.
5. Lifecycle state is owned by the Runtime.
6. The host translates Runtime events into React Native events.
7. An unsupported application type returns a framework-neutral error.
8. The Shell launches the application without knowing its framework.
9. A mock non-React-Native host can implement the same minimum interface.
10. Stopping or crashing the host is reported cleanly to the Runtime.

## Revisit Conditions

This decision should be reconsidered if:

* the host abstraction prevents required platform features
* framework-independent lifecycle states become impractical
* performance overhead becomes measurable and unacceptable
* security requires a substantially different host model
* supporting multiple frameworks creates unsustainable complexity
* all practical applications converge permanently on one execution model
* a better application-isolation architecture replaces the host model

Reconsidering the host interface does not change the broader requirement that the Runtime remain independent from a single application framework.

## Immediate Implementation Tasks

Project Sevyn should next:

1. Define the minimum application manifest schema.
2. Define the application lifecycle state machine.
3. Define the first `ApplicationHost` interface.
4. Define framework-neutral Runtime errors.
5. Create a React Native host package boundary.
6. Create a mock host for architecture testing.
7. Prevent Runtime packages from importing React Native.
8. Define host registration.
9. Define application-session identity.
10. Document the first launch sequence.

## Final Position

The Sevyn Runtime will manage applications without depending on the framework used to build them.

React Native will remain the flagship and best-supported application framework.

Its integration will be deep, polished, and native to SevynOS.

But the foundation beneath it will remain open to other application models.

The Runtime defines what an application may do.

The framework host defines how the application runs.
