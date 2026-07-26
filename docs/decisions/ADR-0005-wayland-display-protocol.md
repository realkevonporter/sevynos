# ADR-0005: Use Wayland as the Initial Display Protocol

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

SevynOS requires a graphical architecture capable of supporting:

- application windows and surfaces
- multiple displays
- pointer, keyboard, touch, and stylus input
- display scaling
- application isolation
- compositing
- animations and visual effects
- screen capture and sharing
- accessibility
- desktop, mobile, television, and embedded interfaces

The graphical system must connect several major SevynOS components:

```text
Applications
     │
Framework Hosts
     │
Application Surfaces
     │
Sevyn Shell and Compositor
     │
Graphics and Input Stack
     │
Linux Kernel
     │
Display Hardware
```

Project Sevyn must choose an initial display protocol and architecture before implementing the Shell, window management, application surfaces, input routing, or the React Native renderer integration.

The primary Linux display-system options are:

- Wayland
- X11
- a completely custom display protocol
- direct rendering without a standardized client protocol
- a graphics architecture inherited from another platform

Wayland defines communication between graphical clients and a compositor. In the Wayland architecture, the compositor is the display server, receives input through the underlying system, sends relevant input events to clients, and presents client-rendered surfaces.

Wayland is a protocol and system architecture, not a complete desktop environment or user interface. Choosing Wayland does not determine the appearance, behavior, window-management policy, or product identity of SevynOS.

## Decision

SevynOS will use Wayland as its initial graphical client protocol.

Native graphical applications and framework hosts will communicate with the SevynOS compositor through Wayland-compatible interfaces where appropriate.

The first graphical implementation will use a Wayland compositor architecture for:

- creating and presenting application surfaces
- routing supported input events
- managing display outputs
- coordinating frame presentation
- handling window and surface roles
- integrating application windows with the Sevyn Shell

SevynOS will define its own compositor policy, shell behavior, application lifecycle integration, security rules, user experience, and platform-specific protocols.

The decision to use Wayland does not yet decide whether Project Sevyn will:

- build a compositor directly using Wayland libraries
- use wlroots
- extend Weston
- use another compositor framework
- begin with an existing compositor for prototyping
- create a custom compositor framework later

That implementation decision will receive a separate ADR after a technical evaluation.

The architectural rule is:

> Wayland defines how graphical clients communicate with the compositor. SevynOS defines how the graphical environment behaves.

## Terminology

### Wayland protocol

Wayland is an asynchronous, object-oriented protocol used for communication between clients and a compositor. Protocol objects implement interfaces and exchange requests and events.

### Wayland client

A Wayland client is a process connected to the compositor.

A client may be:

- an individual native application
- a React Native framework host
- a web application host
- a system interface component
- an Xwayland compatibility process
- another graphical subsystem

A SevynOS application does not necessarily need to communicate with Wayland directly. A framework host may own the Wayland connection and graphical surfaces on behalf of the application.

### Wayland compositor

A Wayland server is called a compositor. It acts as both the display server and the component responsible for composing application surfaces into the final displayed image.

For SevynOS, the compositor will also participate in:

- Shell integration
- workspace management
- window placement
- focus
- input routing
- display configuration
- visual transitions
- application-surface policy

### Sevyn Shell

The Sevyn Shell is the user-facing system interface.

It may provide:

- desktop or home screen
- launcher
- taskbar or dock
- application switcher
- window decorations
- quick settings
- notification center
- lock screen
- system overlays
- workspace controls

The Shell and compositor may initially run within the same process, but they must remain conceptually separate.

The compositor owns trusted graphical policy.

The Shell presents and controls the user experience through defined interfaces.

## Rationale

### Modern Linux graphics architecture

Wayland provides a modern client-compositor architecture designed around contemporary graphics and input systems.

Clients render their own content and submit surfaces to the compositor. The compositor controls final presentation, input routing, surface placement, and system-wide composition.

This aligns with SevynOS requirements for:

- application-owned rendering
- compositor-controlled presentation
- strong graphical policy
- modern GPU acceleration
- multiple application frameworks
- centralized input and window management

### Stronger isolation model than traditional X11

The graphical server should not automatically expose every application's input and displayed content to every other graphical client.

Wayland's client-compositor design gives the compositor authority over which interfaces and resources are exposed to clients.

Sensitive capabilities such as:

- global keyboard shortcuts
- screen capture
- input injection
- window inspection
- remote control
- screen sharing

should be exposed through explicit SevynOS permissions and controlled protocols rather than unrestricted global access.

Wayland alone does not create the complete SevynOS security model. The compositor, portals, Runtime, permissions service, and protocol choices must enforce that model.

### Compositor ownership

Wayland allows SevynOS to own the compositor instead of building its product experience around a separate display server and window manager.

This enables Project Sevyn to design:

- window behavior
- application transitions
- workspaces
- tiling or floating policies
- mobile application surfaces
- system overlays
- multitasking
- display switching
- touch gestures
- Shell animations

as part of one coherent platform.

### Framework independence

Wayland is not tied to React Native.

A React Native host, native application, web host, game engine, or future framework can produce graphical surfaces through the appropriate platform integration.

This supports ADR-0004, which requires the Sevyn Runtime to remain framework-independent.

### Existing ecosystem

Wayland provides established protocol libraries, standardized extension protocols, debugging utilities, compositors, compositor frameworks, input integration, and compatibility technologies.

The core protocol supports discovery of compositor-provided global interfaces through the Wayland registry. Clients bind only to interfaces made available by the compositor.

This gives SevynOS a proven foundation while allowing it to define additional interfaces where standard protocols are insufficient.

### Cross-device suitability

Wayland compositors can take different roles and forms. The architecture can support system compositors, session compositors, desktop environments, embedded interfaces, and specialized devices.

SevynOS can therefore implement different Shell policies for:

- desktop
- phone
- tablet
- watch
- television
- vehicle
- kiosk
- embedded display

while retaining a shared graphical protocol foundation.

### Compatibility path

Xwayland can allow traditional X11 applications to operate as clients inside a Wayland environment. X11 applications connect to Xwayland, while Xwayland communicates with the compositor as a Wayland client.

Xwayland is not required for the Genesis milestone, but it provides a possible future compatibility path for existing Linux applications.

## Architectural Model

```text
┌──────────────────────────────────────────────┐
│                 Applications                 │
│                                              │
│ React Native │ Native │ Web │ Games │ Other  │
└───────┬──────────┬───────┬───────┬───────────┘
        │          │       │       │
┌───────▼──────────▼───────▼───────▼───────────┐
│              Framework Hosts                 │
│                                              │
│ RN Host │ Native Adapter │ Web Host │ Engine │
└──────────────────────┬───────────────────────┘
                       │
                       │ Wayland and
                       │ SevynOS protocols
                       │
┌──────────────────────▼───────────────────────┐
│          SevynOS Compositor Layer            │
│                                              │
│ Surfaces, Input, Focus, Outputs, Composition,│
│ Security Policy, Capture, Presentation       │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│                Sevyn Shell                   │
│                                              │
│ Launcher, Windows, Workspaces, System UI,    │
│ Notifications, Overlays, Multitasking        │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│        Graphics, Input and Device Stack      │
│                                              │
│ DRM/KMS, Mesa, EGL/Vulkan, libinput, udev    │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│                Linux Kernel                  │
└──────────────────────────────────────────────┘
```

The exact libraries shown in this diagram remain implementation candidates rather than permanent selections.

## Separation of Responsibilities

### Sevyn Runtime

The Runtime owns:

- application identity
- application lifecycle
- permissions
- application sessions
- package information
- application-host selection
- resource policy
- process ownership

The Runtime should not implement drawing, window placement, or input-device processing.

### Framework host

A framework host owns framework-specific rendering integration.

For the React Native host, responsibilities may include:

- creating a Wayland surface
- connecting Fabric output to that surface
- forwarding surface dimensions
- translating input into React Native events
- responding to scale changes
- notifying the Runtime of graphical failures
- destroying surfaces at shutdown

### Compositor

The compositor owns trusted graphical state, including:

- outputs
- seats and input devices
- surfaces
- focus
- stacking
- workspaces
- surface roles
- final composition
- frame scheduling
- capture authorization
- Shell-level graphical policy

### Shell

The Shell owns user-facing interaction policy, including:

- how applications are launched
- how windows appear
- where windows are positioned
- how applications are switched
- how workspaces behave
- how system surfaces are presented
- how notifications appear
- how the lock screen behaves

The Shell should request privileged compositor operations through a private, authenticated system interface.

### Applications

Applications own their content.

Applications should not control:

- global focus
- other applications' positions
- unrestricted screen capture
- system overlays
- arbitrary input injection
- trusted authentication surfaces
- lock-screen content without authorization

## Standard and SevynOS-Specific Protocols

SevynOS should prefer standard Wayland protocols whenever they meet platform requirements.

Potential standard protocol areas include:

- application surfaces
- shared memory buffers
- output information
- input seats
- pointer constraints
- relative pointer input
- presentation timing
- fractional scaling
- decorations
- activation
- text input
- tablet input
- data transfer
- idle behavior

Not every existing extension should automatically be supported.

Each protocol should be evaluated for:

- security
- stability
- device applicability
- maintenance status
- implementation cost
- developer value
- compatibility requirements

SevynOS-specific protocols may be created for capabilities such as:

- Runtime application-session identity
- trusted Shell surfaces
- system overlays
- application lifecycle coordination
- secure screen capture
- cross-device window state
- mobile surface roles
- application restoration
- capability-aware surface behavior
- SevynOS developer tooling

Custom protocols should be narrowly scoped and documented.

Project Sevyn should avoid creating custom protocols where an appropriate stable standard already exists.

## Surface Model

A SevynOS application may own one or more graphical surfaces.

A surface is not automatically equivalent to a complete application.

For example, an application may have:

- a primary window
- a secondary window
- a context menu
- a popup
- a notification-related surface
- a picture-in-picture surface
- a drag-and-drop icon
- an embedded surface

The Runtime owns the application session.

The compositor owns graphical surfaces.

The Shell determines how application surfaces are represented to the user.

A conceptual association may resemble:

```ts
type SurfaceAssociation = {
  applicationId: string;
  sessionId: string;
  surfaceId: string;
  role: "primary" | "secondary" | "dialog" | "popup" | "overlay" | "picture-in-picture";
};
```

This is illustrative and is not a final public API.

## Window Management

Wayland does not define the complete SevynOS window-management experience.

Project Sevyn must define policies for:

- floating windows
- tiling
- maximization
- full-screen behavior
- minimizing
- workspaces
- multiple displays
- modal dialogs
- always-on-top surfaces
- picture-in-picture
- mobile full-screen applications
- split-screen applications
- system overlays
- application restoration

These policies belong to SevynOS, not to React Native or individual applications.

Applications may request states.

The Shell and compositor retain authority to accept, reject, or adapt those requests according to device capabilities and user preferences.

## Input Architecture

The compositor should receive input from the underlying input stack and route events to the correct graphical client.

Potential input types include:

- keyboard
- mouse
- touch
- trackpad
- stylus
- game controller
- remote control
- rotary input
- accessibility devices

Input focus must be owned by the compositor.

Applications must not be allowed to observe unrelated input without explicit authorization.

Global shortcuts should be handled by a trusted SevynOS component.

Input-method editors, virtual keyboards, accessibility services, and remote-control capabilities will require carefully designed privileged interfaces.

The exact input stack will be decided separately, though libinput is a strong initial candidate for supported Linux input devices.

## Security and Privacy

Wayland is one part of the graphical security architecture, not the entire security solution.

SevynOS must define explicit permission paths for:

### Screen capture

An application requesting a screenshot, screen recording, or screen-sharing stream should not receive unrestricted access automatically.

A trusted service should:

1. verify the requesting application's identity
2. confirm permission
3. allow the user to select a display, window, or region
4. issue a restricted capture capability
5. display an active-capture indicator
6. revoke access when the session ends

### Input injection

Synthetic input must require elevated authorization.

Ordinary applications must not be able to impersonate the user or control unrelated applications.

### Global shortcuts

Applications should register global shortcuts through a controlled service rather than intercepting all keyboard input.

### Clipboard

Clipboard access should be scoped to appropriate focus and user interaction rules.

Sensitive clipboard data may require additional protections.

### Trusted surfaces

Authentication prompts, permission dialogs, lock-screen controls, and security indicators must use compositor-recognized trusted surfaces that ordinary applications cannot imitate perfectly.

### Protocol exposure

The compositor should expose only the protocol globals appropriate for a client's trust level and application session.

## React Native Integration

The React Native SevynOS host will initially act as a Wayland client.

A possible flow is:

```text
React Native Application
        │
Fabric Render Tree
        │
SevynOS React Native Renderer
        │
React Native Host Surface
        │
Wayland Client Connection
        │
SevynOS Compositor
        │
Display
```

The React Native host may manage one or more Wayland surfaces for each application session.

The host must coordinate with the Runtime so that every surface can be associated with:

- an authenticated application
- a valid session
- granted capabilities
- lifecycle state
- device policy

A Wayland connection by itself must not establish a trusted SevynOS application identity.

## Compositor Implementation Strategy

This ADR chooses Wayland but does not select the compositor implementation.

The Genesis technical spike should compare at least:

### wlroots

A modular compositor library that provides implementations of many common Wayland compositor features while allowing projects to compose only the parts they need.

Potential advantages:

- modular architecture
- existing compositor ecosystem
- support for common backends and protocols
- faster path to a working custom compositor
- strong fit for experimentation

Potential concerns:

- API stability and upgrade maintenance
- ownership of security policy
- fit with future phone and embedded targets
- dependency on project-specific extensions
- need for C expertise

### Weston

Weston is a reference Wayland compositor implementation and may provide a useful standards-oriented development base.

Potential advantages:

- close relationship with Wayland development
- reference implementation value
- useful embedded use cases
- established architecture

Potential concerns:

- adapting it into a unique SevynOS product architecture
- Shell customization model
- React Native integration strategy
- long-term maintainability of extensive modifications

### Direct implementation

Project Sevyn could build directly with core Wayland libraries and selected graphics/input libraries.

Potential advantages:

- complete architectural control
- minimal unnecessary policy
- precise SevynOS integration

Potential concerns:

- substantially larger implementation scope
- increased graphics and input complexity
- slower prototype progress
- greater security and correctness burden

### Existing compositor during prototyping

The first React Native rendering spike may run as a normal Wayland client under an existing compositor.

This can validate:

- surface creation
- rendering
- input
- scaling
- lifecycle coordination
- framework-host integration

before Project Sevyn builds its own compositor.

This does not replace the eventual SevynOS compositor.

## X11 Compatibility

X11 will not be the native SevynOS display protocol.

Future versions may support X11 applications through Xwayland.

Potential benefits include:

- compatibility with existing Linux applications
- access to developer tools
- easier transition during early desktop development
- broader software availability

Potential costs include:

- additional attack surface
- legacy behavior
- inconsistent window semantics
- integration complexity
- visual inconsistency
- increased maintenance
- possible user confusion between native and compatibility applications

Xwayland support should be optional and separately governed.

The Genesis prototype does not require it.

## Cross-Device Strategy

The Wayland protocol foundation may be shared while Shell and compositor policies differ across devices.

```text
                    Wayland Foundation
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
Desktop Compositor   Mobile Compositor    TV Compositor
       │                   │                   │
Desktop Shell        Touch Shell          Remote Shell
```

This does not necessarily require separate compositor codebases.

Project Sevyn should maximize shared infrastructure while allowing device-specific policy modules.

Examples:

### Desktop

- floating and tiled windows
- keyboard and pointer input
- multiple displays
- workspaces
- drag and drop

### Phone

- primarily full-screen surfaces
- touch gestures
- split-screen multitasking
- rotation
- virtual keyboard
- application cards

### Television

- full-screen applications
- remote-control navigation
- focus-based input
- overscan handling
- media overlays

### Watch

A watch may not need the full desktop Wayland protocol set.

The project should evaluate whether a constrained compositor architecture is appropriate when watch development begins.

## Prototype Scope

The Genesis milestone should remain narrow.

### Included

- execution as a Wayland client under an existing compositor
- one graphical React Native application
- creation of one application surface
- basic pointer or keyboard input
- resize handling
- display scale awareness
- frame presentation
- clean surface destruction
- documented client-compositor boundary
- initial compositor-framework research

### Optional

- a minimal experimental SevynOS compositor
- one Shell-owned system surface
- basic application-window movement
- basic focus management
- one display output

### Not included

- production compositor
- mobile compositor
- advanced window animations
- multiple graphics backends
- complete accessibility stack
- secure screen-sharing portal
- full clipboard management
- virtual keyboard
- Xwayland
- remote desktop
- color management
- HDR
- variable refresh rate
- production multi-GPU support
- complete multi-display management

## Initial Technical Demonstration

The first graphical demonstration should prove:

1. A React Native framework host connects as a Wayland client.
2. The host creates an application surface.
3. React Native content is rendered into that surface.
4. The surface can be resized.
5. At least one input event reaches React Native.
6. Display-scale information is available.
7. Closing the window requests application termination through the Runtime.
8. The surface is destroyed cleanly.
9. Runtime identity remains separate from the Wayland client identity.
10. The implementation does not depend on X11.

## Performance Requirements

The graphics architecture must eventually measure:

- time to first surface
- time to first rendered frame
- frame latency
- missed frames
- input-to-display latency
- compositor CPU usage
- compositor GPU usage
- application GPU usage
- buffer allocation
- resize performance
- multi-window performance
- idle resource usage
- display memory consumption

The Genesis milestone does not need final production performance.

It must establish enough instrumentation to detect major architectural problems.

## Consequences

### Positive consequences

- SevynOS gains a modern Linux graphical foundation.
- The platform can own its compositor and Shell behavior.
- React Native and other frameworks can share one surface protocol.
- Input and final presentation remain under trusted compositor control.
- The architecture supports desktop, mobile, embedded, and specialized devices.
- Existing Wayland libraries and tools can accelerate development.
- Standard protocols may reduce unnecessary custom work.
- X11 compatibility remains possible through Xwayland.
- SevynOS can define its own security and window-management policies.
- The graphics architecture remains independent from the Runtime and application framework.

### Negative consequences

- Project Sevyn must implement or adapt a compositor.
- Wayland intentionally leaves many desktop policies outside the core protocol.
- Some required capabilities depend on extension protocols.
- Protocol compatibility requires ongoing maintenance.
- Screen sharing, global shortcuts, automation, and input methods require additional trusted services.
- Existing X11 applications may require Xwayland.
- Graphics failures may span the application, framework host, compositor, GPU drivers, and kernel.
- Mobile and desktop policies may require substantially different Shell behavior.
- Compositor development requires specialized systems and graphics knowledge.
- Supporting proprietary GPU drivers may introduce additional complexity.

### Risks

The largest risk is mistaking the selection of Wayland for the completion of the graphical architecture.

Wayland does not define:

- the SevynOS user experience
- the complete security policy
- application identity
- the Runtime lifecycle
- window-management behavior
- permission dialogs
- screen-sharing authorization
- application restoration
- React Native rendering
- system accessibility

Project Sevyn must design those layers deliberately.

Another risk is exposing too many unstable or compositor-specific protocols to application developers.

To reduce that risk:

- public applications should primarily use the SevynOS SDK
- framework hosts should isolate low-level protocol details
- custom protocols should remain narrow
- standard protocols should be preferred when appropriate
- unstable interfaces must not become permanent public contracts accidentally
- protocol versions must be tracked explicitly
- compatibility tests should be automated

## Alternatives Considered

### X11

X11 provides broad compatibility and a mature Linux software ecosystem.

It was rejected as the native SevynOS graphical architecture because:

- its trust model does not align well with application isolation goals
- the server and window-manager architecture carries significant legacy behavior
- modern Linux graphics development has shifted toward Wayland
- SevynOS wants compositor-owned presentation and policy
- designing a new platform around X11 would create unnecessary long-term constraints

X11 applications may still be supported through Xwayland.

### Custom display protocol

A completely custom protocol would give Project Sevyn full control.

It was rejected for the initial platform because it would require SevynOS to independently design and maintain:

- client-server transport
- surface lifecycles
- buffer sharing
- input routing
- output discovery
- synchronization
- protocol generation
- debugging tools
- toolkit integrations
- compatibility layers

SevynOS should create custom extensions only where its requirements are not met by existing protocols.

### Direct framebuffer or DRM rendering

Applications could render directly to display hardware.

This was rejected for general application use because it would prevent coherent:

- multitasking
- input routing
- application isolation
- window management
- overlays
- composition
- capture controls
- multi-application presentation

Direct display access may still be appropriate for boot graphics, recovery environments, or specialized trusted components.

### Use an existing desktop environment unchanged

SevynOS could run its applications inside an existing environment such as GNOME or KDE.

This may be useful during early development, but it was rejected as the final architecture because Project Sevyn must define its own:

- Shell
- compositor policy
- application lifecycle integration
- permission experience
- cross-device behavior
- product identity

### Use Android's graphical stack

Android provides a mature mobile graphics, composition, and input stack.

It was rejected as the primary graphical architecture because it would introduce Android-specific lifecycle, service, packaging, and hardware assumptions into SevynOS.

Selected Android components may be researched later for mobile hardware enablement, but they will not define native SevynOS applications.

## Validation Criteria

This decision will be validated when:

1. A React Native application renders through a Wayland-native path.
2. The application does not require X11.
3. Input is routed through the compositor environment.
4. Surface resizing works.
5. Display scale information reaches the framework host.
6. Application shutdown destroys the surface cleanly.
7. The Runtime remains independent from Wayland-specific concepts.
8. The Shell can identify the application session associated with a surface.
9. A compositor implementation path is selected through a separate ADR.
10. The architecture appears viable for desktop and future touch-oriented devices.

## Revisit Conditions

This decision should be reconsidered if:

- Wayland prevents a critical SevynOS requirement
- the protocol ecosystem becomes incompatible with Project Sevyn's goals
- required hardware cannot be supported
- compositor complexity becomes unsustainable
- React Native integration cannot meet performance requirements
- another display architecture provides substantially stronger cross-device support
- security requirements cannot be implemented reasonably
- Linux graphical architecture changes materially

Reconsidering this decision would require a migration strategy for native applications and framework hosts.

## Immediate Implementation Tasks

Project Sevyn should next:

1. Build a minimal native Wayland client.
2. Create and display one surface.
3. Handle configure and resize events.
4. Receive pointer and keyboard input.
5. Evaluate shared-memory and GPU-backed rendering paths.
6. Run a minimal React Native rendering experiment inside the surface.
7. Define the relationship between Runtime sessions and graphical surfaces.
8. Evaluate wlroots, Weston, and direct compositor implementation.
9. Document the compositor security boundary.
10. Create ADR-0006 selecting the initial compositor implementation strategy.

## Final Position

SevynOS will use Wayland as its initial graphical client protocol.

Wayland provides the communication foundation between graphical clients and the compositor.

It does not define the SevynOS experience.

Project Sevyn will own:

- the compositor policy
- the Shell
- application identity
- permissions
- lifecycle integration
- window behavior
- trusted graphical interfaces
- cross-device user experience

Wayland will carry the surfaces.

SevynOS will define what they become.
