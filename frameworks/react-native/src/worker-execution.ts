import {
  verifyPackageIntegrity,
  type ApplicationPackageRepository,
  type ApplicationPermissionStore,
  type NamespacedApplicationStorage,
  type SevynApplicationPackage,
  type SevynPermission,
} from "./application-platform.js";
import {
  protocolMessageSize,
  validateWorkerHostMessage,
  type HostWorkerMessage,
  type StructuredValue,
  type WorkerHostMessage,
  type WorkerLifecycleState,
  type WorkerServiceName,
} from "./worker-protocol.js";

export interface ApplicationWorkerDescriptor {
  readonly applicationId: string;
  readonly sessionId: string;
  readonly applicationPackage: SevynApplicationPackage;
}
export interface ApplicationWorkerTransport {
  post(message: HostWorkerMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  subscribeError(listener: (error: Error) => void): () => void;
  terminate(reason: string): Promise<void>;
  memoryUsage?(): Promise<number | undefined>;
}
export interface ApplicationWorkerExecutor {
  readonly isolation?: "process" | "worker";
  create(descriptor: ApplicationWorkerDescriptor): Promise<ApplicationWorkerTransport>;
}
export interface WorkerExecutionLimits {
  readonly startupTimeoutMs: number;
  readonly eventTimeoutMs: number;
  readonly serviceTimeoutMs: number;
  readonly updateTimeoutMs: number;
  readonly maximumInboundQueue: number;
  readonly maximumOutboundQueue: number;
  readonly maximumMessageBytes: number;
  readonly maximumInvalidationsPerSecond: number;
  readonly maximumNotificationsPerMinute: number;
  readonly maximumDeadlineFailures: number;
}
export const DEFAULT_WORKER_EXECUTION_LIMITS: WorkerExecutionLimits = Object.freeze({
  startupTimeoutMs: 2_000,
  eventTimeoutMs: 250,
  serviceTimeoutMs: 30_000,
  updateTimeoutMs: 500,
  maximumInboundQueue: 128,
  maximumOutboundQueue: 128,
  maximumMessageBytes: 256 * 1024,
  maximumInvalidationsPerSecond: 60,
  maximumNotificationsPerMinute: 20,
  maximumDeadlineFailures: 2,
});
export interface ApplicationWorkerMetrics {
  readonly inboundMessages: number;
  readonly outboundMessages: number;
  readonly inboundQueueDepth: number;
  readonly outboundQueueDepth: number;
  readonly averageEventDuration: number;
  readonly timeoutCount: number;
  readonly restartCount: number;
  readonly memoryBytes?: number;
  readonly terminationReason?: string;
}
export interface WorkerDiagnosticEntry {
  readonly timestamp: number;
  readonly severity: "debug" | "info" | "warning" | "error";
  readonly event: string;
  readonly message: string;
}
export interface ApplicationWorkerSnapshot {
  readonly applicationId: string;
  readonly sessionId: string;
  readonly status: WorkerLifecycleState;
  readonly metrics: ApplicationWorkerMetrics;
  readonly diagnostics: readonly WorkerDiagnosticEntry[];
  readonly latestSurface?: {
    readonly revision: number;
    readonly commands: readonly StructuredValue[];
    readonly accessibility: readonly StructuredValue[];
  };
}
export interface WorkerServiceBrokerProviders {
  readonly storage: Pick<NamespacedApplicationStorage, "get" | "set">;
  readonly request: (
    applicationId: string,
    service: WorkerServiceName,
    argumentsValue: StructuredValue,
  ) => Promise<StructuredValue>;
}
export class WorkerPolicyViolationError extends Error {}
const servicePermission = (service: WorkerServiceName): SevynPermission | undefined => {
  switch (service) {
    case "filesystem.list":
    case "filesystem.read":
      return "filesystem.read";
    case "filesystem.write":
      return "filesystem.write";
    case "clipboard.read":
      return "clipboard.read";
    case "clipboard.write":
      return "clipboard.write";
    case "notifications.show":
      return "notifications";
    case "network.request":
    case "websocket.open":
    case "websocket.send":
    case "websocket.receive":
    case "websocket.close":
    case "image.load":
    case "linking.open":
      return "network";
    case "location.current":
      return "location";
    case "camera.capture":
    case "camera.recordStart":
    case "camera.recordStop":
    case "camera.preview":
    case "camera.readImage":
    case "camera.status":
    case "camera.torch":
      return "camera";
    case "battery.status":
      return "battery";
    case "display.brightness.get":
    case "display.brightness.set":
    case "display.orientation.get":
    case "display.orientation.lock":
    case "display.autoBrightness.get":
    case "display.autoBrightness.set":
    case "display.wakeLock.acquire":
    case "display.wakeLock.release":
      return "display";
    case "audio.outputs.get":
    case "audio.output.set":
      return "audio";
    case "vibration.vibrate":
    case "vibration.cancel":
      return "vibration";
    case "nfc.status":
    case "nfc.scan":
    case "nfc.write":
      return "nfc";
    case "cellular.status":
    case "cellular.signal":
    case "cellular.bearer":
    case "cellular.dial":
    case "cellular.hangup":
    case "cellular.answer":
    case "cellular.sms.send":
    case "cellular.sms.list":
      return "cellular";
    case "microphone.record":
    case "microphone.start":
    case "microphone.stop":
      return "microphone";
    case "bluetooth.scan":
      return "bluetooth";
    case "sensors.read":
    case "sensors.subscribe":
    case "sensors.unsubscribe":
      return "sensors";
    case "biometrics.authenticate":
    case "biometrics.enroll":
    case "biometrics.delete":
    case "biometrics.list":
    case "biometrics.pin.verify":
    case "biometrics.keystore.get":
    case "biometrics.keystore.set":
    case "biometrics.keystore.delete":
    case "biometrics.keystore.list":
      return "biometrics";
    case "media.play":
    case "media.pause":
    case "media.resume":
    case "media.stop":
    case "media.seek":
    case "media.volume":
    case "media.status":
    case "media.scan":
      return "media";
    case "native.invoke":
      return "native-modules";
    case "webview.open":
    case "webview.action":
    case "webview.close":
      return "network";
    case "storage.get":
    case "storage.set":
    case "accessibility.state":
    case "accessibility.announce":
    case "network.info":
      return undefined;
  }
};
export class TrustedWorkerServiceBroker {
  readonly #notificationTimes = new Map<string, number[]>();
  public constructor(
    readonly permissions: ApplicationPermissionStore,
    readonly providers: WorkerServiceBrokerProviders,
    readonly limits: WorkerExecutionLimits = DEFAULT_WORKER_EXECUTION_LIMITS,
    readonly now: () => number = Date.now,
  ) {}
  public async request(
    applicationId: string,
    lifecycle: WorkerLifecycleState,
    service: WorkerServiceName,
    argumentsValue: StructuredValue,
  ): Promise<StructuredValue> {
    if (lifecycle !== "running" && lifecycle !== "starting")
      throw new Error("Application is not in a service-capable lifecycle state.");
    const permission = servicePermission(service);
    if (
      permission !== undefined &&
      this.permissions.get(applicationId, permission) !== "granted"
    )
      throw new WorkerPolicyViolationError(
        `Application is not authorized for ${service}.`,
      );
    if (service === "notifications.show") this.#checkNotificationRate(applicationId);
    if (service === "storage.get") {
      if (typeof argumentsValue !== "string")
        throw new Error("storage.get expects a key.");
      return (await this.providers.storage.get(applicationId, argumentsValue)) ?? null;
    }
    if (service === "storage.set") {
      const values = structuredRecord(argumentsValue);
      if (
        values === undefined ||
        typeof values["key"] !== "string" ||
        typeof values["value"] !== "string"
      )
        throw new Error("storage.set expects string key and value fields.");
      await this.providers.storage.set(applicationId, values["key"], values["value"]);
      return null;
    }
    return this.providers.request(applicationId, service, argumentsValue);
  }
  #checkNotificationRate(applicationId: string): void {
    const threshold = this.now() - 60_000;
    const recent = (this.#notificationTimes.get(applicationId) ?? []).filter(
      (timestamp) => timestamp >= threshold,
    );
    if (recent.length >= this.limits.maximumNotificationsPerMinute)
      throw new WorkerPolicyViolationError(
        "Application notification rate limit exceeded.",
      );
    recent.push(this.now());
    this.#notificationTimes.set(applicationId, recent);
  }
}

interface MutableWorkerRecord {
  readonly applicationId: string;
  readonly sessionId: string;
  applicationPackage: SevynApplicationPackage;
  transport: ApplicationWorkerTransport;
  status: WorkerLifecycleState;
  inboundMessages: number;
  outboundMessages: number;
  inboundQueueDepth: number;
  outboundQueueDepth: number;
  totalEventDuration: number;
  completedEvents: number;
  timeoutCount: number;
  restartCount: number;
  terminationReason?: string;
  memoryBytes?: number;
  latestSurface?: ApplicationWorkerSnapshot["latestSurface"];
  readonly diagnostics: WorkerDiagnosticEntry[];
  invalidationTimes: number[];
  unsubscribe: () => void;
  unsubscribeError: () => void;
  startupTimer?: ReturnType<typeof setTimeout>;
  renderTimer?: ReturnType<typeof setTimeout>;
  readonly eventTimers: Map<string, ReturnType<typeof setTimeout>>;
  nextEvent: number;
  sequence: number;
  inboundSequence: number;
}
export class IsolatedApplicationWorkerManager {
  readonly #records = new Map<string, MutableWorkerRecord>();
  readonly #disabled = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #nextSession = 0;
  public constructor(
    readonly repository: ApplicationPackageRepository,
    readonly executor: ApplicationWorkerExecutor,
    readonly broker: TrustedWorkerServiceBroker,
    readonly limits: WorkerExecutionLimits = DEFAULT_WORKER_EXECUTION_LIMITS,
    readonly now: () => number = Date.now,
  ) {}
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  public list(): readonly ApplicationWorkerSnapshot[] {
    return Object.freeze(
      [...this.#records.values()].map((record) => this.#snapshot(record)),
    );
  }
  public isDisabled(applicationId: string): boolean {
    return this.#disabled.has(applicationId);
  }
  public disable(applicationId: string): void {
    this.#disabled.add(applicationId);
    for (const record of this.#records.values())
      if (record.applicationId === applicationId)
        void this.#terminate(record, "application-disabled", "disabled");
  }
  public enable(applicationId: string): void {
    this.#disabled.delete(applicationId);
    this.#notify();
  }
  public async launch(applicationId: string): Promise<ApplicationWorkerSnapshot> {
    if (this.#disabled.has(applicationId))
      throw new Error(`Application "${applicationId}" is disabled.`);
    const applicationPackage = await this.repository.get(applicationId);
    if (applicationPackage === undefined)
      throw new Error(`Application "${applicationId}" is not installed.`);
    await verifyPackageIntegrity(applicationPackage);
    const persistedState = await this.#persistedState(applicationId);
    this.#nextSession += 1;
    const sessionId = `worker-session-${String(this.#nextSession)}`;
    const transport = await this.executor.create({
      applicationId,
      sessionId,
      applicationPackage,
    });
    const record: MutableWorkerRecord = {
      applicationId,
      sessionId,
      applicationPackage,
      transport,
      status: "starting",
      inboundMessages: 0,
      outboundMessages: 0,
      inboundQueueDepth: 0,
      outboundQueueDepth: 0,
      totalEventDuration: 0,
      completedEvents: 0,
      timeoutCount: 0,
      restartCount: 0,
      diagnostics: [],
      invalidationTimes: [],
      unsubscribe: () => undefined,
      unsubscribeError: () => undefined,
      sequence: 0,
      inboundSequence: 0,
      eventTimers: new Map(),
      nextEvent: 0,
    };
    record.unsubscribe = transport.subscribe((message) => {
      void this.#receive(record, message);
    });
    record.unsubscribeError = transport.subscribeError((error) => {
      this.#diagnostic(record, "error", "worker-error", error.message);
      void this.#terminate(record, "worker-error", "crashed");
    });
    this.#records.set(sessionId, record);
    record.startupTimer = setTimeout(() => {
      record.timeoutCount += 1;
      void this.#terminate(record, "startup-timeout", "unresponsive");
    }, this.limits.startupTimeoutMs);
    this.#send(record, {
      protocolVersion: 1,
      applicationId,
      sessionId,
      sequence: this.#nextSequence(record),
      type: "initialize",
      manifest: manifestPayload(applicationPackage),
      applicationKey: applicationPackage.manifest.applicationKey,
      bundleSource:
        applicationPackage.files[applicationPackage.manifest.entrypoint] ?? "",
      grantedPermissions: applicationPackage.manifest.permissions.filter(
        (permission) =>
          this.broker.permissions.get(applicationId, permission) === "granted",
      ),
      persistedState,
    });
    this.#notify();
    return this.#snapshot(record);
  }
  public deliverEvent(sessionId: string, event: StructuredValue): void {
    const record = this.#require(sessionId);
    if (record.status !== "running") return;
    record.nextEvent += 1;
    const eventId = `event-${String(record.nextEvent)}`;
    const started = this.now();
    const timer = setTimeout(() => {
      record.eventTimers.delete(eventId);
      record.timeoutCount += 1;
      if (record.timeoutCount >= this.limits.maximumDeadlineFailures)
        void this.#terminate(record, "event-timeout", "unresponsive");
    }, this.limits.eventTimeoutMs);
    record.eventTimers.set(eventId, timer);
    this.#send(record, {
      protocolVersion: 1,
      applicationId: record.applicationId,
      sessionId,
      sequence: this.#nextSequence(record),
      type: "event",
      eventId,
      event,
    });
    record.totalEventDuration += this.now() - started;
  }
  public async restart(sessionId: string): Promise<ApplicationWorkerSnapshot> {
    const record = this.#require(sessionId);
    const applicationId = record.applicationId;
    const restarts = record.restartCount + 1;
    await this.#terminate(record, "restart", "terminated");
    const next = await this.launch(applicationId);
    const nextRecord = this.#require(next.sessionId);
    nextRecord.restartCount = restarts;
    return this.#snapshot(nextRecord);
  }
  public async hotReload(sessionId: string): Promise<ApplicationWorkerSnapshot> {
    const record = this.#require(sessionId);
    if (this.executor.isolation === "worker") {
      const replacement = await this.repository.get(record.applicationId);
      if (replacement === undefined)
        throw new Error(`Application "${record.applicationId}" is not installed.`);
      await verifyPackageIntegrity(replacement);
      record.applicationPackage = replacement;
      this.#send(record, {
        protocolVersion: 1,
        applicationId: record.applicationId,
        sessionId,
        sequence: this.#nextSequence(record),
        type: "reload",
        applicationKey: replacement.manifest.applicationKey,
        bundleSource: replacement.files[replacement.manifest.entrypoint] ?? "",
      });
      record.restartCount += 1;
      return this.#snapshot(record);
    }
    return this.restart(sessionId);
  }
  public async terminate(sessionId: string, reason = "requested"): Promise<void> {
    await this.#terminate(this.#require(sessionId), reason, "terminated");
  }
  public async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#records.values()].map((record) =>
        this.#terminate(record, "desktop-shutdown", "terminated"),
      ),
    );
  }
  async #receive(record: MutableWorkerRecord, raw: unknown): Promise<void> {
    if (record.status === "terminated" || record.status === "disabled") return;
    record.inboundQueueDepth += 1;
    if (record.inboundQueueDepth > this.limits.maximumInboundQueue) {
      await this.#terminate(record, "inbound-queue-flood", "terminated");
      return;
    }
    try {
      if (!isMessageWithinLimit(raw, this.limits.maximumMessageBytes))
        throw new Error("Worker message exceeds the maximum size.");
      const message = validateWorkerHostMessage(raw);
      if (
        message.applicationId !== record.applicationId ||
        message.sessionId !== record.sessionId
      )
        throw new Error("Worker identity does not match its session.");
      if (message.sequence <= record.inboundSequence)
        throw new Error("Worker message sequence is stale or out of order.");
      record.inboundSequence = message.sequence;
      record.inboundMessages += 1;
      await this.#handle(record, message);
    } catch (error: unknown) {
      this.#diagnostic(
        record,
        "error",
        "protocol-violation",
        error instanceof Error ? error.message : "Malformed worker message.",
      );
      await this.#terminate(record, "protocol-violation", "terminated");
    } finally {
      record.inboundQueueDepth = Math.max(0, record.inboundQueueDepth - 1);
      this.#notify();
    }
  }
  async #handle(record: MutableWorkerRecord, message: WorkerHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        if (record.startupTimer !== undefined) clearTimeout(record.startupTimer);
        record.status = "running";
        this.#send(record, {
          protocolVersion: 1,
          applicationId: record.applicationId,
          sessionId: record.sessionId,
          sequence: this.#nextSequence(record),
          type: "mount",
          viewport: null,
        });
        record.renderTimer = setTimeout(() => {
          record.timeoutCount += 1;
          void this.#terminate(record, "render-timeout", "unresponsive");
        }, this.limits.updateTimeoutMs);
        return;
      case "surface": {
        if (record.renderTimer !== undefined) clearTimeout(record.renderTimer);
        const threshold = this.now() - 1_000;
        record.invalidationTimes = record.invalidationTimes.filter(
          (time) => time >= threshold,
        );
        if (
          record.invalidationTimes.length >= this.limits.maximumInvalidationsPerSecond
        ) {
          await this.#terminate(record, "invalidation-flood", "terminated");
          return;
        }
        record.invalidationTimes.push(this.now());
        record.latestSurface = Object.freeze({
          revision: message.revision,
          commands: message.commands,
          accessibility: message.accessibility,
        });
        return;
      }
      case "service-request": {
        const started = this.now();
        try {
          const value = await withDeadline(
            this.broker.request(
              record.applicationId,
              record.status,
              message.service,
              message.arguments,
            ),
            this.limits.serviceTimeoutMs,
          );
          this.#respond(record, message.requestId, true, value);
        } catch (error: unknown) {
          if (error instanceof DeadlineError) record.timeoutCount += 1;
          this.#respond(record, message.requestId, false, "Service request denied.");
          if (error instanceof WorkerPolicyViolationError) {
            await this.#terminate(record, "unauthorized-capability", "terminated");
            return;
          }
          if (record.timeoutCount >= this.limits.maximumDeadlineFailures)
            await this.#terminate(record, "repeated-deadline-failure", "unresponsive");
        } finally {
          record.totalEventDuration += this.now() - started;
          record.completedEvents += 1;
        }
        return;
      }
      case "diagnostic":
        this.#diagnostic(
          record,
          message.severity,
          message.event,
          "Sandboxed application diagnostic content was redacted.",
        );
        return;
      case "heartbeat":
        return;
      case "event-complete": {
        const timer = record.eventTimers.get(message.eventId);
        if (timer !== undefined) clearTimeout(timer);
        record.eventTimers.delete(message.eventId);
        record.totalEventDuration += Math.max(0, message.durationMs);
        record.completedEvents += 1;
        return;
      }
      case "shutdown-complete":
        await this.#terminate(record, "shutdown-complete", "terminated");
    }
  }
  #respond(
    record: MutableWorkerRecord,
    requestId: string,
    ok: boolean,
    value: StructuredValue,
  ): void {
    this.#send(record, {
      protocolVersion: 1,
      applicationId: record.applicationId,
      sessionId: record.sessionId,
      sequence: this.#nextSequence(record),
      type: "service-response",
      requestId,
      ok,
      value,
    });
  }
  #send(record: MutableWorkerRecord, message: HostWorkerMessage): void {
    if (record.outboundQueueDepth >= this.limits.maximumOutboundQueue) {
      void this.#terminate(record, "outbound-queue-flood", "terminated");
      return;
    }
    const measuredMessage =
      message.type === "initialize" || message.type === "reload"
        ? { ...message, bundleSource: "" }
        : message;
    if (protocolMessageSize(measuredMessage) > this.limits.maximumMessageBytes) {
      void this.#terminate(record, "outbound-message-oversized", "terminated");
      return;
    }
    record.outboundQueueDepth += 1;
    try {
      record.transport.post(message);
      record.outboundMessages += 1;
    } finally {
      record.outboundQueueDepth -= 1;
    }
  }
  async #terminate(
    record: MutableWorkerRecord,
    reason: string,
    status: WorkerLifecycleState,
  ): Promise<void> {
    if (record.startupTimer !== undefined) clearTimeout(record.startupTimer);
    if (record.renderTimer !== undefined) clearTimeout(record.renderTimer);
    for (const timer of record.eventTimers.values()) clearTimeout(timer);
    record.eventTimers.clear();
    record.status = status;
    record.terminationReason = reason;
    record.unsubscribe();
    record.unsubscribeError();
    await record.transport.terminate(reason);
    this.#notify();
  }
  #diagnostic(
    record: MutableWorkerRecord,
    severity: WorkerDiagnosticEntry["severity"],
    event: string,
    message: string,
  ): void {
    record.diagnostics.push(
      Object.freeze({
        timestamp: this.now(),
        severity,
        event: event.slice(0, 80),
        message: sanitizeWorkerLog(message),
      }),
    );
    if (record.diagnostics.length > 100)
      record.diagnostics.splice(0, record.diagnostics.length - 100);
  }
  #require(sessionId: string): MutableWorkerRecord {
    const record = this.#records.get(sessionId);
    if (record === undefined)
      throw new Error(`Worker session "${sessionId}" does not exist.`);
    return record;
  }
  #nextSequence(record: MutableWorkerRecord): number {
    record.sequence += 1;
    return record.sequence;
  }
  #snapshot(record: MutableWorkerRecord): ApplicationWorkerSnapshot {
    const metrics: ApplicationWorkerMetrics = Object.freeze({
      inboundMessages: record.inboundMessages,
      outboundMessages: record.outboundMessages,
      inboundQueueDepth: record.inboundQueueDepth,
      outboundQueueDepth: record.outboundQueueDepth,
      averageEventDuration:
        record.completedEvents === 0
          ? 0
          : record.totalEventDuration / record.completedEvents,
      timeoutCount: record.timeoutCount,
      restartCount: record.restartCount,
      ...(record.memoryBytes === undefined ? {} : { memoryBytes: record.memoryBytes }),
      ...(record.terminationReason === undefined
        ? {}
        : { terminationReason: record.terminationReason }),
    });
    return Object.freeze({
      applicationId: record.applicationId,
      sessionId: record.sessionId,
      status: record.status,
      metrics,
      diagnostics: Object.freeze([...record.diagnostics]),
      ...(record.latestSurface === undefined
        ? {}
        : { latestSurface: record.latestSurface }),
    });
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
  async #persistedState(applicationId: string): Promise<StructuredValue> {
    const value = await this.broker.providers.storage.get(
      applicationId,
      "worker.persisted-state",
    );
    if (value === undefined) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return isProtocolStructured(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
class DeadlineError extends Error {}
async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineError("Worker deadline exceeded."));
    }, milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Worker operation failed."));
      },
    );
  });
}
function isMessageWithinLimit(value: unknown, maximumBytes: number): boolean {
  try {
    if (!isProtocolStructured(value)) return false;
    return protocolMessageSize(value) <= maximumBytes;
  } catch {
    return false;
  }
}
function isProtocolStructured(value: unknown): value is StructuredValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item: unknown) => isProtocolStructured(item));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([, item]) => isProtocolStructured(item));
}
function structuredRecord(
  value: StructuredValue,
): Readonly<Record<string, StructuredValue>> | undefined {
  const candidate: unknown = value;
  if (!isUnknownRecord(candidate)) return undefined;
  if (!Object.values(candidate).every((item) => isProtocolStructured(item)))
    return undefined;
  const output: Record<string, StructuredValue> = {};
  for (const [key, item] of Object.entries(candidate))
    if (isProtocolStructured(item)) output[key] = item;
  return output;
}
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function manifestPayload(applicationPackage: SevynApplicationPackage): StructuredValue {
  const manifest = applicationPackage.manifest;
  return {
    manifestVersion: manifest.manifestVersion,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    developer: manifest.developer,
    icon: manifest.icon,
    entrypoint: manifest.entrypoint,
    minimumSevynOSVersion: manifest.minimumSevynOSVersion,
    permissions: manifest.permissions,
    services: manifest.services,
    windowModes: manifest.windowModes,
    instanceMode: manifest.instanceMode,
  };
}
function sanitizeWorkerLog(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}
