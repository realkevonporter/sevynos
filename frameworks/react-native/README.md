# @sevynos/react-native

The official React Native platform adapter for SevynOS Genesis desktop and mobile shells.

## Overview

`@sevynos/react-native` maps React Native elements directly to the Sevyn Genesis Render Command Protocol (`NativeRenderCommand`), executing in either an isolated Node/Electron worker or the native Hermes VM on Linux.

## Interactive Controls & Button Chrome

SevynOS supports interactive controls via the `control` render command (`NativeControlCommand`).

### Standard Third-Party Buttons

Third-party applications do not need to register with system settings to render native buttons. `<Pressable>`, `<Button>`, `<TouchableOpacity>`, and `<TouchableHighlight>` all emit `control` commands automatically:

```tsx
import { Pressable, Text, Button } from "react-native";

// Simple button with default SevynOS button chrome
<Pressable onPress={() => console.log("Pressed")}>
  <Text>Click Me</Text>
</Pressable>

// Standard RN Button with custom title & color
<Button title="Save Changes" color="#D7AC57" onPress={handleSave} />

// Fully styled custom Pressable
<Pressable
  onPress={handleCustom}
  style={{
    backgroundColor: "#1E293B",
    borderRadius: 8,
    borderColor: "#38BDF8",
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  }}
>
  <Text style={{ color: "#F8FAFC" }}>Custom Action</Text>
</Pressable>
```

### Button Chrome Capabilities

- **Automatic Chrome**: Buttons with no action prop emit `action: "custom"` with full native button chrome (raised background, rounded corners, and interaction states).
- **Dynamic Interaction Feedback**:
  - `idle`: Renders with `command.background` (`style.backgroundColor` or theme `surfaceRaised`).
  - `hovered`: Renders with a subtle white highlight overlay (`rgba(255, 255, 255, 0.08)`).
  - `pressed`: Renders with `command.accent` background and dark foreground text for clear tactile feedback.
  - `focused`: Renders with a 2px focus border stroke in `command.accent`.
  - `disabled`: Renders at 42% opacity (`context.globalAlpha *= 0.42`).
- **Open Action Extension**: `NativeControlAction` supports `"custom"` and arbitrary extension strings (`(string & {})`). Custom actions will not collide with the Genesis shell's internal settings actions.
