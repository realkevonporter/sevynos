# ADR-0009: Define SevynOS IPC and Service Communication

**Status:** Accepted
**Date:** July 25, 2026
**Decision owners:** Project Sevyn
**Applies to:** SevynOS
**Architecture version:** v0.1 Genesis

## Context

SevynOS is composed of multiple independent platform components.

These include:

- Sevyn Runtime
- Sevyn Shell
- SevynOS compositor
- framework hosts
- applications
- system services
- developer tools
- package and update services
- future background services

These components must exchange commands, events, requests, responses, and state updates.

Examples include:

- the Shell requesting that the Runtime launch an application
- the Runtime instructing a framework host to stop a session
- a framework host reporting application readiness
- the compositor reporting that a surface was created
- an application requesting access to a system service
- the permissions service approving or denying a capability
- a notification service delivering an event
- the Runtime publishing lifecycle changes
- developer tooling requesting diagnostics

Without a defined inter-process communication model, components may begin communicating through:

- direct process-specific APIs
- shared memory without clear ownership
- framework-specific callbacks
- unversioned Unix sockets
- environment variables
- arbitrary JSON messages
- compositor-specific internals

That would make the system difficult to secure, test, version, and replace.

SevynOS therefore requires a framework-independent IPC architecture with explicit identities, typed contracts, bounded authority, and clear ownership.

## Decision

SevynOS will use a service-oriented, message-based IPC architecture.

The initial transport will use local Unix domain sockets.

Messages will use a versioned, typed protocol.

The Runtime will maintain the authoritative registry of platform services and authenticated application sessions.

Applications will not connect directly to arbitrary privileged processes.

Instead, they will request services through Runtime-issued identities and capabilities.

The core rule is:

> Components communicate through versioned contracts, not implementation details.

## Architectural Principles

The IPC system will follow these principles:

1. Every connection has an authenticated identity.
2. Every message belongs to a versioned protocol.
3. Requests and events are distinct.
4. Privileged services expose only narrow interfaces.
5. Applications receive only the services they are authorized to use.
6. Timeouts and disconnections are normal conditions.
7. IPC contracts remain framework-independent.
8. Transports are implementation details.
9. Public contracts use SevynOS-owned types.
10. No component is trusted solely because it runs locally.

## Communication Architecture

```text
┌──────────────────────────────────────────┐
│              Sevyn Shell                 │
└───────────────────┬──────────────────────┘
                    │
                    │ Runtime protocol
                    ▼
┌──────────────────────────────────────────┐
│             Sevyn Runtime                │
│                                          │
│ Identity, sessions, service registry,    │
│ routing, policy and lifecycle authority  │
└───────┬──────────────────┬───────────────┘
        │                  │
        │ Host protocol    │ Service protocol
        ▼                  ▼
┌────────────────┐  ┌──────────────────────┐
│ Framework Host │  │   Platform Services  │
└───────┬────────┘  │                      │
        │           │ Files, notifications,│
        │ SDK bridge│ settings, permissions│
        ▼           └──────────┬───────────┘
┌────────────────┐             │
│  Application   │─────────────┘
└────────────────┘
```

The compositor may communicate with both the Runtime and Shell through separate, restricted protocols.

## IPC Layers

SevynOS will distinguish three communication layers.

### Platform control IPC

Used between trusted platform components.

Examples:

- Runtime and framework host
- Runtime and compositor
- Runtime and Shell
- Runtime and permissions service
- Runtime and package manager

This layer may expose privileged operations but must still authenticate peers and validate all messages.

### Application service IPC

Used when applications access platform services.

Examples:

- file access
- notifications
- clipboard
- settings
- media
- networking
- device information
- application launching

This layer is capability-controlled.

An application should see only the service methods and resources it is authorized to use.

### Application-local IPC

Used by processes belonging to the same application session.

Examples:

- application process and helper process
- renderer and worker
- application and extension
- native module bridge

The Runtime may broker or authorize this communication, but application-local protocols remain application-owned unless they access platform resources.

## Initial Transport

Genesis will use Unix domain sockets for local IPC.

Reasons include:

- local-only transport
- filesystem or abstract namespace addressing
- operating-system credential support
- efficient communication
- mature debugging tools
- support for request-response and event streams
- compatibility with native and high-level languages
- no dependency on a network stack

The transport must be hidden behind SevynOS-owned connection abstractions.

Public platform APIs must not require applications to know:

- socket filenames
- file descriptors
- socket namespaces
- transport framing details
- operating-system credential structures

A future implementation may replace or supplement Unix sockets with:

- shared-memory channels
- pipes
- kernel IPC facilities
- remote transports
- device-to-device transports
- hardware-specific mechanisms

The logical protocol should remain stable where possible.

## Why Not Use HTTP as the Primary Local IPC

HTTP is widely understood and useful for some tooling and remote services.

It is not selected as the primary internal IPC mechanism because:

- it introduces request semantics not suited to every system event
- streaming and bidirectional communication require additional conventions
- local peer identity is less direct
- protocol exposure may accidentally resemble a network API
- binary payloads and file-descriptor passing are awkward
- privileged local services should not automatically become network services

HTTP may still be used for:

- developer dashboards
- remote debugging
- web-based management
- network-accessible services
- documentation examples

It will not define core Runtime communication.

## Message Encoding

Genesis messages will use a binary, schema-defined encoding.

The initial preferred encoding is Protocol Buffers.

Each protocol will define:

- messages
- enumerations
- service methods
- events
- error payloads
- version information

Reasons include:

- typed schemas
- code generation
- support for multiple languages
- compact messages
- backwards-compatible field evolution
- explicit optional fields
- deterministic contract review

The decision to use Protocol Buffers applies to logical message encoding.

It does not require the system to expose gRPC as the IPC transport.

A lightweight SevynOS request and event protocol may use Protocol Buffer payloads over Unix domain sockets.

## Why Not JSON as the Core Encoding

JSON is readable and useful during experimentation.

It is not selected as the permanent core encoding because:

- schemas are not inherently enforced
- numeric and binary representations are limited
- field mistakes are discovered later
- compatibility discipline is easier to violate
- large message volumes create unnecessary parsing overhead
- generated cross-language types require additional tooling

JSON may be used for:

- logs
- manifests
- developer tools
- test fixtures
- temporary prototypes
- debugging views

The first spike may temporarily use newline-delimited JSON to validate communication flow.

Before Genesis IPC is considered stable, core protocols must migrate to schema-defined messages.

## Protocol Framing

Each IPC connection must use explicit message framing.

A conceptual frame may include:

```ts
type IpcFrameHeader = {
  protocolId: string;
  protocolVersion: number;
  messageType: "request" | "response" | "event" | "cancel";
  messageId: string;
  replyTo?: string;
  payloadLength: number;
};
```

The exact binary structure will be defined during implementation.

Frames must support:

- multiple messages per connection
- request-response correlation
- asynchronous events
- cancellation
- bounded payload sizes
- protocol-version detection
- unknown message rejection

Messages must never depend on reading until socket closure.

## Requests, Responses, and Events

### Request

A request asks another component to perform an operation or return information.

Example:

```ts
type LaunchApplicationRequest = {
  applicationId: string;
  launchContext: LaunchContext;
};
```

### Response

A response completes a request.

Example:

```ts
type LaunchApplicationResponse = {
  sessionId: string;
  state: "starting";
};
```

Every request must result in one of:

- success response
- structured error response
- cancellation
- timeout
- connection failure

### Event

An event announces that something occurred.

Example:

```ts
type ApplicationLifecycleChangedEvent = {
  applicationId: string;
  sessionId: string;
  previousState: ApplicationLifecycleState;
  currentState: ApplicationLifecycleState;
  reason: string;
};
```

Events do not receive normal responses.

Consumers may acknowledge delivery only when the protocol explicitly requires reliability.

### Command

A command is represented as a request when acknowledgement or failure matters.

SevynOS should avoid fire-and-forget commands for important lifecycle or security operations.

## Service Model

A service is a Runtime-recognized provider of a versioned protocol.

Conceptually:

```ts
type ServiceDescriptor = {
  id: string;
  protocol: string;
  version: number;
  providerIdentity: string;
  trustLevel: "platform" | "system" | "application";
  methods: string[];
};
```

Example service IDs may include:

```text
org.sevynos.runtime
org.sevynos.permissions
org.sevynos.notifications
org.sevynos.files
org.sevynos.settings
org.sevynos.clipboard
org.sevynos.compositor
```

Service IDs must not be treated as proof of identity.

The Runtime verifies the provider before registration.

## Service Registry

The Runtime will maintain the authoritative service registry for the active user session.

The registry records:

- service ID
- protocol ID
- supported protocol versions
- provider identity
- connection endpoint
- health state
- trust level
- availability
- restart state

A consumer may ask the Runtime for access to a service.

The Runtime will evaluate:

- caller identity
- session identity
- declared permissions
- granted capabilities
- service availability
- protocol compatibility
- device policy

The Runtime may then:

- deny access
- broker messages
- provide a restricted endpoint
- create a scoped connection
- issue a temporary capability token

The implementation may evolve, but the Runtime remains the policy authority.

## Identity and Authentication

Every IPC peer must have a verified identity.

Possible peer identities include:

- platform component identity
- system-service identity
- framework-host identity
- application identity
- application-session identity
- developer-tool identity

An application must not be trusted based solely on:

- process name
- executable path
- self-declared application ID
- socket location
- environment variables
- manifest contents presented at connection time

The Runtime establishes identity when it launches or authorizes a process.

The IPC layer should use available operating-system credentials, process ownership, inherited secrets, or Runtime-issued connection credentials to bind the peer to that identity.

A conceptual authenticated peer may resemble:

```ts
type AuthenticatedPeer = {
  principalId: string;
  principalType:
    | "runtime"
    | "shell"
    | "compositor"
    | "host"
    | "service"
    | "application"
    | "developer-tool";
  applicationId?: string;
  sessionId?: string;
  processId?: number;
};
```

This type is illustrative.

## Capability-Based Connections

Permission checks should not occur only when an application initially connects.

Where practical, the Runtime should issue scoped capabilities.

A capability may authorize:

- access to one service
- access to one method
- access to one file
- access to one device
- access for a limited time
- access during one application session
- access with specific constraints

Example conceptual capability:

```ts
type ServiceCapability = {
  capabilityId: string;
  subjectSessionId: string;
  serviceId: string;
  allowedMethods: string[];
  resourceScope?: string;
  expiresAt?: string;
};
```

Applications should not be able to widen or transfer capabilities unless the platform explicitly allows it.

ADR-0010 will define the permission and capability model in detail.

## Runtime and Framework Host Protocol

The Runtime-to-host protocol will initially support:

- host registration
- host health
- supported application types
- application launch
- application readiness
- lifecycle commands
- lifecycle acknowledgements
- application errors
- application exits
- host shutdown

Conceptual methods include:

```text
Host.Register
Host.Heartbeat
Application.Start
Application.EnterBackground
Application.Suspend
Application.Resume
Application.Stop
Application.Terminate
```

Conceptual events include:

```text
Application.Ready
Application.Error
Application.Exited
Application.SurfaceRequested
Host.Unhealthy
```

The host protocol must not contain React Native-specific types.

React Native details stay inside the React Native host implementation.

## Runtime and Shell Protocol

The Shell requires access to user-facing Runtime operations.

Initial methods may include:

```text
Applications.ListInstalled
Applications.ListSessions
Applications.Launch
Applications.Activate
Applications.Stop
Applications.ForceStop
Applications.GetSession
```

Initial events may include:

```text
Applications.InstalledChanged
Applications.SessionCreated
Applications.LifecycleChanged
Applications.SessionRemoved
Applications.Crashed
```

The Shell must not:

- directly mutate Runtime state
- directly start application processes
- bypass permission checks
- impersonate application sessions

The Shell is trusted, but it still uses a documented protocol.

## Runtime and Compositor Protocol

The Runtime and compositor require a narrow trusted interface.

The protocol may support:

- associating graphical clients with Runtime sessions
- reporting surface creation
- reporting surface destruction
- reporting visibility changes
- requesting application activation
- requesting orderly stop after final-surface closure
- revoking surfaces after termination
- identifying trusted Shell connections

Conceptual messages include:

```text
Surface.AssociateSession
Surface.Created
Surface.Destroyed
Surface.VisibilityChanged
Surface.FocusChanged
Session.RevokeSurfaces
```

The compositor must not accept an application's self-declared session ID as authoritative.

Session association must use a trusted Runtime-provided mechanism.

## Shell and Compositor Protocol

The Shell needs privileged control over presentation policy.

Possible operations include:

- list application surfaces
- move or resize a surface
- activate a surface
- assign a workspace
- request fullscreen
- create trusted system surfaces
- display switcher state
- close an application surface

This protocol must remain separate from the ordinary application Wayland interface.

Ordinary applications must not be able to connect as the Shell.

The compositor should authenticate the Shell connection using a Runtime-established identity or dedicated platform credential.

## Application Service Access

Applications should use the Sevyn SDK rather than manually constructing IPC frames.

Example:

```ts
import { Notifications } from "@sevynos/sdk";

await Notifications.post({
  title: "Download complete",
  body: "Your file is ready.",
});
```

The SDK will:

1. identify the current application session
2. request or use an existing service capability
3. encode the request
4. send it to the service
5. enforce timeout behavior
6. decode the response
7. translate platform errors into SDK errors

The application should not need to know which process implements the service.

## Service Discovery

Applications should not freely enumerate every privileged service.

The Runtime should provide filtered service discovery based on caller identity and granted permissions.

A normal application may be told only:

- whether a requested SDK service is available
- which supported public protocol version is active
- whether its capability is granted

Trusted developer tools may receive broader diagnostics when explicitly authorized.

## Protocol Versioning

Every protocol must have an independent version.

Examples:

```text
org.sevynos.runtime.shell/v1
org.sevynos.runtime.host/v1
org.sevynos.runtime.compositor/v1
org.sevynos.service.notifications/v1
```

Protocol versions are independent from:

- SevynOS release version
- application manifest version
- SDK package version
- application version
- framework-host version

A component may support multiple protocol versions during migrations.

## Compatibility Rules

Protocol evolution should follow these rules:

- existing field numbers are never reused
- unknown fields are ignored when safe
- required semantic changes create a new protocol version
- new optional fields may be added compatibly
- enum evolution must handle unknown values
- removed behavior is deprecated before deletion
- error codes remain stable
- feature negotiation is explicit
- public SDK behavior is tested across supported versions

A connection must fail clearly when no compatible protocol version exists.

## Feature Negotiation

Version numbers alone may not represent every optional feature.

A service may advertise capabilities such as:

```ts
type ProtocolFeatures = {
  protocolVersion: number;
  features: string[];
};
```

Example features:

```text
notifications.actions
notifications.images
files.scoped-handles
lifecycle.restoration
surfaces.multiple-primary
```

Consumers must not assume a feature exists solely because a service is reachable.

## Error Model

All public IPC errors must use structured, framework-independent error payloads.

A conceptual error type:

```ts
type IpcError = {
  code: string;
  message: string;
  requestId?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};
```

Initial error codes may include:

```text
IPC_PROTOCOL_UNSUPPORTED
IPC_MESSAGE_INVALID
IPC_MESSAGE_TOO_LARGE
IPC_REQUEST_TIMEOUT
IPC_REQUEST_CANCELLED
IPC_CONNECTION_CLOSED
IPC_PEER_UNAUTHENTICATED
IPC_PERMISSION_DENIED
IPC_CAPABILITY_EXPIRED
IPC_SERVICE_NOT_FOUND
IPC_SERVICE_UNAVAILABLE
IPC_METHOD_NOT_FOUND
IPC_RATE_LIMITED
IPC_INTERNAL_ERROR
```

Error messages may change.

Error codes form the stable programmatic contract.

Sensitive internal details must not be exposed to untrusted callers.

## Timeouts

Every request must have a deadline.

Timeout ownership may be defined by:

- SDK defaults
- service-specific policy
- Runtime policy
- the requesting component
- lifecycle deadlines

Requests must not wait forever.

Long-running work should use one of:

- asynchronous job handles
- progress events
- cancellable operations
- background task services
- streamed responses

Applications should not use extremely long IPC request deadlines to simulate background execution.

## Cancellation

The IPC protocol must support cancellation for operations that can outlive the caller's interest.

Examples:

- file searches
- downloads
- media processing
- application launch requests
- device discovery

Cancellation is cooperative.

A service may already have completed the operation by the time the cancel request arrives.

The final response should make the result explicit.

## Backpressure

Event producers must not be able to consume unbounded memory when consumers are slow.

The IPC layer should support:

- bounded outbound queues
- disconnecting unresponsive peers
- dropping explicitly lossy events
- coalescing state-change events
- flow control for streams
- per-peer message limits

Critical events must not be silently dropped.

For state-oriented data, consumers should be able to request a current snapshot after reconnecting.

## Reconnection

IPC connections may fail because of:

- service restart
- application crash
- Runtime restart
- system suspend
- resource pressure
- version mismatch
- peer termination

Clients must treat disconnection as normal.

The SDK should provide consistent reconnection behavior where appropriate.

After reconnecting, a client may need to:

- authenticate again
- obtain new capabilities
- resubscribe to events
- request current state
- invalidate pending requests

Pending requests from the previous connection must not be silently replayed unless the operation is explicitly idempotent.

## Idempotency

Operations that may be retried should support idempotency keys.

Examples include:

- posting a notification
- launching an application
- creating a file operation
- registering a background job

A conceptual request may include:

```ts
type RequestMetadata = {
  requestId: string;
  idempotencyKey?: string;
  deadlineAt?: string;
};
```

Services decide how long idempotency records remain valid.

Read-only requests generally do not need idempotency keys.

## Streaming

Some platform operations require streams.

Examples:

- file content
- audio
- video
- screen sharing
- logs
- developer traces
- progress updates

Large streams should not be encoded as one enormous protocol message.

The IPC architecture may use:

- chunked protocol messages
- transferred file descriptors
- shared-memory buffers
- specialized media channels

The control channel remains message-based.

The data channel may use a more efficient mechanism.

## File Descriptor Passing

Unix domain sockets can support transferring file descriptors.

SevynOS may use this for:

- scoped file handles
- shared-memory buffers
- media streams
- compositor buffers
- temporary resources

A transferred descriptor is a capability.

The receiver obtains access to a specific resource without receiving broad filesystem authority.

File-descriptor passing must be wrapped in SevynOS-owned APIs and audited carefully.

## Shared Memory

Shared memory may be used for high-volume data where message copying becomes inefficient.

Potential uses include:

- graphics buffers
- media
- telemetry rings
- large read-only datasets

Shared memory must not become the default control mechanism.

Every shared-memory region requires:

- explicit ownership
- size limits
- lifetime management
- synchronization rules
- access permissions
- cleanup behavior

Control and authorization remain message-based.

## Service Process Model

A service may run:

- as a dedicated process
- inside the Runtime
- inside another trusted service host
- on demand
- continuously
- once per user session
- once per machine

The process model must not affect the public service protocol.

For example, the notifications service may initially live inside the Runtime and later move into its own process without changing the application SDK.

## Service Lifecycle

The Runtime may track service states such as:

```text
unavailable
starting
ready
degraded
stopping
failed
```

Consumers should receive structured availability errors.

Essential services may use controlled restart policies.

Ordinary applications must not be able to register themselves as trusted platform services.

## Application-Provided Services

Future applications may expose services to other applications.

Examples include:

- document conversion
- media editing
- search providers
- share targets
- language tools
- automation actions

Application-provided services must:

- be declared in the application manifest
- use versioned public contracts
- be launched or activated by the Runtime
- require caller authorization
- remain sandboxed
- not impersonate system services

Genesis does not require application-provided services, but the architecture must not prevent them.

## Event Subscription Model

Consumers should explicitly subscribe to event groups.

Example:

```ts
type SubscribeRequest = {
  serviceId: string;
  events: string[];
};
```

Subscriptions must be:

- scoped to the authenticated connection
- validated against permissions
- removed on disconnect
- bounded
- resumable through snapshots where required

A service should avoid broadcasting every event to every connected client.

## Observability

The IPC layer should emit structured diagnostics.

Important fields include:

- protocol ID
- protocol version
- caller identity
- service identity
- message type
- request ID
- method
- duration
- result code
- payload size
- timeout state

Sensitive payload contents should not be logged by default.

Example diagnostic event:

```json
{
  "event": "ipc.request.completed",
  "protocol": "org.sevynos.runtime.shell",
  "version": 1,
  "method": "Applications.Launch",
  "caller": "org.sevynos.shell",
  "requestId": "request-123",
  "durationMs": 24,
  "result": "success"
}
```

## Developer Tooling

Genesis should include a development-only IPC inspection tool.

A conceptual command may resemble:

```bash
sevyn ipc services
sevyn ipc connections
sevyn ipc inspect org.sevynos.runtime
sevyn ipc trace --protocol org.sevynos.runtime.host
```

The tool may display:

- registered services
- supported protocol versions
- active connections
- authenticated identities
- request counts
- failures
- latency
- event subscriptions

It must not expose secret capabilities or sensitive application payloads.

Production access should require explicit developer authorization.

## Security Requirements

The IPC system is a security boundary.

It must defend against:

- application identity spoofing
- service identity spoofing
- malformed messages
- oversized messages
- unauthorized method calls
- replay attacks
- capability theft
- stale credentials
- confused-deputy behavior
- denial of service
- event subscription abuse
- resource leaks

Every service must validate:

1. who is calling
2. which session the caller belongs to
3. whether the method is permitted
4. whether the requested resource is within scope
5. whether the message is structurally valid
6. whether rate or size limits are exceeded

Being connected does not imply authority.

## Sandbox Interaction

The application sandbox should not require broad access to the filesystem location of privileged service sockets.

Possible approaches include:

- inherited connected file descriptors
- Runtime-brokered endpoints
- per-session socket directories
- namespace-specific endpoints
- capability-bearing connection tokens

The exact sandbox mechanism will be selected later.

The architecture requires that service access remain intentional and scoped.

## Rate Limiting

Services may apply limits based on:

- application ID
- session ID
- method
- resource
- time interval
- current system pressure

Rate limits should produce structured errors.

Security-sensitive limits should not reveal enough internal detail to make abuse easier.

Trusted system components may have different limits, but should not be completely unbounded by default.

## Genesis Scope

### Included

- Unix domain socket transport
- explicit message framing
- request-response correlation
- asynchronous events
- application-session authentication
- Runtime service registry
- Runtime-to-host protocol
- Runtime-to-Shell protocol
- Runtime-to-compositor prototype protocol
- structured errors
- timeouts
- connection-loss handling
- mock service implementation
- structured IPC logging

### Initially Simplified

- Protocol Buffers may follow a temporary JSON prototype
- capability tokens may initially remain Runtime-internal
- service routing may begin inside the Runtime process
- one connection may carry one protocol
- file-descriptor passing may remain experimental
- service restart handling may remain basic

### Not Required for Genesis

- remote IPC
- cross-device services
- application-provided services
- full streaming framework
- generalized service marketplace
- shared framework-host multiplexing
- complete distributed tracing
- transparent request replay
- public third-party native IPC access
- multi-user service routing
- advanced quality-of-service classes

## Implementation Direction

A possible Runtime structure is:

```text
runtime/
└── src/
    └── ipc/
        ├── connection.ts
        ├── frame.ts
        ├── peer-identity.ts
        ├── protocol.ts
        ├── request-router.ts
        ├── response-tracker.ts
        ├── event-bus.ts
        ├── service-registry.ts
        ├── capability.ts
        ├── errors.ts
        └── transport/
            └── unix-socket.ts
```

Protocol definitions may live under:

```text
protocols/
├── runtime-shell/
│   └── v1/
├── runtime-host/
│   └── v1/
├── runtime-compositor/
│   └── v1/
└── services/
    ├── notifications/
    │   └── v1/
    └── settings/
        └── v1/
```

Generated protocol code should not be edited manually.

## Conceptual Interfaces

A transport-independent connection interface may resemble:

```ts
interface IpcConnection {
  readonly peer: AuthenticatedPeer;

  request<TRequest, TResponse>(
    method: string,
    payload: TRequest,
    options?: {
      timeoutMs?: number;
      idempotencyKey?: string;
      signal?: AbortSignal;
    },
  ): Promise<TResponse>;

  emit<TEvent>(event: string, payload: TEvent): Promise<void>;

  subscribe<TEvent>(event: string, handler: (payload: TEvent) => void): () => void;

  close(): Promise<void>;
}
```

The public SDK may expose more specialized service clients rather than this generic interface.

## Initial Protocols

Genesis should implement three protocols first.

### Runtime–Shell protocol

Proves:

- requests
- responses
- state events
- trusted identity
- service discovery

Initial operation:

```text
Applications.Launch
```

Initial event:

```text
Applications.LifecycleChanged
```

### Runtime–Host protocol

Proves:

- host registration
- lifecycle commands
- readiness acknowledgements
- timeout behavior
- host failure detection

Initial operation:

```text
Application.Start
```

Initial event:

```text
Application.Ready
```

### Runtime–Compositor protocol

Proves:

- trusted peer identity
- surface-to-session association
- graphical event delivery
- separation from Wayland client identity

Initial operation:

```text
Surface.Authorize
```

Initial event:

```text
Surface.Created
```

## Testing Requirements

The IPC implementation must test:

- valid authentication
- rejected unauthenticated peers
- request-response correlation
- concurrent requests
- request timeout
- request cancellation
- invalid frame length
- malformed message
- oversized payload
- unknown protocol
- unsupported version
- unknown method
- peer disconnect during request
- event subscription
- service restart
- stale capability
- unauthorized method call
- duplicate idempotency key
- backpressure behavior
- session cleanup after disconnect

Fuzz testing should eventually be added for frame and message parsing.

## Consequences

### Positive consequences

- Platform components remain loosely coupled.
- Framework-specific details stay out of the Runtime.
- Services can move between processes without changing their public contract.
- Applications receive consistent SDK behavior.
- IPC identity supports capability-based security.
- Protocols can evolve independently.
- Testing can use mock peers and services.
- Unix domain sockets provide a practical local transport.
- Typed schemas improve multi-language support.
- Requests, events, and failures become observable.
- Future remote or cross-device transports remain possible.

### Negative consequences

- The project must build and maintain IPC infrastructure.
- Protocol schemas require version discipline.
- Code generation adds build complexity.
- Timeouts and partial failures must be handled everywhere.
- Debugging spans multiple processes.
- Capability and authentication mistakes could create severe security vulnerabilities.
- Binary messages are less directly readable than JSON.
- Service discovery and reconnection add complexity.
- Some high-volume data will require separate data channels.

### Risks

The primary risk is building a generic IPC framework that is more complex than Genesis requires.

To reduce this risk:

- implement only three initial protocols
- begin with narrow operations
- avoid generalized remote communication
- add streaming only when a real service requires it
- keep capability issuance internal at first
- measure message volumes before optimizing

Another risk is allowing public services to expose unrestricted generic method calls.

To reduce this risk:

- define explicit protocol methods
- generate typed clients and servers
- reject unknown methods
- review service contracts as security interfaces
- avoid public dynamic invocation APIs

A third risk is making the Runtime a performance bottleneck by routing every payload through it.

To reduce this risk:

- allow the Runtime to authorize direct scoped connections
- keep policy and identity centralized
- move large data through specialized channels
- measure routing overhead
- preserve the ability to separate control and data paths

## Alternatives Considered

### Direct function calls between platform components

Rejected because major platform components run in separate processes and must remain independently restartable.

Direct calls would also create tight compile-time coupling.

### Shared database as IPC

Rejected because databases do not provide appropriate:

- request-response semantics
- low-latency event delivery
- peer authentication
- cancellation
- lifecycle coordination
- stream management

Databases may store durable state but do not replace IPC.

### Shared files

Rejected because files provide poor coordination, weak event semantics, race conditions, and unclear ownership.

Files may be used for configuration or durable artifacts, not general service communication.

### D-Bus as the permanent platform IPC

D-Bus is a mature Linux IPC system and remains a credible alternative.

It was not selected as the defining SevynOS public IPC architecture because Project Sevyn requires:

- SevynOS-owned identity and capability semantics
- precise application-session integration
- transport abstraction
- controlled public service exposure
- future cross-device evolution
- framework-neutral generated SDKs

D-Bus may still be used internally to integrate with existing Linux services.

SevynOS services should not expose D-Bus-specific types through the public SDK.

### gRPC over Unix sockets

gRPC provides strong schemas, code generation, streaming, and tooling.

It was not selected as the complete core IPC stack because:

- it introduces a larger runtime
- some low-level system operations need file-descriptor passing
- transport and channel control should remain lightweight
- application capability routing may require custom connection behavior
- the project should not commit every platform component to HTTP/2 semantics

Protocol Buffers may still be used without adopting full gRPC.

### JSON-RPC

JSON-RPC is simple and easy to debug.

It was rejected as the permanent core because it offers weaker schema enforcement, less efficient binary data support, and less disciplined cross-language evolution.

It remains acceptable for temporary experiments and developer-facing tools.

### One global message bus

A global bus would simplify service discovery.

It was rejected as the only communication mechanism because:

- every participant could become visible to every other participant
- authorization would be harder to reason about
- a central bus could become a bottleneck
- service-specific connections provide stronger isolation
- high-volume and privileged channels have different requirements

The Runtime service registry may provide bus-like discovery without requiring every message to pass through one global channel.

## Validation Criteria

This decision will be validated when:

1. The Shell launches an application through a versioned Runtime IPC protocol.
2. The Runtime launches the application through a versioned host protocol.
3. The host reports readiness through IPC.
4. The Runtime publishes the lifecycle transition to the Shell.
5. Every connection has a verified peer identity.
6. Unauthorized method calls are rejected.
7. Requests time out cleanly.
8. Connection loss does not corrupt Runtime lifecycle state.
9. The compositor associates a surface with a Runtime session through a trusted protocol.
10. Runtime public contracts contain no React Native or wlroots types.
11. Protocol versions are negotiated explicitly.
12. A mock client can test each protocol without launching the complete platform.

## Revisit Conditions

This decision should be reconsidered if:

- Unix domain sockets cannot meet performance or security requirements
- Protocol Buffers create unacceptable tooling constraints
- file-descriptor passing cannot be integrated safely
- Runtime service routing becomes a bottleneck
- mobile or embedded targets require a different transport
- cross-device services become a primary platform requirement
- another IPC system provides materially stronger security and developer ergonomics
- generated protocols become too difficult for supported languages

A replacement should preserve service identities, protocol versioning, typed contracts, and capability-scoped access.

## Immediate Implementation Tasks

Project Sevyn should now:

1. Define the IPC frame format.
2. Implement a Unix domain socket transport.
3. Create authenticated peer identities.
4. Build request-response correlation.
5. Add request timeouts.
6. Add asynchronous event subscriptions.
7. Implement structured IPC errors.
8. Create an in-memory service registry.
9. Define Runtime–Shell protocol version 1.
10. Define Runtime–Host protocol version 1.
11. Define Runtime–Compositor protocol version 1.
12. Implement mock clients and servers.
13. Connect application launch to the lifecycle manager.
14. Publish lifecycle events to the Shell.
15. Add structured IPC diagnostics.
16. Add malformed-message and disconnect tests.
17. Evaluate Protocol Buffer code generation for TypeScript and C.
18. Create ADR-0010 defining permissions and capability security.

## Final Position

SevynOS will use a service-oriented, message-based IPC architecture.

Unix domain sockets will provide the initial local transport.

Versioned typed protocols will define communication.

The Runtime will establish identity, register services, and authorize access.

Applications will communicate through the Sevyn SDK and scoped capabilities.

Platform components will depend on contracts rather than one another's internal code.

Processes may change.

Implementations may move.

Transports may evolve.

The contract remains the platform.
