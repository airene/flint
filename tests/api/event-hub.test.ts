import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@local-pair-review/shared";
import { EventHub, type EventSocket } from "../../apps/server/src/api/event-hub";
import { isAllowedLocalRequest } from "../../apps/server/src/api/security";

function event(sequence: number): AgentEvent {
  return {
    sequence,
    timestamp: "2026-07-18T00:00:00.000Z",
    projectId: "project-1",
    taskId: "task-1",
    runId: "run-1",
    source: "system",
    type: "message",
    payload: { sequence },
  };
}

class Socket implements EventSocket {
  readonly sent: AgentEvent[] = [];
  getBufferedAmount(): number { return 0; }
  send(data: string): number {
    const message = JSON.parse(data);
    this.sent.push(message.event);
    return data.length;
  }
  close(): void {}
}

describe("EventHub replay handoff", () => {
  test("buffers live events during replay, removes overlap, and flushes in sequence order", () => {
    const hub = new EventHub();
    const socket = new Socket();
    hub.open(socket);
    hub.beginReplay(socket, "task-1");
    hub.broadcast(event(4));
    hub.broadcast(event(2));
    hub.broadcast(event(3));

    hub.finishReplay(socket, 2);
    hub.broadcast(event(5));

    expect(socket.sent.map((item) => item.sequence)).toEqual([3, 4, 5]);
  });

  test("allows loopback UI origins and rejects remote HTTP or WebSocket origins", () => {
    expect(isAllowedLocalRequest(new Request("http://127.0.0.1:3000/ws", {
      headers: { origin: "http://localhost:5173" },
    }))).toBe(true);
    expect(isAllowedLocalRequest(new Request("http://127.0.0.1:3000/ws", {
      headers: { origin: "https://attacker.example" },
    }))).toBe(false);
    expect(isAllowedLocalRequest(new Request("http://attacker.example/api/projects"))).toBe(false);
  });
});
