# SevynOS Repository Review and Architecture Refactoring

**Completed:** August 5, 2026
**Scope:** Entire source repository, excluding generated dependencies, build output,
caches, logs, generated code and documentation, packages, and disk images

## Executive outcome

The repository now expresses SevynOS as operating-system responsibilities rather
than implementation buckets. Runtime owns application lifecycle and policy;
graphics owns composition and display; input owns interaction; shells own system
user environments; hosts own platform integration; and framework adapters,
applications, services, SDKs, and tools have distinct locations.

The refactor preserves the active package names and behavior while removing the
runtime's previous ownership of graphics, input, and host implementations. A full
repository quality run passes, including formatting, lint, TypeScript checks,
application and subsystem tests, architecture checks, and production builds.

## Review method and guardrails

- Generated content was inventoried by category and size, but not reviewed as
  source.
- Existing source changes were preserved and incorporated rather than reset.
- Moves retained package names or provided compatibility exports where consumers
  could otherwise break.
- Structural changes were made only when they clarified ownership, removed an
  invalid dependency direction, or reduced repository/tooling overhead.
- Uncertain active code was retained and called out under remaining
  recommendations instead of being deleted speculatively.
- Git history was not rewritten. That would be destructive and is independent of
  source-tree maintainability.

## Phase 1: initial inventory

Before cleanup, the checkout consumed approximately 5 GB. The largest excluded
areas were:

| Excluded area                                     | Approximate size | Classification                   |
| ------------------------------------------------- | ---------------: | -------------------------------- |
| Root and nested `node_modules`                    |           1.3 GB | Reproducible dependencies        |
| QEMU image build directory                        |           1.3 GB | Generated VM/image output        |
| Desktop release packages                          |           872 MB | Generated release output         |
| Rust `target` directory                           |           577 MB | Generated native build output    |
| CocoaPods                                         |           148 MB | Reproducible native dependencies |
| Turbo cache                                       |            38 MB | Reproducible task cache          |
| Other `dist`, `build`, logs, caches, and metadata |         Variable | Generated output                 |

The review identified roughly 492 non-generated files and 49,315 lines before
the reorganization. The `.git` directory itself was approximately 776 MB and was
explicitly excluded from cleanup because reducing it requires a destructive
history-rewrite project.

The main architectural findings were:

1. `runtime/` mixed lifecycle policy with compositor, display, renderer, surface,
   window, input, and host implementations.
2. Linux reused desktop behavior by depending on Electron-owned code, creating a
   host-to-host dependency.
3. React Native framework support lived in a generic `packages/` bucket while
   React Native host integration lived under runtime.
4. The mobile shell and host-neutral desktop shell responsibilities were not
   visible in the directory structure.
5. CLI, demonstration, QEMU, and repository maintenance tools used inconsistent
   locations.
6. Empty top-level placeholders made the repository appear broader and less
   complete than the implemented architecture.
7. Generated Expo metadata was tracked, and ignore/cleanup policies did not cover
   all native and package output.
8. Build and test configuration had no automated guard against the old ownership
   model returning.

## Phase 2: cleanup

### Generated content removed

The dependency trees, QEMU build images, desktop release packages, Rust targets,
CocoaPods, Turbo/Expo caches, compiled output, logs, operating-system metadata,
and package/disk-image artifacts were removed. This eliminated more than 4 GB of
reproducible content from the working tree.

Tracked `.expo` metadata was deleted. Ignore coverage now includes dependencies,
`dist`, `build`, `release`, `target`, generated/artifact/coverage directories,
framework caches, Python caches, CocoaPods, Xcode derived data, logs, temporary
files, packaged applications, and ISO/DMG/AppImage output.

`pnpm clean` now invokes `tools/repository/clean.mjs`. The cleaner verifies the
repository identity and path boundary, refuses to traverse symbolic links,
protects `.git` and third-party source, and removes only explicitly classified
generated directories and extensions. This makes returning to a source-only
checkout repeatable without relying on a broad destructive command.

### Obsolete and misleading content removed

- Removed empty top-level `assets`, `compositor`, `examples`, `packages`,
  `protocols`, `scripts`, and `third_party` placeholders.
- Removed obsolete top-level `future`; its active roadmap note moved to
  `docs/roadmap/future.md`.
- Removed redundant `.gitkeep` files where implemented packages now exist.
- Corrected the malformed ADR-0010 filename and populated the permissions and
  capability-security decision.
- Replaced the empty root license with the complete Apache License 2.0 text at
  the time of this review. The current project license is GPLv3 or later; see
  the root [LICENSE](../LICENSE).
- Retained deliberate roadmap boundaries under `services/`, `sdk/`, `tests/`,
  and `applications/settings/`; these are named responsibilities rather than
  miscellaneous buckets.

## Phase 3: architecture improvements

### Responsibility-based moves

| Previous location                                                         | Current location          | Engineering rationale                                                                            |
| ------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `runtime/src/{compositor,display,renderer,surface,window-surface,window}` | `graphics/core/src/`      | Graphics can evolve and test independently; runtime no longer owns display behavior.             |
| `runtime/src/input`                                                       | `input/src/input`         | Input devices, focus, hit testing, drag, resize, and routing form an independent subsystem.      |
| `runtime/src/hosts/javascript`                                            | `hosts/javascript/src`    | Execution adapters belong to the platform/host boundary, not lifecycle policy.                   |
| `runtime/src/hosts/react-native`                                          | `hosts/react-native/src`  | Separates framework hosting from both runtime and host-independent framework support.            |
| `packages/react-native`                                                   | `frameworks/react-native` | Framework responsibility is explicit; the generic implementation-language bucket is gone.        |
| `genesis`                                                                 | `graphics/genesis`        | Keeps the active mobile scene implementation under graphics while preserving `@sevynos/genesis`. |
| Host-neutral code in `hosts/desktop`                                      | `shell/desktop`           | Electron and Linux now share a shell instead of one host importing another host.                 |
| Existing Expo shell                                                       | `shell/mobile`            | Makes mobile and desktop shell variants explicit without changing `@sevynos/shell`.              |
| `tools/sevyn-cli`                                                         | `tools/cli`               | Removes redundant naming and keeps developer tooling together.                                   |
| `runtime/src/demo.ts`                                                     | `tools/demo`              | A runnable example is tooling, not runtime production code.                                      |
| `qemu`                                                                    | `tools/qemu`              | Reproducible image creation and launch scripts are development/release tools.                    |

### Package boundaries and dependency rules

- Added `@sevynos/graphics`, with no workspace dependencies.
- Added `@sevynos/input`, depending only on graphics contracts.
- Kept runtime production source independent of graphics, input, frameworks, and
  hosts. Runtime coordinates through application lifecycle interfaces rather
  than importing concrete subsystems.
- Added `@sevynos/desktop-shell` for shared desktop runtime, layout, persistence,
  settings, diagnostics, recovery, scene composition, and window-control logic.
- Electron and Linux both depend on the desktop shell. Linux no longer depends
  on `@sevynos/desktop-host`.
- Added dedicated JavaScript and React Native host packages that consume the
  public runtime API.
- Preserved runtime-facing lifecycle return types with a runtime-owned lifecycle
  controller while graphics uses only the narrow lifecycle contract it needs.
- Kept `hosts/desktop/src/core.ts` as a compatibility re-export of the new
  desktop-shell API.
- Moved the pointer-focus/window-manager cross-subsystem test to runtime
  integration tests, where composition behavior belongs.
- Updated workspace globs, package manifests, TypeScript project references,
  aliases, lint scope, QEMU paths, Docker copy paths, documentation, and the
  lockfile together.

The resulting composition model is:

```text
applications -> frameworks
input        -> graphics
runtime      -> no concrete host/graphics/input/framework package
shells       -> runtime + graphics + input + frameworks/applications
hosts        -> the shell and subsystem APIs required by each platform
tools        -> public packages needed by the workflow they execute
```

This graph prevents cycles and makes package-level build caching meaningful.

### Tooling, documentation, and production readiness

- Added architecture tests that prevent retired buckets, graphics/input imports
  in runtime production source, and the Linux-to-Electron dependency from
  returning.
- Made desktop, Linux, and demo entry points build their complete workspace
  dependency graph, so documented commands work immediately after a clean
  installation without requiring a separate repository-wide build.
- Added a GitHub Actions quality workflow for the complete JavaScript/TypeScript
  gate and an Ubuntu-native job for the Wayland bridge.
- Corrected Turbo test outputs so cache metadata matches what test tasks actually
  produce and no longer emits false missing-output warnings.
- Added explicit repository setup, map, commands, contributor rules, glossary,
  roadmap, kernel scope, and responsibility-boundary ADR documentation.
- Standardized Genesis/mobile TypeScript on the workspace catalog, removed
  obsolete React/React Native type dependencies from the graphics package, and
  assigned `tsx` to the Linux package that actually uses it. The installed
  workspace dependency count decreased from 777 to 772 packages.

## Behavior and compatibility

Public package names used by active consumers were retained:
`@sevynos/runtime`, `@sevynos/react-native`, `@sevynos/genesis`,
`@sevynos/shell`, and `@sevynos/cli`. Imports were updated repository-wide, and
the compatibility desktop core export prevents the shell extraction from
forcing an immediate consumer migration.

The only build defect found during validation was a desktop asset-copy path that
still referenced the pre-move `shell/ios` directory. It now resolves the same
icon from `shell/mobile/ios`; the packaged asset and behavior are unchanged.

## Performance impact

This project intentionally avoided speculative runtime optimization. The
measurable improvements are structural:

- More than 4 GB of generated content no longer burdens repository traversal,
  indexing, backups, or source review.
- Graphics, input, runtime, shells, and hosts now have separate TypeScript/Turbo
  boundaries, so a local change invalidates fewer unrelated tasks and independent
  work can execute in parallel.
- Correct test-output declarations avoid unnecessary cache bookkeeping and
  misleading warnings.
- Removing unused direct development dependencies reduced installation and
  audit surface.

The existing focus-latency benchmark passed with 20 samples: 5.837 ms minimum,
7.202 ms median, 10.546 ms p95, and 18.961 ms maximum. It produced at most one
frame per click, confirming that the structural moves did not regress the tested
interaction path.

## Phase 4: validation results

| Check                                           | Result                                 |
| ----------------------------------------------- | -------------------------------------- |
| Prettier repository check                       | Passed                                 |
| ESLint                                          | 14/14 package tasks passed             |
| TypeScript/project references                   | 23/23 tasks passed                     |
| Repository and QEMU configuration tests         | 6/6 assertions passed                  |
| Package/unit/integration tests                  | 863/863 assertions passed              |
| Total automated assertions                      | 869/869 passed                         |
| Production package builds                       | 13/13 build tasks passed               |
| Workspace peer dependency check                 | Passed with no peer issues             |
| Relative import and manifest consistency checks | Passed                                 |
| Git whitespace/error check                      | Passed                                 |
| Focus latency benchmark                         | Passed; 7.202 ms median, 10.546 ms p95 |

The Rust Wayland bridge cannot compile directly on macOS because
`smithay-client-toolkit` correctly relies on Linux-only `rustix` pipe APIs. This
is a platform constraint, not a SevynOS source regression. The new Ubuntu CI job
runs `cargo test --locked` with the required native packages. A local Docker
daemon is available, but its Linux base images were not cached, so a large image
download was intentionally not added to this cleanup run.

Full QEMU ISO creation and boot smoke testing were also not repeated because
those workflows regenerate the largest artifacts removed by this task. QEMU
display configuration, layout, and Linux host behavior tests passed; a full
image smoke test remains a release gate.

## Remaining recommendations

1. **Unify the two graphics models deliberately.** `graphics/genesis` is an
   active, smaller mobile scene/window model, while `graphics/core` is the
   desktop-oriented engine. ADR-0012 records this as an intentional compatibility
   boundary. Merge them only with dedicated mobile behavior tests; deleting or
   adapting it during this structural pass would be speculative.
2. **Run the Linux-native CI/Docker gate before release.** macOS cannot validate
   the Smithay bridge directly. The repository now automates the correct Ubuntu
   test, and `native:docker:test` remains available for a local release check.
3. **Run a full QEMU smoke test for release candidates.** The lightweight QEMU
   configuration and layout tests are part of the normal quality gate; image
   construction and boot testing should remain an explicit, artifact-producing
   release workflow.
4. **Populate or retire roadmap placeholders.** `services`, `sdk`, cross-system
   `tests`, and Settings were retained because they match the declared target
   architecture. Remove a boundary if it leaves the roadmap rather than allowing
   indefinite empty structure.
5. **Treat Git-history size separately.** The approximately 776 MB `.git`
   directory was preserved. If clone size becomes a concern, perform an audited
   large-object/LFS analysis with backups and contributor coordination rather
   than rewriting history as routine cleanup.
6. **Upgrade deprecated transitive tooling dependencies through their owners.**
   Five deprecated transitive packages remain in the lockfile. They are not
   direct SevynOS dependencies and should be removed through tested Electron or
   build-tool upgrades rather than forced resolutions.

## Final architecture

```text
SevynOS/
├── applications/  system and example applications
├── docs/          architecture, decisions, guides, and roadmap
├── frameworks/    host-independent framework integrations
├── graphics/      graphics core and active Genesis mobile compatibility model
├── hosts/         Electron, JavaScript, Linux, and React Native adapters
├── input/         device, event, focus, gesture, and pointer interaction
├── kernel/        low-level Linux, boot, and hardware boundary
├── runtime/       application lifecycle, policy, packages, and sessions
├── sdk/           public developer SDK boundary
├── services/      reusable operating-system service boundary
├── shell/         host-independent desktop and mobile system environments
├── tests/         future cross-subsystem/performance/security suites
└── tools/         CLI, demo, QEMU, and safe repository utilities
```

The repository is now organized around what SevynOS does, and the automated
architecture checks make that organization enforceable rather than merely
documented.
