export interface NotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NotificationSettings {
  enabled: boolean;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  cursorFor(taskId: string): number;
  markSeen(taskId: string, sequence: number): boolean;
}

const ENABLED_KEY = "flint.browser-notifications.enabled";
const CURSORS_KEY = "flint.browser-notifications.cursors";

function readEnabled(storage: NotificationStorage): boolean {
  try {
    return storage.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function readCursors(storage: NotificationStorage): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CURSORS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => (
      Number.isInteger(entry[1]) && entry[1] >= 0
    )));
  } catch {
    return {};
  }
}

/** Local-only notification preference and persisted-event cursors, safe when storage is unavailable. */
export class LocalNotificationSettings implements NotificationSettings {
  enabled: boolean;
  private readonly cursors: Record<string, number>;

  constructor(private readonly storage: NotificationStorage = globalThis.localStorage) {
    this.enabled = readEnabled(storage);
    this.cursors = readCursors(storage);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    try {
      this.storage.setItem(ENABLED_KEY, String(enabled));
    } catch {
      // Local persistence is optional (for example, private browsing may disable it).
    }
  }

  cursorFor(taskId: string): number {
    return this.cursors[taskId] ?? 0;
  }

  markSeen(taskId: string, sequence: number): boolean {
    if (!taskId || !Number.isInteger(sequence) || sequence <= this.cursorFor(taskId)) return false;
    this.cursors[taskId] = sequence;
    try {
      this.storage.setItem(CURSORS_KEY, JSON.stringify(this.cursors));
    } catch {
      // Retain the in-memory cursor even if storage is unavailable.
    }
    return true;
  }
}
