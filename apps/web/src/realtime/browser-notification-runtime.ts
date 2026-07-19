import { BrowserNotificationController, type BrowserNotificationAdapter } from "./browser-notifications";
import { LocalNotificationSettings } from "../stores/notification-settings";

const notificationAdapter: BrowserNotificationAdapter = {
  get permission() {
    return typeof Notification === "undefined" ? "denied" : Notification.permission;
  },
  async requestPermission() {
    return typeof Notification === "undefined" ? "denied" : Notification.requestPermission();
  },
  create(title, options) {
    return new Notification(title, options);
  },
};

export const browserNotificationSettings = new LocalNotificationSettings();

export const browserNotificationController = new BrowserNotificationController({
  settings: browserNotificationSettings,
  notification: notificationAdapter,
  document: {
    get hidden() { return typeof document !== "undefined" && document.hidden; },
  },
  navigation: {
    focusTask(taskId) {
      if (typeof window === "undefined") return;
      window.focus();
      window.location.assign(`/tasks/${encodeURIComponent(taskId)}`);
    },
  },
  currentTaskId: () => {
    if (typeof window === "undefined") return null;
    const match = /^\/tasks\/([^/]+)$/u.exec(window.location.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  },
});
