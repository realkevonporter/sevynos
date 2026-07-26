# ADR-0003: Make React Native a First-Class SevynOS Platform Target

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

SevynOS was inspired in part by the difficulty developers face when building and maintaining applications across multiple operating systems and device categories.

Today, a developer may need to account for:

- different application frameworks
- different platform APIs
- different build systems
- different deployment processes
- different permission models
- different lifecycle rules
- different user-interface conventions
- different native-language requirements

React Native already provides a familiar development model for building applications with React, JavaScript, and TypeScript across multiple platforms.

However, React Native applications still depend on platform-specific implementations underneath the shared framework.

Android, iOS, Windows, and macOS each provide their own:

- rendering integration
- native components
- application host
- lifecycle behavior
- system modules
- event handling
- development tooling
- build pipeline

For React Native applications to run properly on SevynOS, Project Sevyn must implement a dedicated platform layer.

This platform layer must allow React Native to interact with the Sevyn Runtime, SevynOS system services, the graphical environment, and device capabilities.

React Native is central to the original SevynOS vision, but the operating system must remain architecturally independent from any single application framework.

SevynOS may support other application technologies in the future, including:

- native C++ or Rust applications
- Qt applications
- Flutter applications
- WebAssembly applications
- games and custom rendering engines
- web applications
- command-line applications

React Native will therefore become the flagship and best-supported framework for SevynOS, not the sole framework permitted by the platform.

## Decision

SevynOS will implement React Native as a first-class platform target.

The intended developer-facing platform identifier will be:

```ts
Platform.OS === "sevynos";
```

React Native applications running on SevynOS should use a dedicated SevynOS platform implementation rather than pretending to be Android, iOS, Windows, macOS, or a generic web environment.

Project Sevyn will create and maintain the components required for React Native applications to:

- start through the Sevyn Runtime
- render inside the SevynOS graphical environment
- receive application lifecycle events
- access SevynOS system APIs
- respond to input
- interact with windows and surfaces
- use accessibility services
- participate in the permission model
- support development and debugging
- identify SevynOS as the active platform

React Native will be the preferred framework for:

- the Sevyn Shell
- first-party system applications
- sample applications
- developer templates
- most high-level user-interface development

However, the core Sevyn Runtime and public platform architecture must not require every application to use React Native.

The architectural rule is:

> SevynOS owns the application platform. React Native is the flagship client of that platform.

## Rationale

### Alignment with the founding vision

One of the original goals of SevynOS is to make it possible for developers with existing React Native experience and applications to target a new operating system without rebuilding their work from scratch.

Making React Native a first-class target directly supports that goal.

### Existing developer ecosystem

React Native has a large ecosystem of developers, libraries, tools, applications, educational resources, and community knowledge.

Supporting this ecosystem gives SevynOS a realistic path toward attracting developers without requiring them to adopt an entirely new programming model.

### TypeScript-first development

React Native aligns naturally with the decision to make TypeScript the primary high-level platform language.

The same language can be used across:

- third-party applications
- system applications
- the Sevyn Shell
- public SDK packages
- developer tooling
- examples
- documentation

### Cross-device potential

React Native is already designed around shared application logic and reusable user interfaces.

SevynOS can extend this model across:

- desktop
- phone
- tablet
- watch
- television
- vehicle displays
- embedded screens

Individual devices may require specialized layouts and capabilities, but the application model and SDK can remain consistent.

### Dogfooding

Writing the Sevyn Shell and system applications with React Native forces Project Sevyn to use the same platform offered to third-party developers.

This provides continuous validation of:

- performance
- stability
- APIs
- tooling
- accessibility
- lifecycle behavior
- rendering
- packaging
- developer experience

If Project Sevyn cannot build its own system applications effectively with React Native, the platform implementation is not yet good enough.

### Differentiation

Most operating systems treat JavaScript-based application development as a secondary compatibility option.

SevynOS can differentiate itself by making React Native one of the platform's primary application environments.

The intended experience is:

> React Native should feel like it was designed for SevynOS.

## Architectural Position

React Native will sit above the SevynOS platform APIs and Runtime.

```text
┌───────────────────────────────────────────┐
│         React Native Application          │
│                                           │
│ Components, State, Business Logic, UI     │
└──────────────────────┬────────────────────┘
                       │
┌──────────────────────▼────────────────────┐
│       React Native SevynOS Platform       │
│                                           │
│ Host, Renderer, Modules, Components,      │
│ Events, Input, Accessibility, Lifecycle   │
└──────────────────────┬────────────────────┘
                       │
┌──────────────────────▼────────────────────┐
│               SevynOS SDK                 │
│                                           │
│ Files, Windows, Devices, Permissions,     │
│ Notifications, Storage, System APIs       │
└──────────────────────┬────────────────────┘
                       │
┌──────────────────────▼────────────────────┐
│             Sevyn Runtime                 │
│                                           │
│ App Lifecycle, Registry, IPC, Packages,   │
│ Sessions, Permissions, Services           │
└──────────────────────┬────────────────────┘
                       │
┌──────────────────────▼────────────────────┐
│             System Services               │
└──────────────────────┬────────────────────┘
                       │
┌──────────────────────▼────────────────────┐
│              Linux Kernel                 │
└───────────────────────────────────────────┘
```

React Native applications must communicate with privileged system functionality through the SevynOS SDK and Runtime.

React Native itself must not become the security boundary.

## Platform Components

The React Native implementation for SevynOS is expected to include the following components.

### React Native host

The host is responsible for:

- initializing the JavaScript engine
- loading application bundles or bytecode
- creating the React Native runtime
- registering native components
- registering native modules
- connecting the app to its Sevyn Runtime session
- handling startup and shutdown
- forwarding errors and logs

### Renderer integration

SevynOS must provide a rendering path that allows React Native components to appear inside SevynOS surfaces or windows.

The implementation must determine:

- how Fabric surfaces map to SevynOS windows
- how layout is presented to the graphics stack
- how drawing is submitted
- how frames are synchronized
- how scaling and display density are handled
- how clipping, effects, and animations work
- how multiple application surfaces are managed

The exact rendering and compositor architecture will be decided separately.

### Native components

SevynOS must implement a minimum supported set of React Native components.

The first prototype may include:

- `View`
- `Text`
- `Image`
- `ScrollView`
- `TextInput`
- `Pressable`
- basic accessibility properties

Additional components should be added based on real application requirements.

### Native modules

The platform layer should expose system capabilities through TurboModules or the current preferred React Native native-module architecture.

Early modules may include:

- platform information
- application lifecycle
- windows
- storage
- files
- notifications
- permissions
- clipboard
- appearance
- device capabilities

These modules should preferably delegate to public SevynOS services rather than directly implementing privileged operating-system behavior.

### Input integration

The platform must translate SevynOS input events into React Native events.

Potential input sources include:

- mouse
- keyboard
- touchscreen
- stylus
- trackpad
- rotary input
- remote control
- game controller

Applications should be able to respond to available input methods without assuming a specific device category.

### Accessibility integration

Accessibility is part of the platform architecture and must not be postponed until the platform is mature.

The React Native implementation should eventually connect to SevynOS accessibility services for:

- semantic roles
- labels
- hints
- focus navigation
- screen readers
- reduced motion
- text scaling
- high contrast
- keyboard navigation
- alternative input

The first prototype may provide only a subset, but accessibility must remain an explicit architectural requirement.

### Lifecycle integration

React Native applications must receive lifecycle state from the Sevyn Runtime.

Potential events include:

- starting
- foreground
- background
- suspended
- resumed
- stopping
- stopped
- memory pressure
- session locking
- session unlocking
- display change
- capability change

The lifecycle API should remain consistent across device categories where possible.

### Development integration

The SevynOS React Native platform should eventually support:

- fast refresh
- debugging
- development builds
- source maps
- structured logging
- error overlays
- performance profiling
- component inspection
- emulator or simulator workflows
- remote development

The Genesis prototype only needs the minimum tooling necessary to launch and debug a simple application.

## Public Platform Identity

React Native applications must be able to identify SevynOS explicitly.

Example:

```ts
import { Platform } from "react-native";

if (Platform.OS === "sevynos") {
  console.log("Running on SevynOS");
}
```

SevynOS may also provide richer platform information through its SDK.

```ts
import { System } from "@sevynos/system";

console.log(System.platform);
console.log(System.deviceClass);
console.log(System.capabilities);
```

Possible output:

```ts
{
  name: "SevynOS",
  version: "0.1.0",
  architecture: "x86_64",
  deviceClass: "desktop",
}
```

Applications should prefer capability detection over excessive platform checks.

Example:

```ts
import { Device } from "@sevynos/system";

if (Device.hasCapability("pointer")) {
  // Enable pointer-specific interaction.
}

if (Device.hasCapability("touch")) {
  // Enable touch-specific interaction.
}
```

## Compatibility Goal

The long-term compatibility goal is:

> A well-written React Native application should require minimal application-level changes to run on SevynOS.

Minimal changes may still be required when an application:

- uses platform-specific native modules
- depends on Android or Apple services
- assumes a mobile-only layout
- uses unsupported native libraries
- depends on platform-specific permissions
- uses proprietary APIs
- relies on unsupported React Native components

SevynOS should not promise perfect compatibility with every React Native application.

Instead, it should provide:

- clear compatibility documentation
- migration tooling
- capability detection
- replacement SDK modules
- actionable build errors
- platform support guidelines
- a compatibility test suite

## Framework Independence

The Sevyn Runtime must not assume that all applications use React Native.

The Runtime should launch applications through a framework-neutral application contract.

A conceptual launch request may resemble:

```ts
type AppLaunchRequest = {
  applicationId: string;
  entryPoint: string;
  framework: "react-native" | "native" | "web" | "wasm";
  permissions: string[];
  environment: Record<string, string>;
};
```

This is illustrative and not a final API.

React Native-specific behavior belongs in the React Native host and platform integration layer.

The Runtime should manage:

- identity
- permissions
- process or session ownership
- lifecycle
- resources
- communication
- termination

without depending on how the application's interface is built.

## Upstream Strategy

Project Sevyn should avoid maintaining a permanently isolated fork of React Native whenever possible.

The preferred strategy is:

1. build the smallest viable SevynOS platform implementation
2. keep platform-specific changes modular
3. contribute general improvements upstream where appropriate
4. engage with the React Native community
5. follow current React Native architecture
6. avoid modifying unrelated framework behavior
7. maintain clear compatibility with upstream releases

Some SevynOS-specific code will naturally remain within Project Sevyn.

However, improvements to areas such as Linux support, accessibility, platform abstractions, documentation, or debugging should be contributed upstream when they are broadly useful and acceptable to the upstream project.

## Package and Repository Direction

The React Native platform implementation may eventually include packages such as:

```text
@sevynos/react-native
@sevynos/react-native-host
@sevynos/react-native-platform
@sevynos/react-native-components
@sevynos/react-native-devtools
```

The exact naming and package structure will be decided after researching how existing React Native platforms organize their implementations.

The implementation should live separately from application SDK packages.

Example:

```text
packages/
├── react-native-platform/
├── react-native-host/
├── sdk/
├── app-manifest/
└── shared-types/
```

## Initial Prototype Scope

The Genesis prototype should support only the minimum required path.

### Included

- one desktop Linux environment
- one React Native application
- Hermes or another supported JavaScript runtime
- a minimal React Native host
- basic rendering
- basic pointer or keyboard input
- a small supported component set
- one typed native module
- application lifecycle integration
- explicit `sevynos` platform identity
- development logging
- clean application startup and shutdown

### Not included

- complete React Native API compatibility
- Android application compatibility
- iOS application compatibility
- every community native module
- mobile hardware support
- full accessibility implementation
- production sandboxing
- production package installation
- public app-store distribution
- advanced animation support
- complete debugging tools
- multiple rendering backends
- stable third-party SDK guarantees

The initial goal is architectural validation, not production readiness.

## Prototype Demonstration

The first demonstration application should:

1. be written in TypeScript
2. render a basic React Native interface
3. show that `Platform.OS` is `sevynos`
4. receive a lifecycle event
5. call a SevynOS native-backed API
6. react to one user input
7. close through the Sevyn Runtime

Example application:

```tsx
import { useEffect, useState } from "react";

import { Platform, Pressable, Text, View } from "react-native";

import { AppLifecycle, System } from "@sevynos/sdk";

export default function App() {
  const [state, setState] = useState("starting");

  useEffect(() => {
    return AppLifecycle.subscribe((nextState) => {
      setState(nextState);
    });
  }, []);

  return (
    <View>
      <Text>Welcome to SevynOS</Text>
      <Text>Platform: {Platform.OS}</Text>
      <Text>Version: {System.version}</Text>
      <Text>State: {state}</Text>

      <Pressable
        onPress={() => {
          console.log("SevynOS input works");
        }}
      >
        <Text>Test Input</Text>
      </Pressable>
    </View>
  );
}
```

Expected platform value:

```text
sevynos
```

## Performance Expectations

React Native applications on SevynOS must eventually meet defined performance targets.

These should include:

- application startup time
- first rendered frame
- input latency
- animation smoothness
- memory usage
- idle CPU usage
- background resource usage
- application shutdown time

The project must measure performance rather than assume React Native is either fast enough or too slow.

Early prototypes may not meet production targets, but performance instrumentation should be introduced before major architectural decisions become difficult to reverse.

## Security Boundaries

React Native applications are untrusted unless explicitly designated as trusted system components.

The JavaScript environment must not receive unrestricted access to:

- the filesystem
- devices
- other applications
- system services
- process control
- user data
- authentication material
- network credentials
- privileged settings

All privileged access must pass through:

- the SevynOS SDK
- Runtime permission checks
- validated IPC
- system services
- capability restrictions

Type definitions and JavaScript-level checks are not security controls.

Security enforcement must occur in trusted native or service layers.

## Consequences

### Positive consequences

- React Native developers gain a familiar path to SevynOS.
- Existing application code may be reused.
- TypeScript becomes consistent across applications, the Shell, and SDK.
- SevynOS can attract contributors from the React ecosystem.
- System applications can validate the public platform.
- Cross-device development becomes a central platform capability.
- Project Sevyn gains a clear technical identity.
- React Native improvements may benefit the wider ecosystem.
- Application developers can avoid direct Linux-specific programming.
- The platform can provide modern tooling from its earliest stages.

### Negative consequences

- Implementing a new React Native platform is a major engineering effort.
- Compatibility with upstream React Native releases will require continuous maintenance.
- Many existing native modules will not work automatically.
- Graphics integration may become complex.
- The project will depend on parts of React Native's architecture and release direction.
- Debugging problems may span TypeScript, C++, graphics, IPC, and Linux layers.
- Performance must be carefully measured and optimized.
- Some applications will still require SevynOS-specific adaptations.
- Supporting React Native well may initially slow support for other frameworks.

### Risks

The largest risk is underestimating the work required to implement and maintain a complete React Native platform.

Specific risks include:

- renderer complexity
- incomplete component behavior
- upstream architectural changes
- weak native-module compatibility
- inaccessible user interfaces
- poor startup performance
- memory overhead on modest devices
- dependency on undocumented framework behavior
- a long-lived fork that becomes difficult to update
- confusion between React Native APIs and SevynOS APIs

To reduce these risks:

- begin with a narrow prototype
- follow the current React Native architecture
- avoid claiming complete compatibility
- separate SevynOS services from React Native bindings
- create automated compatibility tests
- contribute upstream where possible
- document unsupported APIs
- measure performance continuously
- keep the Runtime framework-neutral
- add features based on real applications rather than theoretical completeness

## Alternatives Considered

### Treat React Native as an Android compatibility layer

SevynOS could attempt to run Android React Native applications through Android compatibility technologies.

This was rejected as the primary architecture because SevynOS would inherit Android's application model, APIs, lifecycle assumptions, and compatibility constraints.

Android compatibility may be explored separately in the future, but it should not define native SevynOS applications.

### Use React Native for the Shell only

SevynOS could use React Native internally while offering a different public application framework.

This was rejected because it would fail to deliver the developer experience central to the SevynOS vision.

System applications and third-party applications should benefit from the same first-class implementation.

### Use web applications as the primary model

Web applications provide broad portability and mature tooling.

They were not selected as the flagship application model because web runtimes may not provide the native integration, interaction quality, lifecycle control, and system-level experience envisioned for SevynOS.

Web applications may still be supported as a separate application type.

### Create an entirely new UI framework

A custom framework would provide complete control.

It was rejected for the initial platform because building a language, renderer, tooling ecosystem, component model, debugging experience, documentation ecosystem, and developer community would greatly increase the project's scope.

SevynOS should innovate where it provides distinct value rather than rebuilding a mature application framework without a compelling reason.

### Make React Native the only supported framework

This would simplify the platform initially.

It was rejected because it would create unnecessary architectural lock-in and prevent future support for games, native applications, specialized software, and alternative frameworks.

React Native will be first-class, not exclusive.

## Validation Criteria

This decision will be validated when:

1. React Native recognizes `sevynos` as a platform target.
2. A TypeScript application launches through the Sevyn Runtime.
3. The application renders without using an Android or iOS compatibility environment.
4. Basic input reaches the application.
5. A lifecycle event reaches the application.
6. A typed native module calls a SevynOS service.
7. The application closes cleanly.
8. The Runtime remains able to describe non-React-Native application types.
9. Platform-specific code is sufficiently isolated to track upstream React Native changes.
10. The prototype demonstrates acceptable initial performance.

## Revisit Conditions

This decision should be reconsidered if:

- React Native becomes technically incompatible with core SevynOS goals
- maintaining the platform implementation becomes unsustainable
- performance cannot meet target device requirements
- upstream changes make long-term support impractical
- the framework cannot provide required accessibility
- developers show little interest despite a functional implementation
- another framework offers substantially better compatibility with the SevynOS mission
- React Native's licensing or governance becomes incompatible with Project Sevyn

Reconsidering this decision may change React Native's status as the flagship framework, but it should not unnecessarily break existing applications.

## Immediate Research Tasks

Before implementation begins, Project Sevyn should research:

1. React Native's current platform architecture
2. Fabric renderer platform requirements
3. TurboModule platform integration
4. Hermes embedding
5. React Native Windows architecture
6. React Native macOS architecture
7. existing React Native Linux experiments
8. Wayland compositor integration
9. Skia-based rendering options
10. desktop input and accessibility models
11. development-server integration
12. platform autolinking
13. build and packaging requirements
14. upstream contribution expectations

Research findings should produce additional ADRs and technical spike documents.

## Final Position

SevynOS will treat React Native as a first-class platform target and its flagship application framework.

React Native will provide the preferred user-interface development experience.

The SevynOS SDK and Runtime will provide the underlying application platform.

React Native will not define the operating system.

It will be the clearest expression of what the operating system makes possible.
