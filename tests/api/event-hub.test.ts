import { describe, expect, test } from "bun:test";
import type { AgentEvent, UnfinishedTaskSummary } from "@local-pair-review/shared";
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
  readonly sent: Array<{ action?: string; event?: AgentEvent; type?: string; task?: UnfinishedTaskSummary; taskId?: string }> = [];
  getBufferedAmount(): number { return 0; }
  send(data: string): number {
    const message = JSON.parse(data);
    this.sent.push(message);
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

    expect(socket.sent.map((item) => item.event?.sequence)).toEqual([3, 4, 5]);
  });

  test("broadcasts summary-only unfinished upserts and removals only to app subscribers", () => {
    const hub = new EventHub();
    const taskSocket = new Socket();
    const appSocket = new Socket();
    hub.open(taskSocket);
    hub.open(appSocket);
    hub.beginReplay(taskSocket, "task-1");
    hub.finishReplay(taskSocket, 0);
    hub.beginUnfinished(appSocket);
    const summary: UnfinishedTaskSummary = {
      id: "task-1",
      projectId: "project-1",
      projectName: "Flint",
      title: "Integrate attention",
      status: "developing",
      latestRunStatus: "running",
      pendingApprovalCount: 0,
      attention: "running",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };

    hub.broadcastUnfinished({ type: "unfinished_task_upsert", task: summary });
    hub.broadcastUnfinished({ type: "unfinished_task_remove", taskId: summary.id });
    hub.broadcast(event(1));

    expect(taskSocket.sent).toEqual([{ action: "event", event: event(1) }]);
    expect(appSocket.sent).toEqual([
      { type: "unfinished_task_upsert", task: summary },
      { type: "unfinished_task_remove", taskId: "task-1" },
    ]);
    expect(JSON.stringify(appSocket.sent)).not.toContain("originalPrompt");
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
