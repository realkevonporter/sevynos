# ADR-0006: Use a Staged wlroots-Based Compositor Strategy for Genesis

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

ADR-0005 selected Wayland as the initial graphical client protocol for SevynOS.

The next decision is how Project Sevyn should create the compositor responsible for:

- display outputs
- graphical surfaces
- input routing
- focus
- window placement
- workspaces
- frame presentation
- trusted system surfaces
- Shell integration
- graphical security policy

Several implementation paths are available:

1. run SevynOS applications under an existing compositor
2. build a custom compositor using wlroots
3. build a custom compositor using libweston
4. modify or fork Weston
5. implement a compositor directly from lower-level Wayland, graphics, and input libraries

These options solve different problems.

Running under an existing compositor is the fastest way to validate the SevynOS React Native client and framework-host architecture, but it does not allow Project Sevyn to control the complete graphical environment.

A compositor framework can provide reusable infrastructure while allowing SevynOS to define its own Shell and policy.

wlroots describes itself as a modular Wayland compositor library. It implements common compositor functionality while allowing projects to select and compose the parts they need.

Weston provides libweston, whose primary purpose is to expose an API for creating Wayland compositors. Weston documentation also describes support for multiple backends, including nested Wayland, X11, and standalone DRM/KMS operation.

A direct implementation would offer maximum control but would require Project Sevyn to take immediate responsibility for a large amount of graphics, input, protocol, backend, and hardware integration work.

Genesis must balance two needs:

- prove the SevynOS application architecture quickly
- establish a credible path toward a SevynOS-owned graphical environment

## Decision

Project Sevyn will use a staged compositor strategy for the Genesis architecture.

### Stage 1: Existing compositor development

The first SevynOS React Native application and framework host will run as normal Wayland clients under an existing, standards-compatible Wayland compositor.

This stage will validate:

- Wayland connection and registry discovery
- application-surface creation
- React Native rendering
- input delivery
- resizing
- display scaling
- Runtime lifecycle integration
- clean startup and shutdown

The existing compositor is development infrastructure only.

It is not the SevynOS compositor and will not define the final SevynOS Shell, window behavior, permissions, or product identity.

### Stage 2: Minimal nested SevynOS compositor

Project Sevyn will create a minimal experimental compositor using wlroots.

The first compositor will initially run nested inside another Wayland session rather than controlling physical display hardware directly.

Its purpose will be to validate:

- the SevynOS compositor process
- surface management
- application-session association
- basic focus
- basic pointer and keyboard input
- one output
- Shell-owned surfaces
- launch and close behavior
- trusted compositor-to-Shell communication

### Stage 3: Standalone Genesis compositor

After the nested compositor works reliably, Project Sevyn will add a standalone backend suitable for a documented Genesis test machine or virtual machine.

This stage may introduce:

- DRM/KMS output
- libinput-based device input
- session management
- hardware-backed rendering
- display mode management
- basic multi-output preparation

The exact hardware and deployment environment will be defined in a separate ADR.

### Selected foundation

wlroots will be the initial compositor framework for the custom Genesis compositor.

Project Sevyn will not initially:

- fork Weston
- build directly on libweston
- implement the compositor entirely from scratch
- treat an existing desktop compositor as the final SevynOS graphical environment

The architectural rule is:

> Validate clients first, establish compositor ownership second, and add hardware control only after the platform boundaries work.

## Decision Summary

```text
Phase 1
Existing Wayland Compositor
        │
        └── SevynOS applications run as clients

Phase 2
Existing Wayland Compositor
        │
        └── Nested SevynOS compositor using wlroots
                  │
                  └── SevynOS applications

Phase 3
Linux DRM/KMS and Input Stack
        │
        └── Standalone SevynOS compositor using wlroots
                  │
                  ├── Sevyn Shell
                  └── SevynOS applications
```

## Rationale

### Separate application validation from compositor development

The React Native platform experiment should not depend on Project Sevyn already having a complete compositor.

The first technical question is:

> Can a React Native application render through a SevynOS-specific Wayland host and communicate with the Sevyn Runtime?

That question can be answered under an existing compositor.

This reduces the number of new systems being debugged simultaneously.

Without this separation, a rendering failure could originate from:

- the React Native renderer
- the framework host
- the Wayland client
- the custom compositor
- the graphics backend
- the GPU driver
- the Runtime integration

Using an established compositor during Stage 1 creates a known graphical server environment and narrows the problem.

### Early SevynOS ownership

Project Sevyn should not remain permanently dependent on the policies or architecture of an existing desktop environment.

SevynOS needs control over:

- Shell surfaces
- application identity
- window-management behavior
- trusted prompts
- screen capture
- input authorization
- workspace behavior
- mobile surface policies
- system overlays
- cross-device interaction

A custom compositor is therefore required for the long-term platform.

The staged strategy delays that work only until the client path has been validated.

### Modular starting point

wlroots provides reusable compositor building blocks rather than requiring Project Sevyn to adopt a complete existing desktop environment. Its upstream project describes the components as independently usable and composable.

This aligns with the SevynOS requirement to own product policy while reusing solved low-level infrastructure.

### Nested development

A nested compositor can operate as a Wayland client of an existing compositor while acting as the Wayland server for applications inside it.

This creates a practical development environment where the SevynOS compositor can be:

- launched from a normal developer session
- restarted without logging out
- debugged using standard tools
- displayed inside a window
- tested without direct control of the machine's display hardware

Weston's documented backend model demonstrates that nested and standalone compositor operation are established Wayland development patterns.

### Avoid premature low-level ownership

A completely direct implementation would require early decisions about:

- DRM/KMS
- input-device handling
- backend abstraction
- buffer allocation
- renderer integration
- protocol implementations
- output hotplug
- session switching
- GPU handling
- cursor rendering
- damage tracking
- frame scheduling

These are important but do not initially distinguish SevynOS.

Genesis should use existing, proven infrastructure while Project Sevyn develops the platform-specific layers above it.

### Preserve architectural independence

The compositor framework is an implementation dependency.

It must not become part of:

- the public SevynOS SDK
- the application manifest
- the Runtime application contract
- framework-host public APIs
- application lifecycle definitions

Applications should interact with SevynOS concepts rather than wlroots-specific APIs.

This allows the compositor implementation to be changed later without breaking applications.

## Why wlroots

### Component-oriented design

wlroots provides components for common Wayland compositor responsibilities while allowing the compositor project to define its own policy.

This is appropriate for SevynOS because Project Sevyn needs control over the user experience but does not need to recreate every backend and protocol primitive immediately.

### Custom Shell suitability

SevynOS requires a unique Shell rather than a lightly modified traditional Linux desktop.

A lower-policy compositor framework is preferable to inheriting an existing desktop Shell and attempting to remove its assumptions.

### Existing implementation examples

The wlroots ecosystem provides multiple real compositor implementations that can be studied for:

- backend initialization
- output management
- input handling
- scene composition
- XDG shell support
- nested operation
- protocol registration
- application focus

These projects should be treated as engineering references, not copied without understanding or license review.

### Backend flexibility

Genesis requires nested development first and standalone hardware operation later.

A compositor framework that supports multiple backend types reduces the architectural gap between those stages.

### Incremental adoption

Project Sevyn does not need to use every wlroots component.

The compositor can begin with:

- one backend
- one renderer
- one allocator
- one seat
- one output
- one application-surface protocol
- one scene representation

Additional features can be introduced only when required.

## Why Not libweston

libweston is a legitimate compositor-construction API. Its documentation explicitly identifies creating Wayland compositors as its primary purpose.

It also provides useful output, backend, repaint, and shell-related facilities.

However, it is not selected for Genesis for the following reasons.

### Closer relationship to Weston architecture

Using libweston would place SevynOS closer to Weston's internal object model and extension patterns.

That may be valuable for embedded or reference-compositor use cases, but Genesis should favor a foundation commonly used for independently designed compositors.

### Product architecture concerns

Project Sevyn needs a Shell and compositor structure that may eventually span:

- desktop
- mobile
- television
- embedded interfaces
- custom trusted surfaces
- application-session identity
- React Native system UI

The project should begin with a compositor framework that encourages defining this policy directly rather than adapting an existing reference compositor's Shell model.

### Continued reference value

Weston remains important to SevynOS as:

- a Wayland reference implementation
- a test environment
- a source of standards-oriented design examples
- a nested compositor
- a comparison implementation
- a protocol behavior reference

Not selecting libweston does not mean rejecting Weston as an engineering resource.

## Why Not Fork Weston

Forking Weston might produce a graphical environment quickly, but it would create immediate long-term ownership of a large external compositor codebase.

That could lead to:

- difficult upstream synchronization
- SevynOS behavior becoming entangled with Weston assumptions
- extensive patches that are hard to review
- delayed adoption of upstream fixes
- a product architecture defined by modification rather than deliberate design
- uncertainty over which changes should be upstreamed

Weston provides libweston specifically so third parties can build environments on its compositor core without necessarily turning Weston itself into their product.

If Project Sevyn later determines that libweston is a better foundation, that should be adopted deliberately through a superseding ADR rather than through an informal Weston fork.

## Why Not Build Directly From Scratch

A direct compositor implementation would maximize control.

It would also require Project Sevyn to independently integrate or implement:

- Wayland server objects
- protocol dispatch
- rendering
- buffer management
- DRM/KMS
- input devices
- output modes
- cursor handling
- frame timing
- surface trees
- damage tracking
- session management
- backend abstraction
- nested operation
- hardware acceleration

Wayland places significant authority in the compositor. It receives input, determines the target surface, and controls final presentation.

Implementing this incorrectly could create:

- crashes
- rendering corruption
- input leaks
- privilege mistakes
- unusable hardware configurations
- serious security flaws

A from-scratch implementation may become appropriate after Project Sevyn has:

- a stable Runtime
- a working React Native platform
- compositor expertise
- automated protocol tests
- performance measurements
- concrete requirements unmet by existing frameworks

It is not justified for Genesis.

## Architectural Boundaries

The compositor must remain independent from the Sevyn Runtime.

```text
┌───────────────────────────────────────┐
│            Sevyn Runtime              │
│                                       │
│ App Identity, Lifecycle, Permissions, │
│ Sessions, Packages, Process Ownership │
└──────────────────┬────────────────────┘
                   │ Authenticated
                   │ platform protocol
┌──────────────────▼────────────────────┐
│         SevynOS Compositor            │
│                                       │
│ Surfaces, Focus, Input, Outputs,      │
│ Presentation, Trusted UI Policy       │
└──────────────────┬────────────────────┘
                   │ Wayland
┌──────────────────▼────────────────────┐
│       Applications and Hosts          │
└───────────────────────────────────────┘
```

The Runtime should not depend directly on wlroots types.

The compositor should not become the source of truth for:

- installed applications
- permission grants
- package identity
- application lifecycle
- user accounts
- application process ownership

The two systems should communicate through a narrow, versioned interface.

## Compositor Process Model

The Genesis compositor should run as its own native process.

A conceptual process layout is:

```text
sevyn-runtime
    │
    ├── sevyn-shell
    │
    ├── sevyn-compositor
    │
    └── sevyn-rn-host
            │
            └── React Native application
```

The final process model may change.

The initial separation is intended to ensure that:

- a Shell crash does not automatically destroy Runtime state
- Runtime code does not directly depend on compositor libraries
- compositor failures are observable
- framework hosts remain distinct
- system boundaries remain understandable

For the earliest nested spike, the Shell may temporarily be implemented inside the compositor process if that significantly reduces complexity.

This exception must remain documented and must not make the Shell's TypeScript interface depend directly on wlroots.

## Language Strategy

The Genesis compositor will be implemented in C.

This follows wlroots' native API and minimizes the need to create an additional foreign-function layer before the compositor architecture works.

C++ or Rust may later be introduced for isolated components if they provide a clear benefit.

The Shell should still be implemented primarily in TypeScript and React Native.

The intended boundary is:

```text
TypeScript React Native Shell
             │
     Typed native interface
             │
C-based SevynOS compositor
             │
           wlroots
```

The Shell must not receive unrestricted access to raw compositor pointers or memory.

Communication should use a documented native module, IPC protocol, or controlled Wayland protocol.

## Initial Supported Protocols

The first nested compositor should expose only the protocols required for the demonstration.

The minimum set is expected to include:

- core Wayland compositor
- shared-memory support
- output information
- seat
- pointer
- keyboard
- XDG shell
- basic data-device support only if needed

The compositor should not advertise unsupported interfaces.

Wayland clients discover available global interfaces through the registry and bind to those made available by the server.

Protocol support must be added intentionally.

The first compositor does not need:

- Xwayland
- screen capture
- global shortcuts
- virtual keyboard
- tablet protocols
- remote desktop
- session locking
- advanced decorations
- idle inhibition
- color management
- fractional scaling
- output management UI
- drag and drop

Some of these may become necessary before Genesis is considered complete, but they should not block the first application surface.

## Shell Strategy

The initial Shell should be intentionally small.

It should include:

- a background surface
- one launcher control
- one application representation
- one basic window frame or surface container
- a close action
- a visible focus state
- a development status overlay

The Genesis Shell is not intended to resemble the final desktop.

Its purpose is to validate:

- Shell-to-Runtime launch requests
- Runtime-to-compositor session association
- compositor-to-Shell surface events
- trusted Shell surfaces
- input focus
- application close behavior

Visual polish should begin only after the boundaries work reliably.

## Nested Compositor Milestone

The nested compositor is complete when:

1. It launches inside an existing Wayland session.
2. It creates one nested output window.
3. The Sevyn Shell renders inside that output.
4. A React Native application connects to it.
5. The application creates an XDG surface.
6. The compositor associates that surface with a Runtime session.
7. Pointer input reaches the correct surface.
8. Keyboard focus is visible and predictable.
9. The application can be closed from the Shell.
10. The Runtime records the stopped state.
11. The compositor exits without leaving application processes behind.

## Standalone Compositor Milestone

The standalone Genesis compositor is complete when:

1. It starts without a parent graphical compositor.
2. It controls one documented output.
3. It receives keyboard and pointer input.
4. It launches the Sevyn Shell.
5. It launches one React Native application.
6. It displays both Shell and application surfaces.
7. Focus and close operations work.
8. It returns safely to a terminal or recovery environment after exit.
9. Startup and shutdown are documented.
10. Major crashes produce useful logs.

## Implementation Phases

### Phase 0: Research harness

Create small standalone experiments for:

- a native Wayland client
- Runtime session identity
- React Native surface rendering
- basic wlroots initialization

These experiments may live outside production packages temporarily.

### Phase 1: Wayland client validation

Run the React Native host under an existing compositor.

Deliverables:

```text
experiments/
├── wayland-client/
└── react-native-wayland-host/
```

Prove:

- surface creation
- rendering
- resize
- input
- shutdown

### Phase 2: Minimal nested compositor

Create:

```text
compositor/
├── include/
├── src/
├── tests/
├── protocols/
└── meson.build
```

Initial modules may include:

```text
main
server
backend
output
seat
input
xdg-shell
surface-registry
runtime-bridge
logging
```

### Phase 3: Shell integration

Add:

- trusted Shell connection
- application-surface events
- focus controls
- launch controls
- close controls
- minimal visual workspace

### Phase 4: Standalone backend

Add:

- direct display backend
- device input
- documented test hardware
- safe startup and shutdown
- recovery instructions

### Phase 5: Architecture review

Evaluate:

- dependency boundaries
- performance
- memory use
- crash behavior
- security assumptions
- upstream maintenance cost
- suitability for future touch devices

The findings should determine whether Genesis continues with wlroots or requires a superseding decision.

## Repository Direction

A possible initial structure is:

```text
SevynOS/
├── compositor/
│   ├── include/
│   ├── src/
│   │   ├── backend/
│   │   ├── input/
│   │   ├── output/
│   │   ├── protocols/
│   │   ├── runtime/
│   │   ├── surfaces/
│   │   └── main.c
│   ├── tests/
│   ├── meson.build
│   └── README.md
│
├── shell/
├── runtime/
├── hosts/
│   └── react-native/
└── experiments/
    ├── wayland-client/
    └── nested-compositor/
```

The exact build structure will be decided when the monorepo tooling ADR is written.

## Dependency Policy

wlroots must remain a replaceable implementation dependency.

Project Sevyn should:

- pin known compatible versions
- record build options
- track upstream release changes
- avoid depending on undocumented internal symbols
- isolate wlroots usage inside the compositor package
- wrap important compositor operations in SevynOS-owned types
- maintain integration tests
- document required protocols
- evaluate security advisories
- contribute general fixes upstream where appropriate

Project Sevyn should not expose public APIs named after:

- `wlr_*` structures
- wlroots backend objects
- wlroots scene nodes
- wlroots-specific event types

Public platform APIs should use SevynOS-owned terminology.

## Upstream Strategy

Project Sevyn should avoid carrying unnecessary patches.

The preferred order is:

1. use public wlroots APIs
2. design SevynOS code around supported extension points
3. report reproducible upstream bugs
4. contribute broadly useful fixes upstream
5. maintain a temporary patch only when necessary
6. document every carried patch
7. remove patches once upstream solutions are available

SevynOS-specific policy does not belong upstream unless it reveals a generally useful compositor capability.

## Security Considerations

The compositor is a trusted system component.

A compromised compositor could potentially:

- observe displayed content
- observe or redirect input
- impersonate system surfaces
- interfere with application windows
- misuse capture functionality
- undermine visual security indicators

The compositor must therefore:

- minimize dependencies
- validate client requests
- expose only required protocols
- distinguish Shell clients from ordinary clients
- authenticate Runtime communication
- avoid trusting client-provided application identity
- handle malformed surfaces safely
- release resources when clients disconnect
- avoid unrestricted debug interfaces in production
- maintain structured security logs

Wayland surfaces do not themselves provide authenticated SevynOS application identity.

That association must come from the Runtime through a trusted channel.

## Testing Strategy

The compositor should have several layers of testing.

### Unit tests

Test SevynOS-owned logic such as:

- surface-to-session association
- focus policy
- state transitions
- permission decisions
- Runtime message validation
- Shell command validation

### Protocol tests

Create test clients that:

- connect and disconnect
- create valid surfaces
- send malformed requests
- create multiple surfaces
- destroy surfaces unexpectedly
- exit during configuration
- attempt unsupported protocols

### Nested integration tests

Launch the compositor nested and verify:

- output creation
- client launch
- frame presentation
- input routing
- application close
- compositor shutdown

### Crash tests

Force failure of:

- the Shell
- an application
- the React Native host
- the Runtime bridge
- the compositor backend

Verify that failures are reported clearly and do not leave uncontrolled processes.

### Future hardware tests

Standalone hardware tests should verify:

- output initialization
- hotplug behavior
- input-device discovery
- suspend and resume
- GPU reset behavior
- shutdown recovery

## Performance Measurements

Genesis should record:

- compositor startup time
- time to nested output
- time to first Shell frame
- application surface creation time
- input-to-frame latency
- idle CPU use
- idle memory use
- frame misses
- application resize latency
- shutdown time

The goal is not immediate optimization.

The goal is to ensure the staged architecture does not introduce avoidable delays or resource use.

## Consequences

### Positive consequences

- React Native rendering can be validated before the compositor exists.
- Project Sevyn gains ownership of compositor policy during Genesis.
- wlroots reduces the amount of low-level infrastructure that must be created immediately.
- Nested development avoids disrupting the developer's primary desktop session.
- The Runtime remains independent from the graphics framework.
- The Shell remains conceptually separate from the compositor.
- The implementation can progress incrementally.
- Weston remains available as a reference and test environment.
- A future standalone compositor can evolve from the nested implementation.
- The project avoids an early long-lived Weston fork.
- The project avoids prematurely implementing every low-level graphical subsystem.

### Negative consequences

- Genesis still requires native C and Wayland expertise.
- wlroots upgrades may require compositor changes.
- The staged approach temporarily supports two environments: an external compositor and the SevynOS compositor.
- Nested behavior may differ from direct hardware behavior.
- Some compositor policy must be designed earlier than application developers may expect.
- Debugging may cross Runtime, Shell, compositor, host, and application processes.
- The project will eventually need direct hardware and session-management expertise.
- wlroots-specific assumptions may accidentally leak into SevynOS code without strict review.

### Risks

The primary risk is that the temporary Stage 1 environment becomes permanent and the custom compositor is continually postponed.

To reduce this risk:

- Stage 1 must have explicit completion criteria
- compositor work must begin immediately after client validation
- the nested compositor must be part of Genesis
- architecture documents must not describe an external compositor as SevynOS
- Shell-specific features must not be implemented against another desktop's private APIs

A second risk is treating wlroots as the architecture instead of as an implementation tool.

To reduce this risk:

- public types must remain SevynOS-owned
- Runtime interfaces must not expose wlroots
- Shell APIs must remain independent
- architecture tests should enforce package boundaries
- the compositor dependency should be reevaluated at the end of Genesis

## Alternatives Considered

### Existing compositor only

This would provide the fastest path to displaying applications.

It was rejected as the complete Genesis strategy because SevynOS would not control:

- trusted Shell surfaces
- window behavior
- input policy
- application-session association
- security-sensitive graphical capabilities
- future mobile interaction

An existing compositor will be used only for the first development stage.

### wlroots immediately on physical hardware

This would establish compositor ownership earlier.

It was rejected as the first step because it would combine:

- client development
- compositor development
- DRM/KMS
- device input
- session management
- GPU integration

into one debugging problem.

Nested operation provides a safer and more productive intermediate step.

### libweston-based compositor

This remains technically viable.

It was not selected because Genesis favors wlroots' modular compositor-building model and its fit with independently designed compositors.

Weston and libweston should remain part of the evaluation and testing strategy.

### Weston fork

This was rejected because it would create extensive ownership of another compositor's product architecture and complicate upstream synchronization.

### Direct implementation

This was rejected for Genesis because it adds major low-level scope before SevynOS has validated its application and Shell requirements.

### Rust compositor framework

A Rust-based compositor framework may offer memory-safety benefits.

It was not selected because introducing Rust, a Rust compositor framework, React Native native integration, Wayland, and the Runtime simultaneously would increase the number of new technologies in the Genesis critical path.

Rust compositor options may be evaluated after the first compositor boundary has been validated.

## Validation Criteria

This decision will be validated when:

1. A React Native application runs under an existing Wayland compositor.
2. The application renders through a SevynOS-owned framework host.
3. A minimal wlroots compositor runs nested.
4. The React Native application runs inside that compositor.
5. The compositor identifies the application's Runtime session through a trusted path.
6. The Shell launches and closes the application through Runtime APIs.
7. Runtime code contains no wlroots dependencies.
8. Shell TypeScript code contains no raw wlroots dependencies.
9. The same compositor can begin transitioning toward a standalone backend.
10. Genesis measurements show acceptable architectural overhead.
11. The project can update its pinned wlroots version without redesigning public APIs.
12. A post-Genesis review confirms that wlroots remains the appropriate foundation.

## Revisit Conditions

This decision should be reconsidered if:

- wlroots cannot support a critical SevynOS requirement
- wlroots maintenance or API changes become unsustainable
- mobile or embedded requirements cannot be implemented reasonably
- security policy requires a different compositor architecture
- hardware compatibility is inadequate
- React Native rendering performance is unacceptable
- nested and standalone behavior diverge significantly
- libweston or another framework demonstrates a clearly superior path
- Project Sevyn develops sufficient expertise and requirements to justify direct implementation

A replacement must preserve the SevynOS-owned Runtime, Shell, application, and SDK interfaces wherever possible.

## Immediate Implementation Tasks

Project Sevyn should now:

1. Create a native Wayland client experiment.
2. Display a simple surface under an existing compositor.
3. Receive configure, pointer, and keyboard events.
4. Connect the React Native host to that surface.
5. Create the `compositor/` package.
6. Add wlroots as an isolated native dependency.
7. Launch a minimal nested compositor.
8. Support one output and one seat.
9. Implement XDG application surfaces.
10. Add a Runtime-session association prototype.
11. Render a minimal React Native Shell surface.
12. Launch one React Native application inside the nested compositor.
13. Record startup, frame, memory, and shutdown measurements.
14. Document all unsupported protocols and temporary assumptions.
15. Create ADR-0007 defining the application manifest.

## Final Position

Genesis will not begin by building an entire graphical stack from scratch.

It will first prove that SevynOS applications can render as proper Wayland clients.

Project Sevyn will then build a minimal nested compositor using wlroots and evolve it toward standalone operation.

Weston will remain a standards reference and test environment.

wlroots will provide reusable compositor infrastructure.

SevynOS will own the policy, security boundaries, Shell, and user experience.

We will validate the window first.

Then we will build the world around it.
