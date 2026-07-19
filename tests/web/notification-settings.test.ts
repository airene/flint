import { describe, expect, test } from "bun:test";
import { BrowserNotificationController, type NotificationPermissionState } from "../../apps/web/src/realtime/browser-notifications";
import { LocalNotificationSettings, type NotificationStorage } from "../../apps/web/src/stores/notification-settings";

class MemoryStorage implements NotificationStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function controller(permission: NotificationPermissionState, requests: number[], settings = new LocalNotificationSettings(new MemoryStorage())) {
  return new BrowserNotificationController({
    settings,
    notification: { permission, async requestPermission() { requests.push(1); return "granted"; }, create: () => ({ onclick: null }) },
    document: { hidden: true }, navigation: { focusTask() {} }, currentTaskId: () => "task_1",
  });
}

describe("LocalNotificationSettings", () => {
  test("persists enablement and independent current-task cursors", () => {
    const storage = new MemoryStorage();
    const first = new LocalNotificationSettings(storage);
    expect(first.isEnabled()).toBe(false);
    first.setEnabled(true);
    expect(first.markSeen("task_1", 3)).toBe(true);
    expect(first.markSeen("task_2", 5)).toBe(true);
    expect(first.markSeen("task_1", 3)).toBe(false);
    const restored = new LocalNotificationSettings(storage);
    expect(restored.isEnabled()).toBe(true);
    expect(restored.cursorFor("task_1")).toBe(3);
    expect(restored.cursorFor("task_2")).toBe(5);
  });

  test("requests permission only for an explicit action while permission is default", async () => {
    const requests: number[] = [];
    expect(await controller("default", requests).requestPermissionFromUserAction()).toBe("granted");
    expect(requests).toHaveLength(1);
    expect(await controller("granted", requests).requestPermissionFromUserAction()).toBe("granted");
    expect(await controller("denied", requests).requestPermissionFromUserAction()).toBe("denied");
    expect(requests).toHaveLength(1);
  });
});
