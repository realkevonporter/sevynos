import { useEffect, useMemo, useState, type JSX } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";

import {
  SevynRuntime,
  SevynRuntimeLogger,
  type ApplicationPackage,
  type ApplicationSession,
} from "@sevynos/runtime";

import { helloApplicationPackage } from "./applications/hello-application-package";
import { ApplicationLauncher } from "./components/application-launcher";
import { ApplicationViewport } from "./components/application-viewport";
import { createSevynShellInfrastructure } from "./runtime/create-sevyn-shell-runtime";
import { SafeAreaView } from "react-native-safe-area-context";

interface ShellRuntime {
  readonly runtime: SevynRuntime;
  readonly surfaceStore: ReturnType<
    typeof createSevynShellInfrastructure
  >["surfaceStore"];
}

function createSessionId(): string {
  const runtimeGlobal = globalThis as typeof globalThis & {
    readonly crypto?: {
      readonly randomUUID?: () => string;
    };
  };

  const cryptoObject = runtimeGlobal.crypto;

  if (
    cryptoObject !== undefined &&
    typeof cryptoObject.randomUUID === "function"
  ) {
    return cryptoObject.randomUUID();
  }

  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join("-");
}

function createShellRuntime(): ShellRuntime {
  const logger = new SevynRuntimeLogger();

  const infrastructure = createSevynShellInfrastructure(logger);

  const runtime = new SevynRuntime({
    logger,
    createSessionId,
  });

  runtime.registerApplicationHost(infrastructure.reactNativeHost);

  runtime.registerApplication(helloApplicationPackage);

  return {
    runtime,
    surfaceStore: infrastructure.surfaceStore,
  };
}

export function SevynOSShell(): JSX.Element {
  const shellRuntime = useMemo(createShellRuntime, []);

  const [runtimeReady, setRuntimeReady] = useState(false);

  const [runtimeError, setRuntimeError] = useState<Error>();

  const [activeSession, setActiveSession] = useState<ApplicationSession>();

  const applications = useMemo<readonly ApplicationPackage[]>(
    () => [helloApplicationPackage],
    [],
  );

  useEffect(() => {
    let mounted = true;

    const startRuntime = async (): Promise<void> => {
      try {
        await shellRuntime.runtime.start();

        if (mounted) {
          setRuntimeReady(true);
        }
      } catch (error: unknown) {
        if (!mounted) {
          return;
        }

        setRuntimeError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    void startRuntime();

    return (): void => {
      mounted = false;

      void shellRuntime.runtime.stop("SevynOS shell unmounted.");
    };
  }, [shellRuntime]);

  const launchApplication = async (application: ApplicationPackage): Promise<void> => {
    const result = await shellRuntime.runtime.startApplication(application.manifest.id);

    setActiveSession(result.session);
  };

  const closeApplication = async (session: ApplicationSession): Promise<void> => {
    await shellRuntime.runtime.stopApplication(session.id);

    setActiveSession(undefined);
  };

  if (runtimeError !== undefined) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />

        <View style={styles.centered}>
          <Text style={styles.errorTitle}>SevynOS failed to start</Text>

          <Text style={styles.errorMessage}>{runtimeError.message}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!runtimeReady) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />

        <View style={styles.centered}>
          <ActivityIndicator />

          <Text style={styles.bootText}>Starting SevynOS…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />

      {activeSession === undefined ? (
        <ApplicationLauncher applications={applications} onLaunch={launchApplication} />
      ) : (
        <ApplicationViewport
          store={shellRuntime.surfaceStore}
          session={activeSession}
          onClose={closeApplication}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0d0d0d",
  },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },

  bootText: {
    marginTop: 16,
    color: "#ffffff",
    fontSize: 16,
  },

  errorTitle: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },

  errorMessage: {
    marginTop: 12,
    color: "#b7b7b7",
    fontSize: 14,
    textAlign: "center",
  },
});
