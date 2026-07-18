import type { AgentEvent } from "@local-pair-review/shared";
import type { EventBroadcastPort } from "../services/event.service";

export interface EventSocket {
  getBufferedAmount(): number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface SubscriptionState {
  taskId: string | null;
  replaying: boolean;
  buffered: AgentEvent[];
}

export class EventHub implements EventBroadcastPort {
  private readonly sockets = new Map<EventSocket, SubscriptionState>();

  open(socket: EventSocket): void {
    this.sockets.set(socket, { taskId: null, replaying: false, buffered: [] });
  }

  beginReplay(socket: EventSocket, taskId: string): void {
    this.sockets.set(socket, { taskId, replaying: true, buffered: [] });
  }

  finishReplay(socket: EventSocket, lastReplayedSequence: number): void {
    const state = this.sockets.get(socket);
    if (!state) return;
    const buffered = state.buffered
      .filter((event) => event.sequence > lastReplayedSequence)
      .sort((left, right) => left.sequence - right.sequence);
    state.buffered = [];
    state.replaying = false;
    for (const event of buffered) this.send(socket, event);
  }

  close(socket: EventSocket): void {
    this.sockets.delete(socket);
  }

  closeAll(): void {
    for (const socket of this.sockets.keys()) {
      try { socket.close(1001, "Server shutting down"); } catch { /* continue closing peers */ }
    }
    this.sockets.clear();
  }

  sendReplay(socket: EventSocket, event: AgentEvent): boolean {
    if (!this.sockets.has(socket)) return false;
    return this.send(socket, event);
  }

  broadcast(event: AgentEvent): void {
    for (const [socket, state] of this.sockets) {
      if (state.taskId !== event.taskId) continue;
      if (state.replaying) {
        state.buffered.push(event);
        continue;
      }
      this.send(socket, event);
    }
  }

  private send(socket: EventSocket, event: AgentEvent): boolean {
      if (socket.getBufferedAmount() > 1_000_000) {
        socket.close(1013, "Client is too slow; reconnect to replay events");
        this.sockets.delete(socket);
        return false;
      }
      try {
        socket.send(JSON.stringify({ action: "event", event }));
        return true;
      } catch {
        this.sockets.delete(socket);
        return false;
      }
  }
}
