# SevynOS Application Development

Sevyn applications are TypeScript React applications built against the stable public
`@sevynos/react-native` entrypoint. The current application API is `1.0.0`; compatible
additions may be made within version 1, while breaking changes require a new major version.

## Project structure

- `sevyn.manifest.json` declares identity, compatibility, permissions, services, window modes,
  and instance behavior.
- `src/index.ts` exports the application component.
- `icons/` and `assets/` contain package-relative resources.
- `dist/` contains the bundled application and final `.sevynapp` package.

Run `sevyn create <directory> <reverse.domain.id> <name>`, then use `sevyn dev`,
`sevyn build`, `sevyn validate`, and `sevyn package` from the generated project.

On a running SevynOS desktop, Sevyn Studio uses the same bundle and Hermes
pipeline. `Run App` performs a real JSX bundle and Hermes bytecode build; `Deploy
to OS` writes the verified `.sevynapp` package under
`/Applications/Installed/` and saves the current source under
`/Applications/Projects/`. Compiler failures remain visible in the Studio output
panel instead of being reported as a successful run.

## Public API and lifecycle

Import components, design tokens, lifecycle hooks, and `useSevynApplicationSdk` only from
`@sevynos/react-native`. Reconciler, layout, compositor, renderer, runtime, Electron, and Node
modules are private implementation details and are rejected by application lint rules.

Lifecycle hooks expose application, window, theme, workspace, display, and reduced-motion
state. Effects must return cleanup functions for subscriptions and timers. Application crashes
are contained by the native application runtime and display a recovery surface instead of
terminating Genesis.

## Permissions and capabilities

Manifests may request filesystem read/write, clipboard read/write, notifications, network,
location, camera, and microphone. Sensitive permissions begin denied. At launch the SDK contains
only services and methods for permissions the user granted; applications must handle absent
optional capabilities.

Storage is always application-namespaced and quota-limited. The filesystem service is a narrow
virtual filesystem contract, never unrestricted host filesystem access.

## Packaging and integrity

A `.sevynapp` package contains its manifest, bundled JavaScript, assets, icons, optional
migrations, per-file SHA-256 hashes, and a whole-package hash. Signature metadata is reserved for
future production signing. Installation validates compatibility and integrity, requests
permissions, writes atomically, and rolls back failed updates.

## Debugging and testing

`sevyn validate` reports manifest field errors. Development reload preserves explicitly captured
state when possible. Test state, forms, keyboard access, permission denial, storage quotas, and
recovery behavior without importing private modules. Diagnostics shown to users must be sanitized
and must never include note bodies, console input, or other private application content.
