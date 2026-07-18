import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@local-pair-review/shared";
import {
  TaskEventController,
  type TaskEventSocket,
  type TaskEventSocketClose,
  type TaskEventSocketMessage,
} from "../../apps/web/src/realtime/task-events";

class FakeSocket implements TaskEventSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  onopen: (() => void) | null = null;
  onmessage: ((message: TaskEventSocketMessage) => void) | null = null;
  onclose: ((event: TaskEventSocketClose) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  open(): void {
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  closed(event: TaskEventSocketClose): void {
    this.onclose?.(event);
  }
}

class FakeTimers {
  readonly scheduled: Array<{ callback: () => void; delay: number; token: number }> = [];
  readonly cleared: number[] = [];
  private nextToken = 1;

  setTimeout = (callback: () => void, delay: number): number => {
    const token = this.nextToken++;
    this.scheduled.push({ callback, delay, token });
    return token;
  };

  clearTimeout = (token: unknown): void => {
    this.cleared.push(token as number);
  };

  runNext(): void {
    const scheduled = this.scheduled.shift();
    if (!scheduled) throw new Error("No timer scheduled");
    scheduled.callback();
  }
}

function agentEvent(sequence: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    sequence,
    timestamp: "2026-07-18T00:00:00.000Z",
    projectId: "project_1",
    taskId: "task_1",
    runId: "run_1",
    source: "codex",
    type: "message",
    payload: { sequence },
    ...overrides,
  };
}

function eventMessage(event: AgentEvent): { action: "event"; event: AgentEvent } {
  return { action: "event", event };
}

describe("TaskEventController", () => {
  test("subscribes after open and delivers replay and live events once in sequence order", () => {
    const sockets: FakeSocket[] = [];
    const accepted: AgentEvent[] = [];
    const controller = new TaskEventController({
      createWebSocket(url) {
        expect(url).toBe("/ws");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onEvent(event) { accepted.push(event); },
    });

    controller.start("task_1", 0);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      action: "subscribe",
      taskId: "task_1",
      afterSequence: 0,
    });

    sockets[0]!.message(eventMessage(agentEvent(2)));
    expect(accepted).toEqual([]);
    sockets[0]!.message(eventMessage(agentEvent(1)));
    sockets[0]!.message(eventMessage(agentEvent(2)));
    sockets[0]!.message(eventMessage(agentEvent(3)));
    sockets[0]!.message(eventMessage(agentEvent(4, { taskId: "task_2" })));

    expect(accepted.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(controller.lastSequence).toBe(3);
  });

  test("advances the resume cursor only after the consumer accepts an event", () => {
    const socket = new FakeSocket();
    let attempts = 0;
    const errors: unknown[] = [];
    const controller = new TaskEventController({
      createWebSocket: () => socket,
      onEvent() {
        attempts += 1;
        if (attempts === 1) throw new Error("store unavailable");
      },
      onError(error) { errors.push(error); },
    });

    controller.start("task_1", 6);
    socket.open();
    socket.message(eventMessage(agentEvent(7)));
    expect(controller.lastSequence).toBe(6);

    socket.message(eventMessage(agentEvent(8)));
    expect(attempts).toBe(3);
    expect(controller.lastSequence).toBe(8);
    expect(errors).toHaveLength(1);
  });

  test("closes the old socket on task switch and ignores stale socket activity", () => {
    const sockets: FakeSocket[] = [];
    const accepted: AgentEvent[] = [];
    const controller = new TaskEventController({
      createWebSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onEvent(event) { accepted.push(event); },
    });

    controller.start("task_1", 3);
    sockets[0]!.open();
    controller.start("task_2", 10);

    expect(sockets[0]!.closes).toEqual([{ code: 1000, reason: "Task subscription changed" }]);
    sockets[0]!.message(eventMessage(agentEvent(4)));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      action: "subscribe",
      taskId: "task_2",
      afterSequence: 10,
    });
    sockets[1]!.message(eventMessage(agentEvent(11, { taskId: "task_2" })));

    expect(accepted.map((event) => [event.taskId, event.sequence])).toEqual([["task_2", 11]]);
    expect(controller.lastSequence).toBe(11);
  });

  test("reconnects abnormal closures with capped exponential backoff and the accepted cursor", () => {
    const sockets: FakeSocket[] = [];
    const timers = new FakeTimers();
    const controller = new TaskEventController({
      createWebSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      retryBaseMs: 100,
      retryMaxMs: 250,
      onEvent() {},
    });

    controller.start("task_1", 4);
    sockets[0]!.open();
    sockets[0]!.message(eventMessage(agentEvent(5)));
    sockets[0]!.closed({ code: 1013, wasClean: false });
    expect(timers.scheduled.map((timer) => timer.delay)).toEqual([100]);

    timers.runNext();
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ afterSequence: 5 });
    sockets[1]!.closed({ code: 1006, wasClean: false });
    expect(timers.scheduled.map((timer) => timer.delay)).toEqual([200]);

    timers.runNext();
    sockets[2]!.open();
    sockets[2]!.closed({ code: 1011, wasClean: false });
    expect(timers.scheduled.map((timer) => timer.delay)).toEqual([250]);
  });

  test("reconnects clean remote closes and resets backoff after a subscribed acknowledgement", () => {
    const sockets: FakeSocket[] = [];
    const timers = new FakeTimers();
    const connectionStates: boolean[] = [];
    const controller = new TaskEventController({
      createWebSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      retryBaseMs: 100,
      onEvent() {},
      onConnectionChange(connected) { connectionStates.push(connected); },
    });

    controller.start("task_1");
    sockets[0]!.open();
    sockets[0]!.closed({ code: 1000, wasClean: true });
    expect(timers.scheduled.map((timer) => timer.delay)).toEqual([100]);

    timers.runNext();
    sockets[1]!.open();
    sockets[1]!.message({ action: "subscribed", taskId: "task_1", afterSequence: 0 });
    sockets[1]!.closed({ code: 1000, wasClean: true });
    expect(timers.scheduled.map((timer) => timer.delay)).toEqual([100]);
    expect(connectionStates).toEqual([false, true, false]);
  });

  test("stop cancels reconnects, while accepted run terminal events call the terminal hook", () => {
    const socket = new FakeSocket();
    const timers = new FakeTimers();
    const terminal: AgentEvent[] = [];
    let createCalls = 0;
    const controller = new TaskEventController({
      createWebSocket() {
        createCalls += 1;
        return socket;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent() {},
      onTerminalEvent(event) { terminal.push(event); },
    });

    controller.start("task_1");
    socket.open();
    socket.message(eventMessage(agentEvent(1, { type: "turn_completed" })));
    socket.message(eventMessage(agentEvent(2, { type: "run_completed" })));
    expect(terminal.map((event) => event.type)).toEqual(["run_completed"]);

    socket.closed({ code: 1006, wasClean: false });
    expect(timers.scheduled).toHaveLength(1);
    controller.stop();
    expect(timers.cleared).toEqual([timers.scheduled[0]!.token]);
    timers.runNext();
    expect(createCalls).toBe(1);
  });
});
