# ADR-0008: Define the SevynOS Application Lifecycle

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

SevynOS needs a consistent way to describe and control the state of every running application.

An application may:

- be installed but not running
- begin launching
- display one or more surfaces
- move into the background
- become temporarily suspended
- resume
- shut down normally
- fail during startup
- crash unexpectedly
- be forcefully terminated
- be restored after a restart

These behaviors must remain consistent across application frameworks.

A React Native application, native application, web application, or future WebAssembly application may handle lifecycle events differently internally, but the Sevyn Runtime must expose one platform-wide application model.

Without a defined lifecycle, different framework hosts may implement incompatible behavior for:

- launching
- background execution
- suspending
- restoring
- closing
- crash reporting
- resource cleanup

The Runtime must therefore be the authoritative source of application lifecycle state.

## Decision

SevynOS will define a framework-independent application lifecycle managed by the Sevyn Runtime.

The Runtime owns:

- the official lifecycle state
- lifecycle transition validation
- application sessions
- launch and stop requests
- timeout handling
- crash detection
- resource cleanup
- state notifications
- restoration metadata

Framework hosts translate Runtime lifecycle commands into framework-specific behavior.

The Shell may request lifecycle operations and display application state, but it does not own the lifecycle.

The core rule is:

> The Runtime owns application lifecycle state. Framework hosts implement lifecycle behavior.

## Application, Process, Surface, and Session

These concepts must remain separate.

### Application

An application is an installed software package identified by its immutable application ID.

Example:

```text
org.sevynos.settings
```

An application can exist without currently running.

### Process

A process is an operating-system execution unit.

An application session may use:

- one process
- multiple processes
- a shared framework-host process
- helper processes
- service processes

The lifecycle model must not assume that one application always equals one process.

### Surface

A surface is a graphical object presented through the compositor.

An application may have:

- no visible surface
- one surface
- multiple windows or surfaces
- temporary popup surfaces
- background execution without a surface

Closing a surface does not always mean stopping the application.

### Session

An application session represents one active Runtime-managed execution of an application.

Each launch creates or reuses a session according to manifest policy.

A session has a unique identifier.

Example:

```ts
type ApplicationSessionId = string;
```

A conceptual session record may resemble:

```ts
type ApplicationSession = {
  id: ApplicationSessionId;
  applicationId: string;
  applicationType: string;
  state: ApplicationLifecycleState;
  startedAt: string;
  updatedAt: string;
  hostId?: string;
  processIds: number[];
  surfaceIds: string[];
};
```

This type is illustrative and not yet a final public API.

## Lifecycle States

The initial lifecycle state machine contains the following states:

```ts
type ApplicationLifecycleState =
  | "installed"
  | "starting"
  | "running"
  | "background"
  | "suspending"
  | "suspended"
  | "resuming"
  | "stopping"
  | "stopped"
  | "failed"
  | "crashed"
  | "terminated";
```

Not every state represents an active process.

## State Definitions

### `installed`

The application is installed and recognized by the Runtime but has no active session.

The Runtime has validated:

- the application manifest
- application identity
- application type
- entry point
- basic compatibility

No application code is running.

### `starting`

The Runtime has accepted a launch request and is creating an application session.

During this state, the Runtime may:

- validate the manifest
- select a framework host
- verify permissions
- prepare storage
- prepare the sandbox
- start or contact the host
- create processes
- pass launch information
- wait for readiness

The application is not considered usable yet.

### `running`

The application is active and available for normal execution.

A graphical application in this state usually has at least one visible or available surface, but this is not mandatory.

The application may:

- receive user input
- access granted platform services
- create surfaces
- perform normal foreground work

### `background`

The application remains active but is not currently the primary foreground application.

Background does not automatically mean suspended.

An application in this state may continue limited execution according to:

- application manifest declarations
- granted capabilities
- platform policy
- device class
- power conditions
- user settings

Examples include:

- playing audio
- completing a short task
- maintaining an approved communication session
- responding to a system service
- preparing application state for suspension

### `suspending`

The Runtime has instructed the application to prepare for suspension.

The framework host must notify the application and allow a limited preparation period.

During this period, the application may:

- save transient state
- flush lightweight data
- release optional resources
- pause timers
- pause rendering
- prepare restoration metadata

Applications must not perform lengthy work during suspension preparation.

### `suspended`

The application session still exists, but normal application execution has been paused or heavily restricted.

A suspended application may retain:

- session identity
- restoration state
- surfaces
- selected memory
- Runtime metadata

Whether the process remains resident is an implementation detail.

The Runtime may later:

- resume the same process
- reconstruct the session
- terminate it to reclaim resources

Applications must not assume that suspended memory will always survive.

### `resuming`

The Runtime is restoring a suspended or background application to active execution.

During this state, the host may:

- restore execution
- recreate framework state
- reconnect services
- recreate surfaces
- provide restoration data
- wait for readiness

After successful restoration, the application transitions to `running` or `background`.

### `stopping`

The Runtime has begun an orderly shutdown.

The application may receive a short opportunity to:

- save durable state
- close resources
- finish critical writes
- disconnect from services
- destroy surfaces
- exit cleanly

The Runtime may enforce a timeout.

### `stopped`

The application session ended normally.

The Runtime has:

- released session resources
- removed active process ownership
- closed related host resources
- recorded the normal exit
- preserved approved restoration data if required

The installed application remains available for future launches.

### `failed`

The application could not complete a requested lifecycle operation.

This state is primarily used for startup or restoration failures.

Examples:

- invalid entry point
- host unavailable
- incompatible Runtime version
- startup timeout
- permission preparation failure
- corrupted application package
- framework initialization failure

An application may fail without ever reaching `running`.

### `crashed`

The application or its framework host exited unexpectedly after execution began.

Possible causes include:

- unhandled exception
- segmentation fault
- aborted process
- host failure
- invalid memory access
- unexpected IPC disconnection

The Runtime records available crash metadata before cleanup.

### `terminated`

The application was stopped without completing the normal shutdown path.

Possible causes include:

- user force-stop
- security violation
- repeated unresponsiveness
- memory pressure
- system shutdown deadline
- host failure
- administrator action
- Runtime enforcement

Termination is intentional from the platform's perspective, even if it is unexpected by the application.

## State Diagram

```text
                         ┌──────────────┐
                         │  installed   │
                         └──────┬───────┘
                                │ launch
                                ▼
                         ┌──────────────┐
                 ┌──────▶│   starting   │──────┐
                 │       └──────┬───────┘      │
                 │              │ ready        │ failure
                 │              ▼              ▼
                 │       ┌──────────────┐  ┌──────────────┐
                 │       │   running    │  │    failed    │
                 │       └───┬──────┬───┘  └──────────────┘
                 │           │      │
                 │ background│      │ stop
                 │           ▼      ▼
                 │    ┌────────────┐ ┌──────────────┐
                 │    │ background │ │   stopping   │
                 │    └─────┬──────┘ └──────┬───────┘
                 │          │               │
                 │ suspend  │ resume        │ completed
                 │          ▼               ▼
                 │   ┌──────────────┐ ┌──────────────┐
                 │   │  suspending  │ │   stopped    │
                 │   └──────┬───────┘ └──────────────┘
                 │          │
                 │          ▼
                 │   ┌──────────────┐
                 └───│  suspended   │
                     └──────┬───────┘
                            │ resume
                            ▼
                     ┌──────────────┐
                     │   resuming   │
                     └──────┬───────┘
                            │ ready
                            └──────────▶ running
```

From most active states, an exceptional transition may occur to:

```text
crashed
terminated
failed
```

## Valid Transitions

The Runtime must reject invalid lifecycle transitions.

Initial valid transitions include:

```text
installed   → starting
starting    → running
starting    → background
starting    → failed
starting    → terminated

running     → background
running     → suspending
running     → stopping
running     → crashed
running     → terminated

background  → running
background  → suspending
background  → stopping
background  → crashed
background  → terminated

suspending  → suspended
suspending  → stopping
suspending  → crashed
suspending  → terminated

suspended   → resuming
suspended   → stopping
suspended   → terminated

resuming    → running
resuming    → background
resuming    → failed
resuming    → crashed
resuming    → terminated

stopping    → stopped
stopping    → crashed
stopping    → terminated
```

A new launch from `stopped`, `failed`, `crashed`, or `terminated` creates a new application session and transitions that new session into `starting`.

## Lifecycle Ownership

### Runtime

The Runtime is the source of truth.

It:

- stores the lifecycle state
- creates session identifiers
- validates transitions
- sends lifecycle commands
- receives acknowledgements
- enforces timeouts
- records failures
- coordinates cleanup
- publishes state changes

### Framework host

The framework host implements lifecycle behavior for its application type.

For React Native, the host may:

- create the Hermes runtime
- load the JavaScript bundle
- create Fabric surfaces
- forward foreground and background events
- pause rendering
- stop timers
- persist restoration state
- destroy the JavaScript runtime
- report fatal errors

The host does not decide the official platform state.

### Shell

The Shell may request:

- launch
- activate
- move to background
- close
- force-stop

The Shell displays Runtime state but does not modify it directly.

For example, the application switcher may display:

- running
- suspended
- crashed
- restoring

using Runtime-provided session information.

### Compositor

The compositor owns graphical surface state.

It may notify the Runtime when:

- the final primary surface closes
- a surface becomes visible
- focus changes
- a graphical client disconnects

The compositor does not decide whether the entire application should stop.

### Application

The application may:

- report readiness
- request background execution
- request shutdown
- provide restoration data
- acknowledge lifecycle commands
- report recoverable errors

The application cannot assign its own authoritative lifecycle state.

## Lifecycle Commands

A conceptual Runtime-to-host command may resemble:

```ts
type LifecycleCommand =
  | {
      type: "application.start";
      sessionId: string;
      applicationId: string;
      entryPoint: string;
      launchContext: LaunchContext;
    }
  | {
      type: "application.enterBackground";
      sessionId: string;
    }
  | {
      type: "application.suspend";
      sessionId: string;
      deadlineMs: number;
    }
  | {
      type: "application.resume";
      sessionId: string;
      restorationData?: unknown;
    }
  | {
      type: "application.stop";
      sessionId: string;
      reason: StopReason;
      deadlineMs: number;
    }
  | {
      type: "application.terminate";
      sessionId: string;
      reason: TerminationReason;
    };
```

A host response may resemble:

```ts
type LifecycleResponse =
  | {
      type: "application.ready";
      sessionId: string;
    }
  | {
      type: "application.suspended";
      sessionId: string;
      restorationData?: unknown;
    }
  | {
      type: "application.stopped";
      sessionId: string;
    }
  | {
      type: "application.error";
      sessionId: string;
      code: string;
      message: string;
    };
```

These examples establish direction but are not final IPC contracts.

ADR-0009 will define the communication mechanism.

## Launch Flow

A normal application launch follows this sequence:

```text
User or system requests launch
        │
        ▼
Runtime resolves application ID
        │
        ▼
Runtime validates sevyn.app.json
        │
        ▼
Runtime evaluates compatibility and policy
        │
        ▼
Runtime creates application session
        │
        ▼
State becomes starting
        │
        ▼
Runtime selects framework host
        │
        ▼
Host receives validated launch request
        │
        ▼
Host starts application
        │
        ▼
Application reports ready
        │
        ▼
State becomes running
```

The Runtime must not report `running` merely because a process was created.

The application or host must complete an explicit readiness step.

## Launch Context

Applications may be launched for different reasons.

A conceptual launch context may include:

```ts
type LaunchContext =
  | {
      reason: "user";
    }
  | {
      reason: "file";
      fileReference: string;
    }
  | {
      reason: "protocol";
      uri: string;
    }
  | {
      reason: "notification";
      notificationId: string;
    }
  | {
      reason: "restore";
      previousSessionId?: string;
    }
  | {
      reason: "system";
      task: string;
    };
```

Applications should receive only the launch data they are authorized to access.

## Foreground and Background

SevynOS distinguishes execution state from visual focus.

An application may be:

- running and focused
- running and visible but unfocused
- running without a visible surface
- backgrounded while still executing
- suspended while retaining session metadata

The initial state model will not introduce separate official states for every possible visibility combination.

Instead, the Runtime may track additional session attributes:

```ts
type ApplicationVisibility = "foreground" | "visible" | "hidden" | "none";
```

The lifecycle state and visibility state are related but distinct.

This prevents window-management details from overcomplicating the core lifecycle.

## Singleton Applications

The application manifest may request singleton behavior:

```json
{
  "launch": {
    "singleton": true
  }
}
```

When a singleton application is already active, a new launch request should normally:

1. locate the existing session
2. send it the new launch context
3. activate its appropriate surface
4. avoid creating a duplicate session

The Runtime retains final authority.

A manifest request does not override platform policy.

## Multiple Sessions

Applications that are not singleton may support multiple sessions.

Examples include:

- terminals
- document editors
- browser profiles
- isolated workspaces

Each session receives:

- a unique session ID
- independent lifecycle state
- independent launch context
- separately associated surfaces
- separately tracked resources

The application ID identifies the installed application.

The session ID identifies one execution of it.

## Closing Windows

Closing an application's final visible window does not always require stopping its session.

The outcome depends on:

- application manifest behavior
- application request
- background capabilities
- system policy
- device class

Possible behaviors include:

- stop immediately
- continue in background
- suspend
- remain active without surfaces
- ask the user
- preserve session for restoration

Genesis may use the simple default:

> Closing the final primary surface requests an orderly application stop.

Exceptions can be added later for approved background applications.

## Suspension

Suspension exists to reduce resource use without always discarding application state.

The Runtime may suspend an application because of:

- user switching
- device power policy
- inactivity
- memory pressure
- mobile background policy
- system sleep
- application request

The application must be prepared for the Runtime to terminate a suspended session later.

Therefore:

> Suspension is not durable storage.

Before suspension, applications should save important user data through normal storage APIs.

Restoration data should be treated as an optimization, not as the only copy of valuable state.

## Background Execution

Background execution must be explicitly controlled.

Applications do not receive unlimited background execution merely because they request it.

A future permission and capability model may support approved categories such as:

- audio playback
- navigation
- active communication
- downloads
- file synchronization
- device communication
- accessibility service
- time-limited task completion

The Runtime may impose:

- CPU limits
- memory limits
- network limits
- wake-up limits
- time limits
- device-specific restrictions

Detailed background-task behavior is outside the Genesis scope.

## Shutdown and Logout

During system shutdown or user logout, the Runtime should:

1. stop accepting ordinary launches
2. notify active sessions
3. provide a bounded shutdown period
4. record restoration metadata
5. stop applications
6. terminate unresponsive sessions
7. stop framework hosts
8. release resources
9. complete shutdown

Applications must not be able to indefinitely block system shutdown.

The user may be warned about unsaved application state where practical, but the Runtime retains final authority.

## System Suspend

Before the device enters system sleep, the Runtime may:

- notify eligible applications
- suspend sessions
- stop time-sensitive background work
- flush state
- coordinate with platform services

After wake:

- critical system services resume first
- framework hosts reconnect
- application sessions are restored according to policy
- applications receive an appropriate resume event

System suspend is distinct from application suspension, even though one may cause the other.

## Memory Pressure

The Runtime may respond to memory pressure in stages.

A future policy may:

1. notify applications of pressure
2. suspend background applications
3. discard reclaimable caches
4. terminate older suspended sessions
5. terminate lower-priority background sessions
6. protect the foreground application where possible

Applications terminated for memory pressure enter `terminated`, not `crashed`.

The termination reason should be recorded.

## Stop Reasons

A conceptual stop-reason type may include:

```ts
type StopReason =
  | "user-request"
  | "application-request"
  | "last-surface-closed"
  | "logout"
  | "shutdown"
  | "update"
  | "restart"
  | "policy";
```

## Termination Reasons

A conceptual termination-reason type may include:

```ts
type TerminationReason =
  | "force-stop"
  | "startup-timeout"
  | "shutdown-timeout"
  | "unresponsive"
  | "memory-pressure"
  | "security-violation"
  | "permission-revoked"
  | "host-failure"
  | "runtime-failure"
  | "administrator-action";
```

These reasons should appear in logs and developer diagnostics.

## Timeouts

Lifecycle operations must be bounded.

The Runtime should eventually define default deadlines for:

- startup readiness
- suspension acknowledgement
- resume readiness
- graceful shutdown
- host communication
- surface creation

Genesis may use configurable development defaults.

Timeouts should not initially be part of the public application manifest unless there is a demonstrated need.

Applications should not be able to request arbitrarily long shutdown or suspension windows.

## Crash Handling

When the Runtime detects an unexpected application or host failure, it should:

1. record the session state
2. record the exit reason
3. collect available logs and crash data
4. remove stale surface associations
5. release resources
6. mark the session `crashed`
7. notify the Shell
8. apply restart policy if appropriate

A crash must not silently appear as a normal stop.

## Host Failure

A framework host may manage one or multiple application sessions.

If a shared host fails, the Runtime must identify every affected session.

Each affected session may transition to:

- `crashed`
- `failed`
- `terminated`

depending on whether it had completed startup and why the host ended.

The Runtime should eventually isolate applications enough that one application cannot easily crash unrelated sessions.

Genesis may begin with one React Native host process per application session because it provides clearer isolation and debugging.

Shared hosts can be evaluated later.

## Restart Policy

Ordinary user applications should not automatically restart forever after crashes.

Possible future restart policies include:

- never
- restore once
- restart on system request
- restart trusted service
- restart with exponential backoff

System services may use different policies than user-facing applications.

Genesis should default to:

- no automatic restart for ordinary applications
- controlled restart for essential trusted services
- explicit user relaunch after crashes

## Restoration

Restoration allows SevynOS to recreate useful application state after suspension, termination, logout, restart, or system update.

Restoration metadata may include:

- application ID
- previous session ID
- open document references
- surface roles and placement
- selected application state
- launch context
- framework-specific restoration data

Restoration data must be:

- bounded in size
- versioned
- treated as untrusted application input
- invalidatable
- removable by the user
- excluded from sensitive storage unless protected appropriately

The Runtime owns restoration records.

Framework hosts may provide framework-specific restoration payloads.

Applications must still save durable user content separately.

## Lifecycle Events for Applications

The Sevyn SDK should eventually expose lifecycle events such as:

```ts
import { AppLifecycle } from "@sevynos/sdk";

AppLifecycle.on("background", () => {
  // Pause nonessential foreground work.
});

AppLifecycle.on("suspend", async () => {
  // Save lightweight restoration state.
});

AppLifecycle.on("resume", () => {
  // Refresh transient resources.
});

AppLifecycle.on("stop", async () => {
  // Complete critical cleanup.
});
```

The exact API will be defined later.

Applications must not block lifecycle transitions indefinitely.

## React Native Translation

The React Native host will translate Runtime lifecycle events into React Native-compatible behavior.

Conceptually:

```text
Runtime starting
    → initialize Hermes and React Native

Runtime running
    → application active

Runtime background
    → application background event

Runtime suspending
    → pause or freeze eligible execution

Runtime suspended
    → execution paused or session checkpointed

Runtime resuming
    → restore execution and application state

Runtime stopping
    → unmount surfaces and destroy runtime
```

React Native's internal state must not replace the Runtime's official lifecycle state.

The host reports completion back to the Runtime.

## Native Application Translation

A native host may:

- start the executable
- establish lifecycle IPC
- await a readiness signal
- send background or suspension commands
- receive acknowledgements
- terminate the process when required

Native applications must not be treated as permanently running solely because they are compiled binaries.

## Web Application Translation

A future web host may translate lifecycle states into:

- page visibility changes
- JavaScript lifecycle events
- timer throttling
- process freezing
- document restoration
- web-worker restrictions

The same Runtime state machine still applies.

## System Applications

System applications use the same lifecycle model.

Examples include:

- Settings
- Files
- Launcher-related applications
- system utilities

Trusted status may grant additional capabilities, but system applications should still:

- have application identities
- have manifests
- create sessions
- report readiness
- stop cleanly
- produce crash information

The Shell and Runtime themselves are platform components rather than ordinary applications, even if parts of their UI use React Native.

## Error Model

Lifecycle errors should use stable, framework-independent codes.

Initial examples include:

```text
APPLICATION_NOT_FOUND
MANIFEST_INVALID
APPLICATION_INCOMPATIBLE
HOST_NOT_AVAILABLE
HOST_START_FAILED
APPLICATION_START_TIMEOUT
APPLICATION_NOT_READY
INVALID_LIFECYCLE_TRANSITION
APPLICATION_SUSPEND_TIMEOUT
APPLICATION_RESUME_FAILED
APPLICATION_STOP_TIMEOUT
APPLICATION_CRASHED
APPLICATION_TERMINATED
SESSION_NOT_FOUND
```

Errors should include:

- a stable code
- a human-readable message
- the application ID
- the session ID when available
- the current state
- the attempted transition
- diagnostic details when safe

## Observability

The Runtime should emit structured lifecycle logs.

Example:

```json
{
  "event": "application.lifecycle.transition",
  "applicationId": "org.sevynos.settings",
  "sessionId": "session-123",
  "from": "starting",
  "to": "running",
  "reason": "application-ready",
  "timestamp": "2026-07-25T20:00:00Z"
}
```

Important measurements include:

- application startup time
- time to readiness
- time to first surface
- suspend duration
- resume duration
- graceful-stop duration
- crash frequency
- timeout frequency
- memory-pressure terminations

## Persistence

Active lifecycle state should primarily be held by the Runtime.

The Runtime may persist enough information to support:

- crash recovery
- restoration
- diagnostics
- update coordination
- shutdown recovery

A session recorded as `running` before a machine crash must not automatically be treated as still running after reboot.

During Runtime startup, stale sessions should be reconciled and marked appropriately.

## Genesis Scope

### Included

- application session identifiers
- `installed`
- `starting`
- `running`
- `stopping`
- `stopped`
- `failed`
- `crashed`
- `terminated`
- validated transitions
- launch readiness acknowledgement
- graceful stop request
- startup and stop timeouts
- React Native host translation
- Runtime lifecycle logs
- Shell display of basic state

### Limited or Experimental

- `background`
- `suspending`
- `suspended`
- `resuming`
- basic restoration metadata

These states should exist in the architecture even if Genesis implements only minimal behavior.

### Not Required for Genesis

- advanced background task scheduling
- mobile power policies
- automatic user-application restart
- complete memory-pressure priority system
- multi-user logout restoration
- shared framework-host processes
- hibernation
- full session restoration across upgrades
- background location
- sophisticated process freezing

## Implementation Direction

A Runtime lifecycle module may initially include:

```text
runtime/
└── src/
    └── applications/
        ├── application-manager.ts
        ├── application-session.ts
        ├── lifecycle-state.ts
        ├── lifecycle-transition.ts
        ├── lifecycle-errors.ts
        ├── host-registry.ts
        ├── launch-application.ts
        └── stop-application.ts
```

A conceptual transition validator may resemble:

```ts
const validTransitions: Record<
  ApplicationLifecycleState,
  ReadonlySet<ApplicationLifecycleState>
> = {
  installed: new Set(["starting"]),

  starting: new Set(["running", "background", "failed", "terminated"]),

  running: new Set(["background", "suspending", "stopping", "crashed", "terminated"]),

  background: new Set(["running", "suspending", "stopping", "crashed", "terminated"]),

  suspending: new Set(["suspended", "stopping", "crashed", "terminated"]),

  suspended: new Set(["resuming", "stopping", "terminated"]),

  resuming: new Set(["running", "background", "failed", "crashed", "terminated"]),

  stopping: new Set(["stopped", "crashed", "terminated"]),

  stopped: new Set(),
  failed: new Set(),
  crashed: new Set(),
  terminated: new Set(),
};
```

Terminal states do not transition within the same session.

A relaunch creates a new session.

## Testing Requirements

The lifecycle implementation must test:

- valid transitions
- invalid transitions
- successful startup
- startup failure
- startup timeout
- normal shutdown
- shutdown timeout
- host crash
- application crash
- force-stop
- duplicate singleton launch
- multiple non-singleton sessions
- stale session recovery
- final surface closure
- Runtime restart reconciliation

Tests should use a mock application host before requiring React Native.

## Consequences

### Positive consequences

- Every framework shares one application model.
- The Runtime remains the lifecycle authority.
- Applications have predictable launch and shutdown behavior.
- Framework-specific behavior stays inside hosts.
- Crash and termination events are distinguishable.
- Shell state becomes reliable.
- Session identity supports multiple application instances.
- Background and suspension behavior can evolve without changing application identity.
- The model can support desktop, mobile, television, and embedded devices.
- Testing can begin with mock framework hosts.

### Negative consequences

- The Runtime must maintain a nontrivial state machine.
- Framework hosts must acknowledge lifecycle operations.
- Timeouts and partial failures require careful handling.
- Visibility and lifecycle remain separate concepts that developers must understand.
- Suspension behavior may differ between device classes.
- Restoration introduces versioning and data-validation concerns.
- Shared framework hosts will complicate crash handling later.

### Risks

The primary risk is overengineering lifecycle behavior before Genesis has real applications.

To reduce this risk:

- Genesis will fully implement only the core launch and stop path
- background and suspension states will remain minimal
- public APIs will be introduced only when exercised
- mock hosts will validate the architecture
- device-specific policy will remain outside the core state machine

Another risk is allowing framework-specific concepts to leak into Runtime states.

To reduce this risk:

- Runtime state names remain framework-neutral
- framework lifecycle events are translated by hosts
- Runtime modules must not import React Native packages
- public lifecycle records must use SevynOS-owned types

## Alternatives Considered

### Let each framework define its own lifecycle

Rejected because applications would behave differently depending on their implementation framework.

The Shell, permissions system, updater, and Runtime would lack a consistent application model.

### Use process state as application state

Rejected because:

- one application may use multiple processes
- one process may host multiple sessions
- a running process does not mean the application is ready
- suspended sessions may or may not retain a process
- process exit does not explain whether the app stopped, crashed, or was terminated

### Treat windows as applications

Rejected because:

- applications may have multiple windows
- applications may run without windows
- closing a surface does not always stop execution
- non-graphical applications still require lifecycle management

### Use only running and stopped

Rejected because this would not represent:

- startup
- readiness
- background execution
- suspension
- orderly shutdown
- startup failure
- crashes
- force termination

### Copy Android or Apple lifecycle states directly

Rejected because SevynOS must support multiple device classes and framework hosts without inheriting another platform's entire application model.

Existing platforms may provide useful lessons, but SevynOS will define its own framework-independent lifecycle.

## Validation Criteria

This decision will be validated when:

1. The Runtime creates a unique session for each application launch.
2. The Runtime validates every lifecycle transition.
3. A mock host can launch and stop through the complete lifecycle.
4. A React Native host reports readiness before the session becomes `running`.
5. Startup failure results in `failed`.
6. Unexpected application exit results in `crashed`.
7. Force-stop results in `terminated`.
8. Normal shutdown results in `stopped`.
9. The Shell reads lifecycle state from the Runtime.
10. Closing a surface does not directly mutate lifecycle state.
11. Runtime code remains framework-independent.
12. Logs clearly show every state transition.

## Revisit Conditions

This decision should be reconsidered if:

- real applications reveal missing core states
- mobile requirements cannot be represented cleanly
- service processes require a fundamentally different model
- one process hosting multiple applications makes session ownership impractical
- suspension cannot be implemented consistently
- lifecycle complexity creates unacceptable startup or IPC overhead

Changes should preserve the distinction between application identity, process identity, surface identity, and session identity.

## Immediate Implementation Tasks

Project Sevyn should now:

1. Create the lifecycle-state type.
2. Implement the transition table.
3. Create application session identifiers.
4. Implement an in-memory session registry.
5. Create an `ApplicationHost` mock.
6. Implement the basic launch flow.
7. Require an explicit ready acknowledgement.
8. Implement startup timeout handling.
9. Implement graceful stop.
10. Implement stop timeout and forced termination.
11. Add structured lifecycle logging.
12. Add unit tests for every transition.
13. Connect one React Native host.
14. Show session state in the Genesis Shell.
15. Create ADR-0009 defining IPC and service communication.

## Final Position

SevynOS applications will follow one framework-independent lifecycle.

Applications are not processes.

Applications are not windows.

An application session is a Runtime-managed execution with its own identity and state.

The Runtime decides what state the session is in.

Framework hosts make that state real.

The Shell presents it.

Applications respond to it.

This separation gives SevynOS a lifecycle model that can survive changes in frameworks, devices, process architecture, and user interface.
