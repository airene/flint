import { describe, expect, test } from "bun:test";
import type {
  AgentRole,
  AgentRun,
  AgentRunStatus,
  CreateTaskMessageRequest,
  Task,
  TaskMessage,
} from "@local-pair-review/shared";
import {
  ConversationService,
  type ConversationAgentRunPort,
  type ConversationPersistencePort,
  type MessageTransitionPatch,
  type QueueTaskMessageInput,
} from "../../apps/server/src/services/conversation.service";
import type { StartAgentRunInput, StartedAgentRun } from "../../apps/server/src/services/agent-run.service";

const now = "2026-07-19T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    originalPrompt: "Build it",
    workingDirectory: "/tmp/project",
    baseCommit: "base",
    latestSnapshotHash: "snapshot-1",
    status: "waiting_for_human",
    developerProvider: "codex",
    reviewerProvider: "claude",
    developerSessionId: "developer-session-exact",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function run(
  id: string,
  runType: AgentRun["runType"],
  status: AgentRunStatus,
  externalSessionId: string | null,
): AgentRun {
  return {
    id,
    taskId: "task-1",
    projectId: "project-1",
    provider: runType === "reviewer" || runType === "reviewer_followup" ? "claude" : "codex",
    runType,
    status,
    reviewParseStatus: runType === "reviewer" ? "pending" : null,
    externalSessionId,
    processId: status === "running" ? 123 : null,
    exitCode: null,
    prompt: "prompt",
    finalMessage: null,
    structuredOutput: null,
    errorMessage: null,
    startedAt: status === "running" ? now : null,
    finishedAt: null,
  };
}

class MemoryConversationPersistence implements ConversationPersistencePort {
  readonly task: Task;
  readonly runs = new Map<string, AgentRun>();
  readonly messages = new Map<string, TaskMessage>();
  readonly order: string[] = [];
  readonly discardedFormalRuns: string[] = [];

  constructor(taskValue = task(), runs: AgentRun[] = []) {
    this.task = taskValue;
    for (const item of runs) this.runs.set(item.id, item);
  }

  async createMessage(message: TaskMessage, _attachmentIds?: string[]): Promise<TaskMessage> {
    this.messages.set(message.id, message);
    this.order.push(`message:create:${message.id}`);
    return message;
  }

  async transitionMessage(
    messageId: string,
    from: TaskMessage["status"],
    patch: MessageTransitionPatch,
  ): Promise<TaskMessage | null> {
    const current = this.messages.get(messageId);
    if (!current || current.status !== from) return null;
    const updated = { ...current, ...patch };
    this.messages.set(messageId, updated);
    this.order.push(`message:${updated.status}:${messageId}`);
    return updated;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return taskId === this.task.id ? this.task : null;
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(taskId: string): Promise<AgentRun[]> {
    return [...this.runs.values()].filter((item) => item.taskId === taskId);
  }

  async listMessages(taskId: string): Promise<TaskMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async attachmentPaths(_messageIds: readonly string[]): Promise<string[]> {
    return [];
  }

  async discardIncompleteFormalFindings(runId: string): Promise<void> {
    this.discardedFormalRuns.push(runId);
    this.order.push(`findings:discard:${runId}`);
  }
}

class ScenarioAgentRuns implements ConversationAgentRunPort {
  readonly starts: StartAgentRunInput[] = [];
  readonly order: string[];
  private nextRun = 0;
  private readonly terminal = deferred<AgentRun>();
  private readonly activeTerminal = deferred<AgentRun>();

  constructor(
    private readonly persistence: MemoryConversationPersistence,
    private readonly autoComplete = true,
    private readonly deferActiveWait = false,
  ) {
    this.order = persistence.order;
  }

  async start(input: StartAgentRunInput): Promise<StartedAgentRun> {
    this.starts.push(input);
    this.order.push(`run:start:${input.runType}`);
    const started = run(`followup-${++this.nextRun}`, input.runType, "queued", input.sessionId ?? null);
    this.persistence.runs.set(started.id, started);
    const completion = this.autoComplete
      ? Promise.resolve({ ...started, status: "completed" as const, finalMessage: "Delivered", finishedAt: now })
      : this.terminal.promise;
    return { run: started, completion };
  }

  async interrupt(runId: string): Promise<AgentRun | null> {
    this.order.push(`run:interrupt:${runId}`);
    const active = this.persistence.runs.get(runId);
    if (!active) return null;
    const terminal = { ...active, status: "interrupted" as const, processId: null, finishedAt: now };
    this.persistence.runs.set(runId, terminal);
    if (this.deferActiveWait) this.activeTerminal.resolve(terminal);
    return terminal;
  }

  async waitForTerminal(runId: string): Promise<AgentRun | null> {
    this.order.push(`run:wait:${runId}`);
    const active = this.persistence.runs.get(runId);
    if (!active) return null;
    if (this.deferActiveWait) return await this.activeTerminal.promise;
    const terminal = { ...active, status: "completed" as const, processId: null, finishedAt: now };
    this.persistence.runs.set(runId, terminal);
    return terminal;
  }

  completeDelivery(status: AgentRunStatus = "completed"): void {
    const active = [...this.persistence.runs.values()].find((item) => item.id.startsWith("followup-"))!;
    this.terminal.resolve({
      ...active,
      status,
      errorMessage: status === "completed" ? null : "delivery failed",
      finishedAt: now,
    });
  }

  completeActiveRun(runId: string): void {
    const active = this.persistence.runs.get(runId)!;
    const terminal = { ...active, status: "completed" as const, processId: null, finishedAt: now };
    this.persistence.runs.set(runId, terminal);
    this.activeTerminal.resolve(terminal);
  }
}

function input(
  targetRole: AgentRole,
  overrides: Partial<CreateTaskMessageRequest & QueueTaskMessageInput> = {},
): QueueTaskMessageInput {
  return {
    projectId: "project-1",
    taskId: "task-1",
    targetRole,
    sourceReviewRunId: targetRole === "reviewer" ? "formal-review-exact" : null,
    text: `message for ${targetRole}`,
    deliveryMode: "queue",
    attachmentIds: [],
    ...overrides,
  };
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}

describe("ConversationService scheduling", () => {
  const schedulingCases = [
    { active: null, target: "developer", mode: "queue", policy: "dispatch" },
    { active: null, target: "reviewer", mode: "queue", policy: "dispatch" },
    { active: "developer", target: "developer", mode: "queue", policy: "wait" },
    { active: "developer", target: "developer", mode: "interrupt", policy: "interrupt" },
    { active: "developer", target: "reviewer", mode: "queue", policy: "wait" },
    { active: "developer", target: "reviewer", mode: "interrupt", policy: "wait" },
    { active: "reviewer", target: "reviewer", mode: "queue", policy: "wait" },
    { active: "reviewer", target: "reviewer", mode: "interrupt", policy: "interrupt" },
    { active: "reviewer", target: "developer", mode: "queue", policy: "interrupt" },
    { active: "reviewer", target: "developer", mode: "interrupt", policy: "interrupt" },
  ] as const;

  for (const scenario of schedulingCases) {
    test(`${scenario.active ?? "idle"} -> ${scenario.target} (${scenario.mode}) uses ${scenario.policy}`, async () => {
      const formalReview = run("formal-review-exact", "reviewer", "completed", "review-session-exact");
      const active = scenario.active
        ? run("active-run", scenario.active === "developer" ? "developer_followup" : "reviewer", "running", "active-session")
        : null;
      const persistence = new MemoryConversationPersistence(task(), [formalReview, ...(active ? [active] : [])]);
      const agentRuns = new ScenarioAgentRuns(persistence);
      const service = new ConversationService({
        persistence,
        agentRuns,
        createId: () => "message-1",
        now: () => now,
      });

      const accepted = await service.enqueue(input(scenario.target, { deliveryMode: scenario.mode }));
      await service.drain("task-1");

      expect(accepted.status).toBe("queued");
      if (scenario.policy === "wait") expect(persistence.order).toContain("run:wait:active-run");
      if (scenario.policy === "interrupt") expect(persistence.order).toContain("run:interrupt:active-run");
      if (scenario.active === "reviewer" && scenario.target === "developer") {
        expect(persistence.discardedFormalRuns).toEqual(["active-run"]);
      } else {
        expect(persistence.discardedFormalRuns).toEqual([]);
      }
      expect(agentRuns.starts).toHaveLength(1);
      expect(persistence.messages.get("message-1")?.status).toBe("delivered");
      const firstRunAction = persistence.order.findIndex((entry) => entry.startsWith("run:"));
      expect(persistence.order.indexOf("message:create:message-1"))
        .toBeLessThan(firstRunAction);
    });
  }

  test("uses only the selected formal review session even when a newer Review exists", async () => {
    const persistence = new MemoryConversationPersistence(task(), [
      run("formal-review-exact", "reviewer", "completed", "review-session-exact"),
      run("newer-review", "reviewer", "completed", "review-session-newer"),
    ]);
    const agentRuns = new ScenarioAgentRuns(persistence);
    const service = new ConversationService({ persistence, agentRuns, createId: () => "message-1", now: () => now });

    await service.enqueue(input("reviewer"));
    await service.drain("task-1");

    expect(agentRuns.starts[0]).toMatchObject({
      runType: "reviewer_followup",
      sessionId: "review-session-exact",
    });
  });

  test("fails instead of falling back when the exact Developer or Review session is missing", async () => {
    const cases = [
      { role: "developer", task: task({ developerSessionId: null }), runs: [] },
      {
        role: "reviewer",
        task: task(),
        runs: [run("newer-review", "reviewer", "completed", "review-session-newer")],
      },
    ] as const;

    for (const [index, scenario] of cases.entries()) {
      const persistence = new MemoryConversationPersistence(scenario.task, [...scenario.runs]);
      const agentRuns = new ScenarioAgentRuns(persistence);
      const messageId = `message-${index}`;
      const service = new ConversationService({ persistence, agentRuns, createId: () => messageId, now: () => now });

      await service.enqueue(input(scenario.role));
      await service.drain("task-1");

      expect(agentRuns.starts, scenario.role).toHaveLength(0);
      expect(persistence.messages.get(messageId), scenario.role).toMatchObject({
        status: "failed",
        deliveredAt: null,
      });
      expect(persistence.messages.get(messageId)?.errorMessage).toContain("exact");
    }
  });

  test("does not mark HTTP-accepted work delivered until the resumed turn completes", async () => {
    const persistence = new MemoryConversationPersistence(task());
    const agentRuns = new ScenarioAgentRuns(persistence, false);
    const service = new ConversationService({ persistence, agentRuns, createId: () => "message-1", now: () => now });

    const accepted = await service.enqueue(input("developer"));
    await nextTurn();

    expect(accepted.status).toBe("queued");
    expect(persistence.messages.get("message-1")?.status).toBe("delivering");
    agentRuns.completeDelivery();
    await service.drain("task-1");
    expect(persistence.messages.get("message-1")).toMatchObject({ status: "delivered", deliveredAt: now });
  });

  test("a later explicit same-role interrupt preempts the active turn and keeps queued messages FIFO", async () => {
    const active = run("active-run", "developer_followup", "running", "developer-session-exact");
    const persistence = new MemoryConversationPersistence(task(), [active]);
    const agentRuns = new ScenarioAgentRuns(persistence, true, true);
    let id = 0;
    const service = new ConversationService({
      persistence,
      agentRuns,
      createId: () => `message-${++id}`,
      now: () => now,
    });

    await service.enqueue(input("developer", { text: "first", deliveryMode: "queue" }));
    await nextTurn();
    await service.enqueue(input("developer", { text: "second", deliveryMode: "interrupt" }));
    const interruptedBeforeNaturalCompletion = await waitUntil(
      () => persistence.order.includes("run:interrupt:active-run"),
    );
    if (!interruptedBeforeNaturalCompletion) agentRuns.completeActiveRun("active-run");
    await service.drain("task-1");

    expect(interruptedBeforeNaturalCompletion).toBe(true);
    expect(agentRuns.starts[0]?.prompt).toBe("first\n\n---\n\nsecond");
    expect(persistence.order.indexOf("run:interrupt:active-run"))
      .toBeLessThan(persistence.order.indexOf("run:start:developer_followup"));
  });

  test("marks every combined message failed when the resumed turn fails", async () => {
    const persistence = new MemoryConversationPersistence(task());
    const agentRuns = new ScenarioAgentRuns(persistence, false);
    const service = new ConversationService({ persistence, agentRuns, now: () => now });
    for (const [id, text] of [["message-1", "first"], ["message-2", "second"]] as const) {
      await persistence.createMessage({
        id,
        projectId: "project-1",
        taskId: "task-1",
        targetRole: "developer",
        sourceReviewRunId: null,
        text,
        deliveryMode: "queue",
        status: "queued",
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
        errorMessage: null,
      });
    }
    service.resume("task-1");
    await nextTurn();
    agentRuns.completeDelivery("failed");
    await service.drain("task-1");

    expect([...persistence.messages.values()].map((message) => message.status)).toEqual(["failed", "failed"]);
    expect(agentRuns.starts[0]?.prompt).toBe("first\n\n---\n\nsecond");
  });
});
