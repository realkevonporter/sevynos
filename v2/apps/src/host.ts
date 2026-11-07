// SevynOS host components (same six the renderer implements; see
// v2/shell/src/host.ts — the constants are the strings themselves, not
// components, because esbuild's classic JSX transform turns <View>
// into React.createElement(View)).

export const View = "View" as const;
export const Text = "Text" as const;
export const Image = "Image" as const;
export const Pressable = "Pressable" as const;
export const ScrollView = "ScrollView" as const;
export const TextInput = "TextInput" as const;
