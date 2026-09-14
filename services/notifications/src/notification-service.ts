export interface NotificationAction {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
}

export interface NotificationEntry {
  readonly id: string;
  readonly applicationId: string;
  readonly applicationName?: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
  readonly read: boolean;
  readonly accent?: string;
  readonly actions?: readonly NotificationAction[];
}

export interface PostNotificationOptions {
  readonly applicationId: string;
  readonly applicationName?: string;
  readonly title: string;
  readonly body: string;
  readonly accent?: string;
  readonly actions?: readonly NotificationAction[];
}

export type NotificationPermissionChecker = (
  applicationId: string,
  capability: string,
) => boolean | Promise<boolean>;

export interface NotificationPersistenceAdapter {
  load(): Promise<readonly NotificationEntry[]>;
  save(notifications: readonly NotificationEntry[]): Promise<void>;
}

export interface NotificationServiceOptions {
  readonly maxCapacity?: number;
  readonly permissionChecker?: NotificationPermissionChecker;
  readonly persistence?: NotificationPersistenceAdapter;
  readonly now?: () => number;
}

export class NotificationPermissionError extends Error {
  constructor(public readonly applicationId: string) {
    super(`Application "${applicationId}" does not have the "notifications" permission.`);
    this.name = "NotificationPermissionError";
  }
}

export class NotificationService {
  readonly #maxCapacity: number;
  readonly #permissionChecker: NotificationPermissionChecker | undefined;
  readonly #persistence: NotificationPersistenceAdapter | undefined;
  readonly #now: () => number;
  readonly #notifications: NotificationEntry[] = [];
  readonly #listeners = new Set<() => void>();
  #nextId = 0;

  constructor(options: NotificationServiceOptions = {}) {
    this.#maxCapacity = options.maxCapacity ?? 100;
    this.#permissionChecker = options.permissionChecker;
    this.#persistence = options.persistence;
    this.#now = options.now ?? (() => Date.now());
  }

  public async init(): Promise<void> {
    if (this.#persistence === undefined) return;
    try {
      const loaded = await this.#persistence.load();
      this.#notifications.length = 0;
      for (const item of loaded) {
        this.#notifications.push(item);
        const match = /^notification-(\d+)$/.exec(item.id);
        if (match?.[1] !== undefined) {
          const num = parseInt(match[1], 10);
          if (!Number.isNaN(num) && num > this.#nextId) {
            this.#nextId = num;
          }
        }
      }
      this.#notify();
    } catch {
      // If loading fails, start with empty notifications.
    }
  }

  public async post(options: PostNotificationOptions): Promise<NotificationEntry> {
    if (this.#permissionChecker !== undefined) {
      const allowed = await this.#permissionChecker(
        options.applicationId,
        "notifications",
      );
      if (!allowed) {
        throw new NotificationPermissionError(options.applicationId);
      }
    }

    this.#nextId += 1;
    const entry: NotificationEntry = Object.freeze({
      id: `notification-${String(this.#nextId)}`,
      applicationId: options.applicationId,
      ...(options.applicationName !== undefined
        ? { applicationName: options.applicationName }
        : {}),
      title: options.title,
      body: options.body,
      createdAt: this.#now(),
      read: false,
      ...(options.accent !== undefined ? { accent: options.accent } : {}),
      ...(options.actions !== undefined ? { actions: options.actions } : {}),
    });

    this.#notifications.unshift(entry);
    if (this.#notifications.length > this.#maxCapacity) {
      this.#notifications.length = this.#maxCapacity;
    }

    await this.#save();
    this.#notify();
    return entry;
  }

  public list(): readonly NotificationEntry[] {
    return Object.freeze([...this.#notifications]);
  }

  public get(id: string): NotificationEntry | undefined {
    return this.#notifications.find((entry) => entry.id === id);
  }

  public async dismiss(id: string): Promise<boolean> {
    const index = this.#notifications.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.#notifications.splice(index, 1);
    await this.#save();
    this.#notify();
    return true;
  }

  public async clearAll(): Promise<void> {
    if (this.#notifications.length === 0) return;
    this.#notifications.length = 0;
    await this.#save();
    this.#notify();
  }

  public async markAsRead(id: string): Promise<boolean> {
    const index = this.#notifications.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const current = this.#notifications[index];
    if (current === undefined || current.read) return true;
    this.#notifications[index] = Object.freeze({
      ...current,
      read: true,
    });
    await this.#save();
    this.#notify();
    return true;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  async #save(): Promise<void> {
    if (this.#persistence === undefined) return;
    try {
      await this.#persistence.save(this.#notifications);
    } catch {
      // Persistence failures should not prevent in-memory notification delivery.
    }
  }
}
