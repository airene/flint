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
  type ConversationDeliveryBatch,
  type ConversationPersistencePort,
  type QueueTaskMessageInput,
  type ReserveDeliveryBatchInput,
  type SettleDeliveryBatchInput,
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
  readonly messageSequence = new Map<string, number>();
  readonly batches = new Map<string, ConversationDeliveryBatch>();
  readonly order: string[] = [];
  readonly batchStatusSnapshots: string[][] = [];
  readonly discardedFormalRuns: string[] = [];
  discardFailures = 0;
  settleFailures = 0;
  private nextMessageSequence = 0;

  constructor(taskValue = task(), runs: AgentRun[] = []) {
    this.task = taskValue;
    for (const item of runs) this.runs.set(item.id, item);
  }

  async createMessage(message: TaskMessage, _attachmentIds?: string[]): Promise<TaskMessage> {
    this.messages.set(message.id, message);
    this.messageSequence.set(message.id, ++this.nextMessageSequence);
    this.order.push(`message:create:${message.id}`);
    return message;
  }

  async reserveDeliveryBatch(input: ReserveDeliveryBatchInput): Promise<ConversationDeliveryBatch | null> {
    const messages = input.messageIds.map((id) => this.messages.get(id));
    if (messages.some((message) => message?.status !== "queued")) return null;
    const batch: ConversationDeliveryBatch = { ...input, runId: null };
    for (const message of messages as TaskMessage[]) {
      this.messages.set(message.id, {
        ...message,
        status: "delivering",
        updatedAt: input.updatedAt,
        deliveredAt: null,
        errorMessage: null,
      });
    }
    this.batches.set(batch.id, batch);
    this.order.push(`batch:reserve:${batch.id}:${batch.messageIds.join(",")}`);
    this.batchStatusSnapshots.push(batch.messageIds.map((id) => this.messages.get(id)!.status));
    return batch;
  }

  async settleDeliveryBatch(input: SettleDeliveryBatchInput): Promise<TaskMessage[]> {
    if (this.settleFailures > 0) {
      this.settleFailures -= 1;
      this.order.push(`batch:settle-failed:${input.batchId}`);
      const failedBatch = this.batches.get(input.batchId)!;
      this.batchStatusSnapshots.push(failedBatch.messageIds.map((id) => this.messages.get(id)!.status));
      throw new Error("batch settlement failed");
    }
    const batch = this.batches.get(input.batchId);
    if (!batch) throw new Error("missing delivery batch");
    const current = batch.messageIds.map((id) => this.messages.get(id));
    if (current.some((message) => message?.status !== "delivering")) {
      throw new Error("delivery batch is not atomically delivering");
    }
    const settled = (current as TaskMessage[]).map((message) => ({
      ...message,
      status: input.status,
      updatedAt: input.updatedAt,
      deliveredAt: input.deliveredAt,
      errorMessage: input.errorMessage,
    }));
    for (const message of settled) this.messages.set(message.id, message);
    this.batches.delete(input.batchId);
    this.order.push(`batch:settle:${input.status}:${input.batchId}`);
    this.batchStatusSnapshots.push(settled.map((message) => message.status));
    return settled;
  }

  async listOpenDeliveryBatches(taskId: string): Promise<ConversationDeliveryBatch[]> {
    return [...this.batches.values()].filter((batch) => batch.taskId === taskId);
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

  async listMessagesInFifoOrder(taskId: string): Promise<TaskMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.taskId === taskId)
      .sort((left, right) => this.messageSequence.get(left.id)! - this.messageSequence.get(right.id)!);
  }

  async attachmentPaths(_messageIds: readonly string[]): Promise<string[]> {
    return [];
  }

  async discardIncompleteFormalFindings(runId: string): Promise<void> {
    if (this.discardFailures > 0) {
      this.discardFailures -= 1;
      this.order.push(`findings:discard-failed:${runId}`);
      throw new Error("discard failed");
    }
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
    if (input.deliveryBatchId) {
      const batch = this.persistence.batches.get(input.deliveryBatchId)!;
      this.persistence.batches.set(batch.id, { ...batch, runId: started.id, updatedAt: now });
      this.order.push(`batch:bind:${batch.id}:${started.id}`);
    }
    const completion = this.autoComplete
      ? Promise.resolve({ ...started, status: "completed" as const, finalMessage: "Delivered", finishedAt: now })
      : this.terminal.promise;
    void completion.then((terminal) => this.persistence.runs.set(started.id, terminal));
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

async function persistQueuedMessage(
  persistence: MemoryConversationPersistence,
  values: Pick<TaskMessage, "id" | "targetRole" | "sourceReviewRunId" | "text" | "deliveryMode">,
): Promise<void> {
  await persistence.createMessage({
    ...values,
    projectId: "project-1",
    taskId: "task-1",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
    errorMessage: null,
  });
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
      {
        role: "reviewer",
        task: task({ reviewerProvider: "claude" }),
        runs: [{
          ...run("formal-review-exact", "reviewer", "completed", "review-session-exact"),
          provider: "codex",
        }],
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
    await waitUntil(() => persistence.messages.get("message-1")?.status === "delivering");

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

  test("delivers the forced candidate next instead of reselecting an older cross-role message", async () => {
    const cases = [
      {
        name: "Developer preempts active Reviewer",
        active: run("active-run", "reviewer", "running", "active-review-session"),
        queued: [
          { id: "message-1", targetRole: "reviewer", sourceReviewRunId: "formal-review-exact", text: "older reviewer", deliveryMode: "queue" },
          { id: "message-2", targetRole: "developer", sourceReviewRunId: null, text: "forced developer", deliveryMode: "queue" },
        ],
        expectedFirst: "developer_followup",
      },
      {
        name: "explicit Developer interrupt follows older Reviewer message",
        active: run("active-run", "developer_followup", "running", "developer-session-exact"),
        queued: [
          { id: "message-1", targetRole: "reviewer", sourceReviewRunId: "formal-review-exact", text: "older reviewer", deliveryMode: "queue" },
          { id: "message-2", targetRole: "developer", sourceReviewRunId: null, text: "forced developer", deliveryMode: "interrupt" },
        ],
        expectedFirst: "developer_followup",
      },
    ] as const;

    for (const scenario of cases) {
      const persistence = new MemoryConversationPersistence(task(), [
        run("formal-review-exact", "reviewer", "completed", "review-session-exact"),
        scenario.active,
      ]);
      for (const message of scenario.queued) await persistQueuedMessage(persistence, message);
      const agentRuns = new ScenarioAgentRuns(persistence);
      const service = new ConversationService({ persistence, agentRuns, now: () => now });

      service.resume("task-1");
      await service.drain("task-1");

      expect(agentRuns.starts[0]?.runType, scenario.name).toBe(scenario.expectedFirst);
      expect(agentRuns.starts[0]?.prompt, scenario.name).toBe("forced developer");
    }
  });

  test("reconciles terminal and persistence races without stranding queued messages", async () => {
    const cases = [
      { name: "interrupt returns completed", operation: "interrupt", outcome: "completed" },
      { name: "interrupt returns null", operation: "interrupt", outcome: "null" },
      { name: "interrupt rejects", operation: "interrupt", outcome: "reject" },
      { name: "wait returns null", operation: "wait", outcome: "null" },
      { name: "wait rejects", operation: "wait", outcome: "reject" },
      { name: "discard rejects", operation: "discard", outcome: "reject" },
    ] as const;

    for (const scenario of cases) {
      const activeRole = scenario.operation === "wait" ? "developer" : "reviewer";
      const active = run(
        "active-run",
        activeRole === "developer" ? "developer_followup" : "reviewer",
        "running",
        "active-session",
      );
      const persistence = new MemoryConversationPersistence(task(), [active]);
      if (scenario.operation === "discard") persistence.discardFailures = 1;
      const base = new ScenarioAgentRuns(persistence);
      let raced = false;
      const terminatePersistedRun = () => {
        const current = persistence.runs.get("active-run")!;
        persistence.runs.set("active-run", {
          ...current,
          status: "completed",
          processId: null,
          finishedAt: now,
        });
      };
      const agentRuns: ConversationAgentRunPort = {
        start: (startInput) => base.start(startInput),
        async interrupt(runId) {
          if (scenario.operation !== "interrupt" || raced) return await base.interrupt(runId);
          raced = true;
          terminatePersistedRun();
          if (scenario.outcome === "reject") throw new Error("interrupt race");
          return scenario.outcome === "null" ? null : persistence.runs.get(runId)!;
        },
        async waitForTerminal(runId) {
          if (scenario.operation !== "wait" || raced) return await base.waitForTerminal(runId);
          raced = true;
          terminatePersistedRun();
          if (scenario.outcome === "reject") throw new Error("wait race");
          return null;
        },
      };
      const service = new ConversationService({
        persistence,
        agentRuns,
        createId: () => `message-${scenario.name}`,
        now: () => now,
        retryDelay: async () => {},
      });

      await service.enqueue(input("developer"));
      await service.drain("task-1");

      expect(base.starts, scenario.name).toHaveLength(1);
      expect([...persistence.messages.values()][0], scenario.name).toMatchObject({ status: "delivered" });
      if (scenario.operation === "discard") {
        expect(persistence.order.filter((entry) => entry.startsWith("findings:discard")), scenario.name)
          .toEqual(["findings:discard-failed:active-run", "findings:discard:active-run"]);
      }
    }
  });

  test("marks every combined message failed when the resumed turn fails", async () => {
    const persistence = new MemoryConversationPersistence(task());
    const agentRuns = new ScenarioAgentRuns(persistence, false);
    const service = new ConversationService({ persistence, agentRuns, now: () => now });
    for (const [id, text] of [["message-1", "first"], ["message-2", "second"]] as const) {
      await persistQueuedMessage(persistence, {
        id,
        targetRole: "developer",
        sourceReviewRunId: null,
        text,
        deliveryMode: "queue",
      });
    }
    service.resume("task-1");
    await nextTurn();
    agentRuns.completeDelivery("failed");
    await service.drain("task-1");

    expect([...persistence.messages.values()].map((message) => message.status)).toEqual(["failed", "failed"]);
    expect(agentRuns.starts[0]?.prompt).toBe("first\n\n---\n\nsecond");
  });

  test("resumes durable delivery batches after crashes before and after Run association", async () => {
    const cases = [
      { name: "reserved before Run insertion", runStatus: null, expected: "delivered", starts: 1 },
      { name: "Run completed before batch settlement", runStatus: "completed", expected: "delivered", starts: 0 },
      { name: "Run failed before batch settlement", runStatus: "failed", expected: "failed", starts: 0 },
    ] as const;

    for (const scenario of cases) {
      const persistence = new MemoryConversationPersistence(task());
      await persistQueuedMessage(persistence, {
        id: "message-z",
        targetRole: "developer",
        sourceReviewRunId: null,
        text: "recover me",
        deliveryMode: "queue",
      });
      const batch = await persistence.reserveDeliveryBatch({
        id: "batch-1",
        projectId: "project-1",
        taskId: "task-1",
        messageIds: ["message-z"],
        targetRole: "developer",
        sourceReviewRunId: null,
        deliveryMode: "queue",
        interruptedReviewRunId: null,
        createdAt: now,
        updatedAt: now,
      });
      if (scenario.runStatus) {
        const associated = run("associated-run", "developer_followup", scenario.runStatus, "developer-session-exact");
        persistence.runs.set(associated.id, associated);
        persistence.batches.set(batch!.id, { ...batch!, runId: associated.id });
      }
      const agentRuns = new ScenarioAgentRuns(persistence);
      const service = new ConversationService({ persistence, agentRuns, now: () => now });

      service.resume("task-1");
      await service.drain("task-1");

      expect(agentRuns.starts, scenario.name).toHaveLength(scenario.starts);
      expect(persistence.messages.get("message-z")?.status, scenario.name).toBe(scenario.expected);
      expect(persistence.batches.size, scenario.name).toBe(0);
    }
  });

  test("recovers atomically when settlement fails after every message became delivering", async () => {
    const persistence = new MemoryConversationPersistence(task());
    persistence.settleFailures = 1;
    await persistQueuedMessage(persistence, {
      id: "message-z",
      targetRole: "developer",
      sourceReviewRunId: null,
      text: "first by sequence",
      deliveryMode: "queue",
    });
    await persistQueuedMessage(persistence, {
      id: "message-a",
      targetRole: "developer",
      sourceReviewRunId: null,
      text: "second by sequence",
      deliveryMode: "queue",
    });
    const agentRuns = new ScenarioAgentRuns(persistence);
    const service = new ConversationService({
      persistence,
      agentRuns,
      createDeliveryBatchId: () => "batch-1",
      now: () => now,
      retryDelay: async () => {},
    });

    service.resume("task-1");
    await service.drain("task-1");

    expect(agentRuns.starts).toHaveLength(1);
    expect(agentRuns.starts[0]?.prompt).toBe("first by sequence\n\n---\n\nsecond by sequence");
    expect(persistence.batchStatusSnapshots).toEqual([
      ["delivering", "delivering"],
      ["delivering", "delivering"],
      ["delivered", "delivered"],
    ]);
    expect([...persistence.messages.values()].map((message) => message.status))
      .toEqual(["delivered", "delivered"]);
  });
});
