import { createElement, type ReactElement } from "react";
import {
  SafeAreaView,
  SevynApplicationSdkProvider,
  StyleSheet,
  Text,
  View,
  resolveSevynColors,
  useOptionalSevynApplicationSdk,
  type SevynApplicationManifest,
  type SevynApplicationSdk,
  type SevynFileSystem,
  type SevynSemanticColors,
  type SystemNotificationService,
} from "@sevynos/react-native";
import { TextEditorApplication as CoreTextEditorApplication } from "@sevynos/core-applications";

export const textEditorManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.text-editor",
  name: "Text Editor",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "TextEditor",
  developer: "SevynOS",
  icon: "icons/text-editor.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["filesystem.read", "filesystem.write", "notifications"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "multiple",
};

export const textEditorApplicationBundle = `(() => {
  const { AppRegistry } = globalThis.__SEVYN_MODULES__["react-native"];
  const { TextEditorApplication } = globalThis.__SEVYN_MODULES__["@sevynos/app-text-editor"];
  AppRegistry.registerComponent("TextEditor", () => TextEditorApplication);
})();`;

export interface TextEditorApplicationProps {
  readonly filesystem?: Pick<SevynFileSystem, "list" | "read" | "write"> | undefined;
  readonly notifications?: Pick<SystemNotificationService, "show"> | undefined;
}

/**
 * Resolves the filesystem the editor needs from either explicit props (in-shell
 * hosts) or the application SDK (isolated workers). Returns undefined when the
 * host did not grant filesystem access, so the UI can say so honestly instead
 * of crashing on the first file operation.
 */
export function resolveTextEditorFilesystem(
  candidate: Partial<Pick<SevynFileSystem, "list" | "read" | "write">> | undefined,
): Pick<SevynFileSystem, "list" | "read" | "write"> | undefined {
  if (candidate === undefined) return undefined;
  const { list, read, write } = candidate;
  if (
    typeof list !== "function" ||
    typeof read !== "function" ||
    typeof write !== "function"
  )
    return undefined;
  return { list, read, write };
}

/**
 * Standalone Text Editor application. Reuses the `@sevynos/core-applications`
 * editor factory — the single implementation — and only adapts how it receives
 * its filesystem and notification services.
 */
export function TextEditorApplication(
  props: TextEditorApplicationProps = {},
): ReactElement {
  const sdk = useOptionalSevynApplicationSdk();
  const filesystem = resolveTextEditorFilesystem(props.filesystem ?? sdk?.filesystem);
  const notifications = props.notifications ?? sdk?.notifications;
  if (filesystem === undefined) {
    const colors = resolveSevynColors(
      sdk?.theme.appearance ?? "dark",
      sdk?.theme.accent ?? "gold",
    );
    return <TextEditorFilesystemUnavailable colors={colors} />;
  }
  return createElement(CoreTextEditorApplication, {
    filesystem,
    ...(notifications === undefined ? {} : { notifications }),
  });
}

function TextEditorFilesystemUnavailable(props: {
  readonly colors: SevynSemanticColors;
}): ReactElement {
  const colors = props.colors;
  return (
    <SafeAreaView
      id="text-editor.app"
      label="Text Editor"
      role="application"
      style={{
        align: "center",
        backgroundColor: colors.canvas,
        flexGrow: 1,
        justify: "center",
        padding: 24,
      }}
    >
      <View
        id="text-editor.unavailable.card"
        style={{
          align: "center",
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          gap: 10,
          maxWidth: 380,
          padding: 24,
          radius: 14,
          width: "100%",
        }}
      >
        <Text
          id="text-editor.unavailable.title"
          role="heading"
          style={{
            color: colors.text,
            fontSize: 18,
            fontWeight: 700,
            textAlign: "center",
          }}
          text="Filesystem access unavailable"
        />
        <Text
          id="text-editor.unavailable.message"
          style={{ color: colors.textSecondary, fontSize: 13, textAlign: "center" }}
          text="Text Editor needs filesystem permission to open and save documents. Grant it in Settings, then reopen the editor."
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  providerRoot: { flexGrow: 1 },
});

export function createTextEditorApplicationElement(
  sdk: SevynApplicationSdk,
): ReactElement {
  return createElement(
    SevynApplicationSdkProvider,
    { sdk },
    createElement(
      View,
      { style: styles.providerRoot },
      createElement(TextEditorApplication),
    ),
  ) as ReactElement;
}
