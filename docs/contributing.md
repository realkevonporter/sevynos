# Contributing to SevynOS

SevynOS needs contributors who care about both ambitious platform work and the
small details that make a system dependable. Code, testing, documentation,
design, accessibility review, hardware reports, and issue triage are all useful.

By participating, you agree to follow the project
[Code of Conduct](../CODE_OF_CONDUCT.md).

## License

SevynOS is licensed under the [GNU General Public License v3.0 or later](../LICENSE)
(`GPL-3.0-or-later`). Contributions must be offered under those terms unless
explicitly identified as third-party material with its own compatible license.
Preserve third-party copyright notices and license texts; the project license
does not replace dependency licenses.

## Before you start

1. Search existing issues and discussions before opening a duplicate.
2. For a large feature or architectural change, open a proposal first. Early
   agreement prevents work from landing in the wrong subsystem.
3. Read the relevant architecture decision under `docs/decisions/`.
4. Never include credentials, personal data, proprietary application source,
   signing material, or user diagnostics in a contribution.

Good first contributions are narrow: reproduce a hardware issue, add a missing
test, improve an error state, fix a layout or keyboard interaction, document a
service, or implement one well-defined React Native API.

## Development setup

```sh
git clone https://github.com/realkevonporter/sevynos.git
cd sevynos
corepack enable
pnpm install
pnpm check
```

Node.js 22 or newer is required. Docker is required for reproducible Linux and
live-image builds. Native macOS/iOS packaging additionally requires the Apple
toolchain.

Use a focused test while iterating, then run `pnpm check` before requesting
review. Linux or hardware-facing changes should also run the relevant QEMU,
Wayland, installer, or physical-device path. State exactly what you tested;
source inspection, typechecking, simulation, QEMU, and real hardware are
different levels of evidence.

## Architecture rules

- The Runtime owns identity, lifecycle, packages, sessions, permissions, and
  capability policy.
- React Native owns application presentation and interaction, not privileged
  Linux operations.
- Filesystem, networking, audio, camera, power, and similar behavior belongs
  behind typed services implemented by each host.
- Shell chrome is composed from React Native applications; do not introduce a
  parallel declarative overlay or scene-description system.
- Preserve the working Linux/initramfs/Weston boot path unless an accepted
  architecture proposal explicitly replaces it.
- Compatibility fixes should implement reusable platform behavior. Do not add
  application-name checks or one-off ports for test applications.
- Public API, persisted-data, security-boundary, or subsystem-ownership changes
  require a new or updated architecture decision record.

## Testing an existing React Native app

Use your own application as a compatibility workload. Keep its source outside
this repository unless its license explicitly permits inclusion. Record missing
React Native or native APIs as platform issues, reduce them to reusable tests,
and implement the capability at the framework or host boundary. App-specific
conditionals are not accepted as compatibility fixes.

## Pull requests

Keep a pull request small enough to review. Include:

- the problem and user-visible outcome;
- the architectural boundary affected;
- tests run and their results;
- screenshots for visual changes;
- physical hardware and firmware details for device reports;
- known limitations or follow-up work.

Reviewers may ask for a regression test, clearer failure behavior, or device
evidence. That protects a platform other applications will depend on.

Do not commit `node_modules`, `dist`, `build`, `target`, `release`, `.expo`,
`.turbo`, CocoaPods, logs, disk images, packaged applications, or external test
application source. Run `pnpm clean` to remove generated artifacts.

## Community

Use GitHub Issues for reproducible bugs and bounded work. Use GitHub Discussions
for design questions, contributor coordination, and early proposals. See the
[community guide](community.md) for issue quality, project roles, and ways to
help without writing code.
