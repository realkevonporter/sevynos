# Desktop release and signing

Build production assets with `pnpm desktop:build`. Create unsigned, signing-ready artifacts with `pnpm desktop:package:mac` on macOS or `pnpm desktop:package:linux` on Linux. Artifacts are written under `hosts/desktop/release` and contain no source maps, tests, workspace sources, or development scripts.

## macOS signing and notarization

No credentials are stored in the repository. A future release environment may provide Electron Builder's standard variables:

- `CSC_LINK` — path or base64 value for the Developer ID Application certificate
- `CSC_KEY_PASSWORD` — certificate password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` — notarization credentials

Remove the explicit null development identity in the package configuration, or supply an identity-specific release override, before signed release production. Keep hardened runtime enabled.

## Linux

Run `pnpm desktop:package:linux` on Linux to create the AppImage. Cross-building from macOS is not the supported release path. AppImage tooling may require FUSE only when running the artifact, not when using its extract-and-run mode.

Development builds retain source maps for local debugging. Production packaging excludes them. Never put signing credentials, diagnostics exports, session JSON, or settings JSON in the application resources.
