# ADR-0014: React Native owns mobile shell presentation

- Status: Accepted
- Date: 2026-08-14

## Context

The mobile host previously mixed two presentation systems. Home was rendered as
a React Native component, while active applications caused the status bar and
dock to be positioned through normalized Genesis overlay nodes. That made shell
layout dependent on a declarative scene description and hid the component tree
that should define the device experience.

React remains declarative at the programming-model level. The distinction in
this decision is that SevynOS shell UI is authored as real React Native
components, not as data records interpreted by a generic shell renderer.

## Decision

The Expo host composes its wallpaper, status bar, launcher, application
viewport, and taskbar directly with React Native. Flex layout, safe areas,
responsive measurements, local interaction state, accessibility, and visual
styling stay in those components.

Device profiles continue to select system-application lifecycles and policy,
but they do not specify visual bounds. Genesis may retain logical application
window and surface state; it does not position or render mobile shell chrome.

The repository architecture test rejects a return of the generic mobile scene
renderer, overlay mounting, or overlay callback path.

## Consequences

- The launcher, taskbar, status bar, and wallpaper have one inspectable React
  Native component tree.
- Shell UI responds to phone and tablet sizes through component layout instead
  of normalized profile coordinates.
- Expo Fast Refresh updates shell visuals through the normal React Native path.
- Runtime and Genesis remain independent of mobile component names and styles.
- Desktop host migration is a separate decision because its Canvas and Linux
  renderers have different platform constraints.
