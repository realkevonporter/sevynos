import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { GenesisWindowState } from "@sevynos/genesis";
import { SystemApplicationRuntime, type DeviceDescriptor } from "@sevynos/shell-core";
import {
  BUILTIN_SYSTEM_APPLICATIONS,
  DeviceProfileId,
  SevynShellTheme,
  selectDeviceProfile,
} from "@sevynos/system-applications";
import {
  MobileLauncherApplication,
  MobileStatusBarApplication,
  MobileTaskbarApplication,
  MobileWallpaperApplication,
  TabletHomeApplication,
  type MobileApplicationSummary,
} from "@sevynos/system-applications/mobile";
import {
  SevynRuntime,
  SevynRuntimeLogger,
  type ApplicationPackage,
  type ApplicationSession,
} from "@sevynos/runtime";

import { helloApplicationPackage } from "./applications/hello-application-package";
import { browserApplicationPackage } from "./applications/browser-application-package";
import { ApplicationViewport } from "./components/application-viewport";
import { createShellGenesis, type ShellGenesis } from "./genesis";
import { useGenesisWindows } from "./genesis/use-genesis-windows";
import { useSevynRuntime } from "./runtime";
import { createSevynShellInfrastructure } from "./runtime/create-sevyn-shell-runtime";

interface ShellRuntime {
  readonly runtime: SevynRuntime;

  readonly surfaceStore: ReturnType<
    typeof createSevynShellInfrastructure
  >["surfaceStore"];

  readonly genesis: ShellGenesis;
  readonly shell: SystemApplicationRuntime;
  readonly device: DeviceDescriptor;
  readonly profile: ReturnType<typeof selectDeviceProfile>;
}

// Genesis owns application-window state. React Native owns the visual workspace.
const APPLICATION_WINDOW_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

function createSessionId(): string {
  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join("-");
}

function createShellRuntime(): ShellRuntime {
  const logger = new SevynRuntimeLogger();
  const infrastructure = createSevynShellInfrastructure(logger);
  const genesis = createShellGenesis();
  const runtime = new SevynRuntime({ logger, createSessionId });

  runtime.registerApplicationHost(infrastructure.reactNativeHost);
  runtime.registerApplication(helloApplicationPackage);
  runtime.registerApplication(browserApplicationPackage);

  const screen = Dimensions.get("screen");
  const tablet =
    (Platform.OS === "ios" && Platform.isPad) ||
    Math.min(screen.width, screen.height) >= 600;
  const device = Object.freeze({
    deviceClass: tablet ? ("tablet" as const) : ("mobile" as const),
    width: screen.width,
    height: screen.height,
    pointer: "coarse" as const,
    keyboard: false,
    touch: true,
  });
  const shell = new SystemApplicationRuntime();
  for (const application of BUILTIN_SYSTEM_APPLICATIONS) shell.register(application);
  const profile = selectDeviceProfile(device);

  return {
    runtime,
    surfaceStore: infrastructure.surfaceStore,
    genesis,
    shell,
    device,
    profile,
  };
}

export function SevynOSShell(): JSX.Element {
  const shellRuntime = useMemo(createShellRuntime, []);
  const runtime = useSevynRuntime(shellRuntime.runtime);

  useSyncExternalStore(
    shellRuntime.shell.subscribe.bind(shellRuntime.shell),
    () => shellRuntime.shell.revision,
    () => shellRuntime.shell.revision,
  );

  const windows = useGenesisWindows(shellRuntime.genesis.windowManager);
  const focusedWindow = windows
    .filter((window) => window.state === GenesisWindowState.Foreground)
    .at(-1);
  const activeSession =
    focusedWindow === undefined
      ? undefined
      : runtime.getApplicationSession(focusedWindow.sessionId);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState<Error>();
  const applications = useMemo<readonly ApplicationPackage[]>(
    () => [browserApplicationPackage, helloApplicationPackage],
    [],
  );
  const applicationSummaries = useMemo<readonly MobileApplicationSummary[]>(
    () =>
      applications.map((application) => ({
        id: application.manifest.id,
        name: application.manifest.name,
        subtitle:
          application.manifest.id === browserApplicationPackage.manifest.id
            ? "Chromium-powered web browsing"
            : "A native SevynOS experience",
        accent:
          application.manifest.id === browserApplicationPackage.manifest.id
            ? "#38BDF8"
            : "#7884E8",
        running: windows.some(
          (window) => window.applicationId === application.manifest.id,
        ),
      })),
    [applications, windows],
  );

  useEffect((): (() => void) => {
    let mounted = true;
    const startRuntime = async (): Promise<void> => {
      try {
        await runtime.start();
        await shellRuntime.shell.activate(shellRuntime.profile, shellRuntime.device);
        if (mounted) setRuntimeReady(true);
      } catch (error: unknown) {
        if (mounted) {
          setRuntimeError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    void startRuntime();
    return (): void => {
      mounted = false;
      void Promise.all([
        runtime.stop("SevynOS shell unmounted."),
        shellRuntime.shell.shutdown(),
      ]);
    };
  }, [runtime, shellRuntime]);

  const launchApplication = async (applicationId: string): Promise<void> => {
    const application = applications.find(
      (candidate) => candidate.manifest.id === applicationId,
    );
    if (application === undefined) {
      throw new Error(`Application "${applicationId}" is not registered with the shell.`);
    }
    const existingWindow = windows.find(
      (window) => window.applicationId === application.manifest.id,
    );
    if (existingWindow !== undefined) {
      shellRuntime.genesis.windowManager.focusWindow(existingWindow.id);
      return;
    }

    const result = await runtime.startApplication(application.manifest.id);
    shellRuntime.genesis.windowManager.openWindow({
      id: result.session.id,
      applicationId: application.manifest.id,
      sessionId: result.session.id,
      surfaceId: result.session.id,
      bounds: APPLICATION_WINDOW_BOUNDS,
    });
  };

  const minimizeApplication = (session: ApplicationSession): void => {
    shellRuntime.genesis.windowManager.minimizeWindow(session.id);
  };

  const quitApplication = async (session: ApplicationSession): Promise<void> => {
    shellRuntime.genesis.windowManager.closeWindow(session.id);
    await runtime.stopApplication(session.id);
  };

  let content: JSX.Element;
  if (runtimeError !== undefined) {
    content = (
      <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>SevynOS failed to start</Text>
          <Text style={styles.errorMessage}>{runtimeError.message}</Text>
        </View>
      </SafeAreaView>
    );
  } else if (!runtimeReady) {
    content = (
      <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <ActivityIndicator color={SevynShellTheme.colors.gold} />
          <Text style={styles.bootText}>Starting SevynOS…</Text>
        </View>
      </SafeAreaView>
    );
  } else {
    content = (
      <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.safeArea}>
        <StatusBar hidden />
        <View style={styles.shell}>
          <MobileWallpaperApplication />
          <MobileStatusBarApplication />
          <View style={styles.workspace}>
            {activeSession === undefined ? (
              shellRuntime.profile.id === DeviceProfileId.Tablet ? (
                <TabletHomeApplication
                  applications={applicationSummaries}
                  onLaunch={launchApplication}
                />
              ) : (
                <MobileLauncherApplication
                  applications={applicationSummaries}
                  onLaunch={launchApplication}
                />
              )
            ) : (
              <ApplicationViewport
                session={activeSession}
                store={shellRuntime.surfaceStore}
                onClose={quitApplication}
              />
            )}
          </View>
          <MobileTaskbarApplication
            applications={applicationSummaries}
            {...(activeSession === undefined
              ? {}
              : { activeApplicationId: activeSession.application.manifest.id })}
            onCloseApplication={(): void => {
              if (activeSession !== undefined) void quitApplication(activeSession);
            }}
            onLaunch={launchApplication}
            onOpenHome={(): void => {
              if (activeSession !== undefined) minimizeApplication(activeSession);
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return <SafeAreaProvider>{content}</SafeAreaProvider>;
}

const styles = StyleSheet.create({
  shell: { flex: 1, overflow: "hidden" },
  workspace: { flex: 1, minHeight: 0 },
  safeArea: {
    backgroundColor: SevynShellTheme.colors.background,
    flex: 1,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: SevynShellTheme.spacing.lg,
  },
  bootText: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.body,
    marginTop: SevynShellTheme.spacing.md,
  },
  errorTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.title,
    fontWeight: "700",
    textAlign: "center",
  },
  errorMessage: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.caption,
    marginTop: SevynShellTheme.spacing.sm,
    textAlign: "center",
  },
});
