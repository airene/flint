import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentRole } from "@local-pair-review/shared";
import { BrowserNotificationController, type BrowserNotification, type NotificationPermissionState } from "../../apps/web/src/realtime/browser-notifications";
import { LocalNotificationSettings, type NotificationStorage } from "../../apps/web/src/stores/notification-settings";

class MemoryStorage implements NotificationStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function event(sequence: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return { sequence, timestamp: "2026-07-19T00:00:00.000Z", projectId: "project_1", taskId: "task_1", runId: "run_1", source: "codex", type: "run_completed", payload: { finalMessage: "Finished work" }, ...overrides };
}

function setup(options: { hidden?: boolean; permission?: NotificationPermissionState; enabled?: boolean; taskId?: string | null; copy?: unknown } = {}) {
  const storage = new MemoryStorage();
  const settings = new LocalNotificationSettings(storage);
  settings.setEnabled(options.enabled ?? true);
  const notices: Array<{ title: string; notification: BrowserNotification }> = [];
  const focused: string[] = [];
  const notification = {
    permission: options.permission ?? "granted",
    requestPermission: async () => "granted" as const,
    create(title: string) { const result: BrowserNotification = { onclick: null }; notices.push({ title, notification: result }); return result; },
  };
  const controller = new BrowserNotificationController({ settings, notification, document: { hidden: options.hidden ?? true }, navigation: { focusTask(taskId) { focused.push(taskId); } }, currentTaskId: () => options.taskId === undefined ? "task_1" : options.taskId, copy: options.copy } as ConstructorParameters<typeof BrowserNotificationController>[0]);
  return { controller, settings, notices, focused };
}

describe("BrowserNotificationController", () => {
  test("notifies once for a hidden current-task developer or reviewer completion and focuses on click", () => {
    const { controller, notices, focused } = setup();
    expect(controller.consumePersistedEvent({ event: event(4), role: "developer", taskTitle: "Add alerts" })).toBe(true);
    expect(controller.consumePersistedEvent({ event: event(4), role: "developer" })).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain("Developer run completed");
    notices[0]!.notification.onclick?.(new Event("click"));
    expect(focused).toEqual(["task_1"]);
  });

  test("rejects non-completion and non-current task events while retaining a cursor only for the current task", () => {
    const { controller, settings, notices } = setup();
    for (const type of ["run_failed", "run_cancelled", "run_interrupted", "approval_requested", "turn_completed", "tool", "command", "message"] as AgentEvent["type"][]) {
      expect(controller.consumePersistedEvent({ event: event(type === "run_failed" ? 1 : type.length + 2, { type }), role: "developer" })).toBe(false);
    }
    expect(controller.consumePersistedEvent({ event: event(40, { taskId: "task_2" }), role: "reviewer" })).toBe(false);
    expect(settings.cursorFor("task_1")).toBeGreaterThan(0);
    expect(settings.cursorFor("task_2")).toBe(0);
    expect(notices).toHaveLength(0);
  });

  test("does not notify when visible, disabled, or permission is not granted", () => {
    for (const input of [{ hidden: false }, { enabled: false }, { permission: "default" as const }, { permission: "denied" as const }]) {
      const { controller, notices } = setup(input);
      expect(controller.consumePersistedEvent({ event: event(2), role: "reviewer" })).toBe(false);
      expect(notices).toHaveLength(0);
    }
  });

  test("marks completions from before the page-open boundary seen without notifying", () => {
    const { controller, settings, notices } = setup();
    const pageOpenedAt = Date.parse("2026-07-19T00:00:01.000Z");

    expect(controller.consumePersistedEvent({
      event: event(1, { timestamp: "2026-07-19T00:00:00.000Z" }),
      role: "developer",
      pageOpenedAt,
    })).toBe(false);
    expect(settings.cursorFor("task_1")).toBe(1);
    expect(notices).toHaveLength(0);

    expect(controller.consumePersistedEvent({
      event: event(2, { timestamp: "2026-07-19T00:00:02.000Z" }),
      role: "developer",
      pageOpenedAt,
    })).toBe(true);
    expect(notices).toHaveLength(1);
  });

  test("persists task-scoped dedupe cursors across controller instances", () => {
    const storage = new MemoryStorage();
    const settings = new LocalNotificationSettings(storage);
    settings.setEnabled(true);
    const makeController = () => new BrowserNotificationController({ settings: new LocalNotificationSettings(storage), notification: { permission: "granted", requestPermission: async () => "granted" as const, create: () => ({ onclick: null }) }, document: { hidden: true }, navigation: { focusTask() {} }, currentTaskId: () => "task_1" });
    expect(makeController().consumePersistedEvent({ event: event(8), role: "reviewer" })).toBe(true);
    expect(makeController().consumePersistedEvent({ event: event(8), role: "reviewer" })).toBe(false);
  });

  test("does not treat an unknown role as a completion eligible for notification", () => {
    const { controller } = setup();
    expect(controller.consumePersistedEvent({ event: event(3), role: "system" as AgentRole })).toBe(false);
  });

  test("uses injected localized notification copy", () => {
    const { controller, notices } = setup({
      copy: {
        completedBody: () => "Run 已成功完成。",
        completedTitle: (role: string, taskTitle?: string) => `${role} Run 已完成${taskTitle ? ` — ${taskTitle}` : ""}`,
      },
    });
    expect(controller.consumePersistedEvent({ event: event(9, { payload: {} }), role: "reviewer", taskTitle: "修复登录" })).toBe(true);
    expect(notices[0]?.title).toBe("Reviewer Run 已完成 — 修复登录");
  });
});
