# SevynOS community

SevynOS is being built in public. The community is for people who want an open,
user-owned computing platform and are willing to turn that vision into careful,
reviewable work.

## Ways to participate

- **Engineers:** runtime, React Native compatibility, graphics, input, Linux,
  drivers, security, networking, build systems, and applications.
- **Hardware testers:** boot reports with exact model, firmware mode, logs, and
  results for graphics, Wi-Fi, audio, camera, suspend, and input devices.
- **Designers and accessibility reviewers:** interaction states, keyboard
  navigation, contrast, scaling, screen-reader semantics, and visual systems.
- **Technical writers:** setup guides, API documentation, examples, diagrams,
  release notes, and troubleshooting.
- **Maintainers and triagers:** reproduce issues, reduce test cases, connect
  related work, and help contributors find the correct subsystem.

## Where work happens

- GitHub Issues: reproducible defects and accepted, bounded tasks.
- GitHub Discussions: questions, ideas, architecture proposals, and community
  coordination.
- Pull requests: reviewed implementation and documentation changes.
- Architecture decision records: durable changes to platform contracts or
  subsystem ownership.

Until Discussions are enabled, open an issue using the proposal template and
label it as a discussion request.

## A useful hardware report

Include the computer or board model, CPU/GPU, firmware mode, image revision,
boot method, peripheral identifiers (`lspci -nn` or `lsusb` where possible),
what you expected, what happened, and relevant logs. Never publish serial
numbers, Wi-Fi passwords, tokens, private filenames, or personal content.

## How decisions are made

Maintainers judge changes by the documented principles, user impact,
compatibility, security, maintainability, and evidence. Consensus is preferred;
maintainers make the final call when tradeoffs cannot be resolved. Decisions
that change a lasting platform contract should be recorded in an ADR.

Contribution does not guarantee immediate merge or a maintainer role. Sustained,
constructive contributions can lead to triage and review responsibility as the
project grows.

## Current help wanted

The highest-value areas are real hardware coverage, text input and IME support,
accessibility/AT-SPI integration, graphics performance, Wi-Fi and audio device
compatibility, application sandboxing, update/recovery design, installer UX,
and broader React Native/Expo API compatibility.
