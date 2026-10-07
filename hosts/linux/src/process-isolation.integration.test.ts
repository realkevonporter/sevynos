import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { notesApplicationBundle, notesManifest } from "@sevynos/app-notes";
import {
  DEFAULT_WORKER_EXECUTION_LIMITS,
  InMemoryApplicationPermissionStore,
  IsolatedApplicationWorkerManager,
  NamespacedApplicationStorage,
  TrustedWorkerServiceBroker,
  VirtualApplicationPackageRepository,
  buildSevynApplicationPackage,
  type SevynApplicationManifest,
} from "@sevynos/react-native/internal";
import { NativeLinuxProcessApplicationExecutor } from "./linux-process-application-executor.js";

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
async function manager(
  runner: string,
  startupTimeoutMs = 2_000,
  manifest: SevynApplicationManifest = notesManifest,
  entry = notesApplicationBundle,
) {
  const repository = new VirtualApplicationPackageRepository();
  await repository.put(
    await buildSevynApplicationPackage({
      manifest,
      files: { [manifest.entrypoint]: entry },
      icons: { [manifest.icon]: "icon" },
    }),
  );
  const permissions = new InMemoryApplicationPermissionStore();
  permissions.set(manifest.id, "notifications", "granted");
  const limits = { ...DEFAULT_WORKER_EXECUTION_LIMITS, startupTimeoutMs };
  return new IsolatedApplicationWorkerManager(
    repository,
    new NativeLinuxProcessApplicationExecutor(runner),
    new TrustedWorkerServiceBroker(
      permissions,
      {
        storage: new NamespacedApplicationStorage(),
        request: () => Promise.resolve(null),
      },
      limits,
    ),
    limits,
  );
}

describe("process-isolated Linux applications", () => {
  it("executes a packaged React Native entrypoint and routes pointer interaction", async () => {
    const manifest: SevynApplicationManifest = {
      ...notesManifest,
      id: "org.sevynos.integration-react-native",
      name: "React Native Integration",
      applicationKey: "main",
      instanceMode: "single",
    };
    const bundle = `(() => {
      const React = globalThis.__SEVYN_MODULES__.react;
      const { AppRegistry, Pressable, Text, View } = globalThis.__SEVYN_MODULES__["react-native"];
      function Application() {
        const [pressed, setPressed] = React.useState(false);
        return React.createElement(View, { accessibilityRole: "application" },
          React.createElement(Text, null, pressed ? "Pointer interaction received" : "Package entrypoint executed"),
          React.createElement(Pressable, { accessibilityLabel: "Activate", onPress: () => setPressed(true) },
            React.createElement(Text, null, "Activate")));
      }
      AppRegistry.registerComponent("main", () => Application);
    })();`;
    const applicationManager = await manager(
      resolve(import.meta.dirname, "../dist/third-party-application-process.js"),
      2_000,
      manifest,
      bundle,
    );
    const launched = await applicationManager.launch(manifest.id);
    let snapshot = applicationManager
      .list()
      .find(({ sessionId }) => sessionId === launched.sessionId);
    for (
      let attempt = 0;
      attempt < 40 && snapshot?.latestSurface === undefined;
      attempt += 1
    ) {
      await pause(50);
      snapshot = applicationManager
        .list()
        .find(({ sessionId }) => sessionId === launched.sessionId);
    }
    expect(JSON.stringify(snapshot?.latestSurface)).toContain(
      "Package entrypoint executed",
    );
    const activate = findAccessibilityNode(
      snapshot?.latestSurface?.accessibility,
      "Activate",
    );
    expect(activate).toBeDefined();
    const point = activate?.bounds as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    for (const type of ["down", "up"] as const)
      applicationManager.deliverEvent(launched.sessionId, {
        kind: "pointer",
        type,
        x: point.x + point.width / 2,
        y: point.y + point.height / 2,
        pointerId: 1,
        button: 0,
      });
    for (
      let attempt = 0;
      attempt < 40 &&
      !JSON.stringify(snapshot?.latestSurface).includes("Pointer interaction received");
      attempt += 1
    ) {
      await pause(50);
      snapshot = applicationManager
        .list()
        .find(({ sessionId }) => sessionId === launched.sessionId);
    }
    expect(JSON.stringify(snapshot?.latestSurface)).toContain(
      "Pointer interaction received",
    );
    await applicationManager.shutdown();
  });

  it("launches Notes in a child process and receives its native surface", async () => {
    const applicationManager = await manager(
      resolve(import.meta.dirname, "../dist/third-party-application-process.js"),
    );
    const launched = await applicationManager.launch(notesManifest.id);
    let snapshot = applicationManager
      .list()
      .find((candidate) => candidate.sessionId === launched.sessionId);
    for (
      let attempt = 0;
      attempt < 40 &&
      (snapshot?.status === "starting" || snapshot?.latestSurface === undefined);
      attempt += 1
    ) {
      await pause(50);
      snapshot = applicationManager
        .list()
        .find((candidate) => candidate.sessionId === launched.sessionId);
    }
    expect(snapshot?.status).toBe("running");
    expect(snapshot?.latestSurface?.commands.length).toBeGreaterThan(0);
    await applicationManager.shutdown();
  });

  it("terminates an infinite-loop process without freezing the host", async () => {
    const applicationManager = await manager(
      resolve(import.meta.dirname, "../dist/hostile-infinite-process.js"),
      30,
    );
    const launched = await applicationManager.launch(notesManifest.id);
    await pause(100);
    expect(
      applicationManager
        .list()
        .find((candidate) => candidate.sessionId === launched.sessionId),
    ).toMatchObject({
      status: "unresponsive",
      metrics: { terminationReason: "startup-timeout" },
    });
  });
});

function findAccessibilityNode(
  nodes: readonly unknown[] | undefined,
  label: string,
): { readonly bounds: unknown } | undefined {
  for (const candidate of nodes ?? []) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const node = candidate as { label?: unknown; bounds?: unknown; children?: unknown };
    if (node.label === label && node.bounds !== undefined) return { bounds: node.bounds };
    const nested = findAccessibilityNode(
      Array.isArray(node.children) ? node.children : [],
      label,
    );
    if (nested !== undefined) return nested;
  }
  return undefined;
}
