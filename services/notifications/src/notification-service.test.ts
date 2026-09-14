import { describe, expect, it, vi } from "vitest";
import {
  type NotificationEntry,
  NotificationPermissionError,
  type NotificationPersistenceAdapter,
  NotificationService,
} from "./notification-service.js";

describe("NotificationService", () => {
  it("posts notifications and assigns unique ids and timestamps", async () => {
    let now = 1000;
    const service = new NotificationService({ now: () => now });

    const notification1 = await service.post({
      applicationId: "org.sevynos.notes",
      title: "Reminder",
      body: "Check notes",
    });

    now = 2000;
    const notification2 = await service.post({
      applicationId: "org.sevynos.calculator",
      title: "Calc result",
      body: "Computed 42",
    });

    expect(notification1.id).toBe("notification-1");
    expect(notification1.createdAt).toBe(1000);
    expect(notification1.read).toBe(false);

    expect(notification2.id).toBe("notification-2");
    expect(notification2.createdAt).toBe(2000);

    const list = service.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe("notification-2");
    expect(list[1]?.id).toBe("notification-1");
  });

  it("enforces permission checks when permissionChecker is provided", async () => {
    const service = new NotificationService({
      permissionChecker: (appId, cap) => {
        if (cap === "notifications") {
          return appId === "org.sevynos.notes";
        }
        return false;
      },
    });

    await expect(
      service.post({
        applicationId: "org.sevynos.untrusted",
        title: "Malicious",
        body: "Spam",
      }),
    ).rejects.toThrow(NotificationPermissionError);

    const allowed = await service.post({
      applicationId: "org.sevynos.notes",
      title: "Legitimate",
      body: "Note saved",
    });

    expect(allowed.id).toBe("notification-1");
  });

  it("dismisses single notifications and notifies listeners", async () => {
    const service = new NotificationService();
    const listener = vi.fn();
    service.subscribe(listener);

    const n1 = await service.post({
      applicationId: "app",
      title: "1",
      body: "1",
    });
    const n2 = await service.post({
      applicationId: "app",
      title: "2",
      body: "2",
    });

    expect(service.list()).toHaveLength(2);

    const dismissed = await service.dismiss(n1.id);
    expect(dismissed).toBe(true);
    expect(service.list()).toHaveLength(1);
    expect(service.get(n1.id)).toBeUndefined();
    expect(service.get(n2.id)).toBeDefined();

    const notFound = await service.dismiss("unknown-id");
    expect(notFound).toBe(false);
  });

  it("clears all notifications", async () => {
    const service = new NotificationService();
    await service.post({ applicationId: "app", title: "1", body: "1" });
    await service.post({ applicationId: "app", title: "2", body: "2" });

    expect(service.list()).toHaveLength(2);
    await service.clearAll();
    expect(service.list()).toHaveLength(0);
  });

  it("marks notifications as read", async () => {
    const service = new NotificationService();
    const n = await service.post({ applicationId: "app", title: "Hi", body: "Msg" });
    expect(service.get(n.id)?.read).toBe(false);

    await service.markAsRead(n.id);
    expect(service.get(n.id)?.read).toBe(true);
  });

  it("caps maximum capacity", async () => {
    const service = new NotificationService({ maxCapacity: 3 });
    await service.post({ applicationId: "app", title: "1", body: "1" });
    await service.post({ applicationId: "app", title: "2", body: "2" });
    await service.post({ applicationId: "app", title: "3", body: "3" });
    await service.post({ applicationId: "app", title: "4", body: "4" });

    const list = service.list();
    expect(list).toHaveLength(3);
    expect(list.map((item) => item.title)).toEqual(["4", "3", "2"]);
  });

  it("loads and saves from persistence adapter", async () => {
    const store: NotificationEntry[] = [];
    const persistence: NotificationPersistenceAdapter = {
      load: vi.fn(async () => [...store]),
      save: vi.fn(async (entries) => {
        store.length = 0;
        store.push(...entries);
      }),
    };

    const service1 = new NotificationService({ persistence });
    await service1.init();
    await service1.post({ applicationId: "app1", title: "Persisted", body: "Body" });

    expect(store).toHaveLength(1);
    expect(store[0]?.title).toBe("Persisted");

    const service2 = new NotificationService({ persistence });
    await service2.init();
    expect(service2.list()).toHaveLength(1);
    expect(service2.list()[0]?.title).toBe("Persisted");

    const newNotification = await service2.post({
      applicationId: "app2",
      title: "Second",
      body: "Another",
    });
    expect(newNotification.id).toBe("notification-2");
  });
});
