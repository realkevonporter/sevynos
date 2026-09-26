# Mobile-shell applications

The Browser and Hello applications in this directory are **intentionally mobile-shell-private**.
They are not duplicates of the shared packages under `applications/*` — they target a
different runtime and cannot share code with them.

## Why they exist separately

`shell/mobile` is a standalone Expo project (own `pnpm-lock.yaml`, `ios/` directory) that
runs on **real React Native** on physical iOS/Android hardware. The shared `applications/*`
packages target the **SevynOS framework** (`@sevynos/react-native`), which is a clean-room
React Native implementation for the SevynOS desktop/Linux shell.

Concretely:

- `browser-application.tsx` uses `react-native-webview` (a real WebView with a native
  backing view). The SevynOS framework has no WebView primitive, so the shared
  `@sevynos/app-browser` (`applications/browser`) is a text-based browser instead.
  The two cannot share an implementation until the framework gains a WebView.
- `hello-application.tsx` is the mobile shell's welcome/onboarding surface. It renders
  with real `react-native` primitives and Expo conventions.

## Contract

Both apps follow the same UX contract as their shared counterparts (same app ids,
same theming via `SevynShellTheme` from `@sevynos/system-applications`), so behavior
stays consistent across the mobile and desktop shells even though the implementations
differ. If you change user-visible behavior in one, mirror it in the other.
