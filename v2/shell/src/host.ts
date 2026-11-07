// SevynOS host components.
//
// The renderer implements six host component types, addressed by
// string. esbuild's classic JSX transform turns <View> into
// React.createElement(View) — so these constants must be the strings
// themselves, not components. Import them wherever the shell writes JSX.
//
// (Lowercase JSX tags would also work, but capitalized tags read like
// React Native, which is the point of the shell.)

export const View = "View" as const;
export const Text = "Text" as const;
export const Image = "Image" as const;
export const Pressable = "Pressable" as const;
export const ScrollView = "ScrollView" as const;
