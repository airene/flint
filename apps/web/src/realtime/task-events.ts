import {
  webSocketEventMessageSchema,
  webSocketSubscribedMessageSchema,
  type AgentEvent,
  type AgentEventType,
  type WebSocketSubscribe,
} from "@local-pair-review/shared";

export interface TaskEventSocketMessage {
  data: unknown;
}

export interface TaskEventSocketClose {
  code: number;
  wasClean: boolean;
}

export interface TaskEventSocket {
  onopen: (() => void) | null;
  onmessage: ((message: TaskEventSocketMessage) => void) | null;
  onclose: ((event: TaskEventSocketClose) => void) | null;
  onerror: ((error: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface TaskEventControllerOptions {
  url?: string;
  createWebSocket?: (url: string) => TaskEventSocket;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (token: unknown) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onEvent(event: AgentEvent): void;
  onTerminalEvent?(event: AgentEvent): void;
  onConnectionChange?(connected: boolean): void;
  onError?(error: unknown): void;
}

const RUN_TERMINAL_EVENT_TYPES = new Set<AgentEventType>([
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
]);

const defaultCreateWebSocket = (url: string): TaskEventSocket =>
  new WebSocket(url) as unknown as TaskEventSocket;

const defaultClearTimeout = (token: unknown): void => {
  globalThis.clearTimeout(token as ReturnType<typeof globalThis.setTimeout>);
};

export class TaskEventController {
  private readonly url: string;
  private readonly createWebSocket: (url: string) => TaskEventSocket;
  private readonly scheduleTimeout: (callback: () => void, delay: number) => unknown;
  private readonly cancelTimeout: (token: unknown) => void;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly onTerminalEvent?: (event: AgentEvent) => void;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private readonly onError?: (error: unknown) => void;

  private socket: TaskEventSocket | null = null;
  private reconnectTimer: unknown | null = null;
  private taskId: string | null = null;
  private cursor = 0;
  private generation = 0;
  private retryAttempt = 0;
  private connectionState: boolean | null = null;
  private readonly pending = new Map<number, AgentEvent>();

  constructor(options: TaskEventControllerOptions) {
    this.url = options.url ?? "/ws";
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.scheduleTimeout = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout ?? defaultClearTimeout;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.retryMaxMs = options.retryMaxMs ?? 10_000;
    this.onEvent = options.onEvent;
    this.onTerminalEvent = options.onTerminalEvent;
    this.onConnectionChange = options.onConnectionChange;
    this.onError = options.onError;
  }

  get lastSequence(): number {
    return this.cursor;
  }

  start(taskId: string, afterSequence = 0): void {
    this.replaceSubscription();
    this.taskId = taskId;
    this.cursor = afterSequence;
    this.retryAttempt = 0;
    this.pending.clear();
    this.setConnectionState(false);
    this.connect(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.taskId = null;
    this.pending.clear();
    this.clearReconnectTimer();
    this.closeCurrentSocket(1000, "Task event stream stopped");
    this.setConnectionState(false);
  }

  private replaceSubscription(): void {
    this.generation += 1;
    this.clearReconnectTimer();
    this.closeCurrentSocket(1000, "Task subscription changed");
  }

  private connect(generation: number): void {
    if (generation !== this.generation || this.taskId === null) return;

    let socket: TaskEventSocket;
    try {
      socket = this.createWebSocket(this.url);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect(generation);
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation) || this.taskId === null) return;
      const subscription: WebSocketSubscribe = {
        action: "subscribe",
        taskId: this.taskId,
        afterSequence: this.cursor,
      };
      try {
        socket.send(JSON.stringify(subscription));
      } catch (error) {
        this.failConnection(socket, generation, error);
      }
    };
    socket.onmessage = (message) => {
      if (!this.isCurrent(socket, generation)) return;
      this.receive(message.data);
    };
    socket.onerror = (error) => {
      if (this.isCurrent(socket, generation)) this.reportError(error);
    };
    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.setConnectionState(false);
      this.scheduleReconnect(generation);
    };
  }

  private receive(rawMessage: unknown): void {
    if (typeof rawMessage !== "string") {
      this.reportError(new Error("Task event message must be JSON text"));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      this.reportError(error);
      return;
    }

    if (typeof message === "object" && message !== null && "action" in message && message.action === "subscribed") {
      const subscribed = webSocketSubscribedMessageSchema.safeParse(message);
      if (!subscribed.success || subscribed.data.taskId !== this.taskId) {
        this.reportError(new Error("Invalid task subscription acknowledgement"));
        return;
      }
      this.retryAttempt = 0;
      this.setConnectionState(true);
      return;
    }

    const parsed = webSocketEventMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.reportError(new Error("Invalid task event message"));
      return;
    }

    const event = parsed.data.event as AgentEvent;
    if (event.taskId !== this.taskId || event.sequence <= this.cursor || this.pending.has(event.sequence)) return;
    this.pending.set(event.sequence, event);
    this.deliverPending();
  }

  private deliverPending(): void {
    let next = this.pending.get(this.cursor + 1);
    while (next) {
      try {
        this.onEvent(next);
      } catch (error) {
        this.reportError(error);
        return;
      }

      this.pending.delete(next.sequence);
      this.cursor = next.sequence;
      if (RUN_TERMINAL_EVENT_TYPES.has(next.type)) {
        try {
          this.onTerminalEvent?.(next);
        } catch (error) {
          this.reportError(error);
        }
      }
      next = this.pending.get(this.cursor + 1);
    }
  }

  private failConnection(socket: TaskEventSocket, generation: number, error: unknown): void {
    if (!this.isCurrent(socket, generation)) return;
    this.reportError(error);
    this.setConnectionState(false);
    this.socket = null;
    try {
      socket.close(1011, "Task event subscription failed");
    } catch {
      // The retry cursor remains authoritative even if closing the failed socket throws.
    }
    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number): void {
    if (generation !== this.generation || this.taskId === null || this.reconnectTimer !== null) return;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** this.retryAttempt));
    this.retryAttempt += 1;
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = null;
      this.connect(generation);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeCurrentSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // The subscription is already detached; a close failure must not revive it.
    }
  }

  private isCurrent(socket: TaskEventSocket, generation: number): boolean {
    return generation === this.generation && socket === this.socket;
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must not disrupt event ordering or reconnection.
    }
  }

  private setConnectionState(connected: boolean): void {
    if (this.connectionState === connected) return;
    this.connectionState = connected;
    try {
      this.onConnectionChange?.(connected);
    } catch {
      // Connection diagnostics must not disrupt replay or reconnection.
    }
  }
}
