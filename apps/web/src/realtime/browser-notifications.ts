import type { AgentEvent, AgentRole } from "@local-pair-review/shared";
import type { NotificationSettings } from "../stores/notification-settings";

export type NotificationPermissionState = "default" | "denied" | "granted";

export interface BrowserNotification {
  onclick: ((event: Event) => void) | null;
}

export interface BrowserNotificationAdapter {
  permission: NotificationPermissionState;
  requestPermission(): Promise<NotificationPermissionState>;
  create(title: string, options?: { body?: string; tag?: string }): BrowserNotification;
}

export interface BrowserDocumentAdapter {
  hidden: boolean;
}

export interface BrowserNotificationNavigation {
  focusTask(taskId: string): void;
}

export interface BrowserNotificationCopy {
  completedBody(): string;
  completedTitle(role: "Developer" | "Reviewer", taskTitle?: string): string;
}

export interface PersistedRunEvent {
  event: AgentEvent;
  role: AgentRole;
  taskTitle?: string;
  /** Events persisted at or before this page-open boundary are history, not new completions. */
  pageOpenedAt?: number;
}

export interface BrowserNotificationControllerOptions {
  settings: NotificationSettings;
  notification: BrowserNotificationAdapter;
  document: BrowserDocumentAdapter;
  navigation: BrowserNotificationNavigation;
  currentTaskId: () => string | null;
  copy?: BrowserNotificationCopy;
}

function completionBody(event: AgentEvent, copy?: BrowserNotificationCopy): string {
  const payload = event.payload;
  if (payload && typeof payload === "object" && "finalMessage" in payload) {
    const finalMessage = payload.finalMessage;
    if (typeof finalMessage === "string" && finalMessage.trim()) return finalMessage.trim();
  }
  return copy?.completedBody() ?? "Your run completed successfully.";
}

/**
 * Consumes only persisted task-stream events. It intentionally has no websocket
 * dependency so the Task view can supply its already ordered event stream later.
 */
export class BrowserNotificationController {
  constructor(private readonly options: BrowserNotificationControllerOptions) {}

  get permission(): NotificationPermissionState {
    return this.options.notification.permission;
  }

  async requestPermissionFromUserAction(): Promise<NotificationPermissionState> {
    if (this.permission !== "default") return this.permission;
    return this.options.notification.requestPermission();
  }

  consumePersistedEvent(input: PersistedRunEvent): boolean {
    const { event, role } = input;
    const currentTaskId = this.options.currentTaskId();
    if (!currentTaskId || event.taskId !== currentTaskId || event.sequence <= 0) return false;

    // Advance this task's local cursor even when the event cannot notify. A replay
    // after the page becomes hidden or the preference changes must not alert late.
    if (!this.options.settings.markSeen(event.taskId, event.sequence)) return false;
    if (event.type !== "run_completed" || (role !== "developer" && role !== "reviewer")) return false;
    if (input.pageOpenedAt !== undefined) {
      const completedAt = Date.parse(event.timestamp);
      if (!Number.isFinite(completedAt) || completedAt <= input.pageOpenedAt) return false;
    }
    if (!this.options.settings.isEnabled() || !this.options.document.hidden) return false;
    if (this.options.notification.permission !== "granted") return false;

    const roleLabel = role === "developer" ? "Developer" : "Reviewer";
    const title = this.options.copy?.completedTitle(roleLabel, input.taskTitle)
      ?? (input.taskTitle ? `${roleLabel} run completed — ${input.taskTitle}` : `${roleLabel} run completed`);
    const notification = this.options.notification.create(title, {
      body: completionBody(event, this.options.copy),
      tag: `flint-task-${event.taskId}-event-${event.sequence}`,
    });
    notification.onclick = () => this.options.navigation.focusTask(event.taskId);
    return true;
  }
}
