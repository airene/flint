import type { AgentEvent, UnfinishedTaskSummary } from "@local-pair-review/shared";
import type { EventBroadcastPort } from "../services/event.service";

export interface EventSocket {
  getBufferedAmount(): number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface SubscriptionState {
  taskId: string | null;
  unfinished: boolean;
  replaying: boolean;
  buffered: AgentEvent[];
}

export type UnfinishedTaskBroadcast =
  | { type: "unfinished_task_upsert"; task: UnfinishedTaskSummary }
  | { type: "unfinished_task_remove"; taskId: string };

export class EventHub implements EventBroadcastPort {
  private readonly sockets = new Map<EventSocket, SubscriptionState>();

  open(socket: EventSocket): void {
    this.sockets.set(socket, { taskId: null, unfinished: false, replaying: false, buffered: [] });
  }

  beginReplay(socket: EventSocket, taskId: string): void {
    this.sockets.set(socket, { taskId, unfinished: false, replaying: true, buffered: [] });
  }

  beginUnfinished(socket: EventSocket): void {
    this.sockets.set(socket, { taskId: null, unfinished: true, replaying: false, buffered: [] });
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

  broadcastUnfinished(event: UnfinishedTaskBroadcast): void {
    const data = JSON.stringify(event);
    for (const [socket, state] of this.sockets) {
      if (!state.unfinished) continue;
      this.sendData(socket, data);
    }
  }

  private send(socket: EventSocket, event: AgentEvent): boolean {
    return this.sendData(socket, JSON.stringify({ action: "event", event }));
  }

  private sendData(socket: EventSocket, data: string): boolean {
    if (socket.getBufferedAmount() > 1_000_000) {
      socket.close(1013, "Client is too slow; reconnect to replay events");
      this.sockets.delete(socket);
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch {
      this.sockets.delete(socket);
      return false;
    }
  }
}
