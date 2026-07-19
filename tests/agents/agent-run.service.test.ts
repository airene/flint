import { describe, expect, test } from "bun:test";
import type {
  AgentAvailability,
  AgentDriver,
  AgentEvent,
  AgentRun,
  AgentStartRequest,
  AgentStartResult,
  Task,
} from "@local-pair-review/shared";
import {
  AgentRunService,
  type AgentRunPersistencePort,
  type FinishRunInput,
  type TaskRunStatePort,
} from "../../apps/server/src/services/agent-run.service";
import { EventService } from "../../apps/server/src/services/event.service";
import { AgentProcessError } from "../../apps/server/src/utils/process-supervisor";

class ScenarioDriver implements AgentDriver {
  readonly provider: "codex" | "claude";

  constructor(
    provider: "codex" | "claude",
    private readonly result: AgentStartResult | AgentProcessError,
    private readonly order: string[],
  ) {
    this.provider = provider;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return {
      installed: true,
      executablePath: `/fake/${this.provider}`,
      version: "fake",
      authentication: "authenticated",
      model: null,
      modelSource: null,
      reasoningEffort: null,
      message: null,
    };
  }

  async start(request: AgentStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult> {
    await emit(agentEvent(request, "run_started", { processId: 4321 }, this.provider));
    if (!(this.result instanceof AgentProcessError)) {
      const sessionId = this.result.sessionId;
      if (sessionId) {
        const parsed = this.provider === "codex"
          ? { type: "thread.started", thread_id: sessionId }
          : { type: "system", subtype: "init", session_id: sessionId };
        await emit(agentEvent(request, "session_started", { raw: JSON.stringify(parsed), parsed }, this.provider));
      }
      await emit(agentEvent(request, "turn_completed", { raw: "complete", parsed: { type: "turn.completed" } }, this.provider));
      return this.result;
    }
    throw this.result;
  }

  async cancel(): Promise<void> {
    this.order.push(`cancel:${this.provider}`);
  }
}

function agentEvent(
  request: AgentStartRequest,
  type: AgentEvent["type"],
  payload: unknown,
  source: "codex" | "claude",
): AgentEvent {
  return {
    sequence: 0,
    timestamp: "2026-07-18T00:00:00.000Z",
    projectId: request.projectId,
    taskId: request.taskId,
    runId: request.runId,
    source,
    type,
    payload,
  };
}

function task(): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    originalPrompt: "Build the feature.",
    workingDirectory: "/tmp/project",
    baseCommit: "abc123",
    latestSnapshotHash: null,
    developerProvider: "codex",
    reviewerProvider: "claude",
    status: "draft",
    developerSessionId: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    completedAt: null,
  };
}

class MemoryRunPersistence implements AgentRunPersistencePort {
  readonly runs = new Map<string, AgentRun>();
  readonly order: string[];
  readonly finishes: FinishRunInput[] = [];

  constructor(order: string[]) { this.order = order; }

  async create(run: AgentRun): Promise<AgentRun> {
    this.runs.set(run.id, run);
    this.order.push("run:create");
    return run;
  }

  async markRunning(runId: string, processId: number): Promise<void> {
    const run = this.runs.get(runId)!;
    this.runs.set(runId, { ...run, status: "running", processId });
    this.order.push("run:running");
  }

  async recordSession(runId: string, taskId: string, runType: AgentRun["runType"], sessionId: string): Promise<void> {
    const run = this.runs.get(runId)!;
    this.runs.set(runId, { ...run, externalSessionId: sessionId });
    this.order.push(`session:${runType}:${taskId}:${sessionId}`);
  }

  async finish(input: FinishRunInput): Promise<AgentRun> {
    this.finishes.push(input);
    const run = this.runs.get(input.runId)!;
    const finished = { ...run, ...input.patch };
    this.runs.set(input.runId, finished);
    this.order.push(`run:${input.patch.status}`);
    return finished;
  }
}

class RecordingTaskState implements TaskRunStatePort {
  readonly queuedSnapshots: Array<string | undefined> = [];

  constructor(
    private readonly order: string[],
    private readonly persistence: MemoryRunPersistence,
    private readonly failSucceed = false,
  ) {}

  async queue(run: AgentRun, options: { snapshotHash?: string } = {}): Promise<AgentRun> {
    this.queuedSnapshots.push(options.snapshotHash);
    this.order.push(`task:queued:${run.runType}`);
    return this.persistence.create(run);
  }

  async succeed(input: FinishRunInput & { taskId: string; runType: AgentRun["runType"] }): Promise<AgentRun> {
    this.order.push(`task:succeeded:${input.runType}`);
    if (this.failSucceed) throw new Error("terminal transaction failed");
    return this.persistence.finish(input);
  }

  async fail(input: FinishRunInput & { taskId: string; runType: AgentRun["runType"]; sessionId: string | null }): Promise<AgentRun> {
    this.order.push(`task:${input.patch.status}:${input.runType}:${input.sessionId ?? "none"}`);
    return this.persistence.finish(input);
  }
}

function service(
  order: string[],
  codexResult: AgentStartResult | AgentProcessError,
  claudeResult: AgentStartResult | AgentProcessError,
  behavior: { failEventType?: AgentEvent["type"]; failSucceed?: boolean } = {},
) {
  const persistence = new MemoryRunPersistence(order);
  const taskState = new RecordingTaskState(order, persistence, behavior.failSucceed);
  const emitted: AgentEvent[] = [];
  let sequence = 0;
  const events = new EventService({
    async append(input) {
      emitted.push(input.event);
      order.push(`event:persist:${input.event.type}`);
      if (input.event.type === behavior.failEventType) throw new Error(`cannot persist ${input.event.type}`);
      return { ...input.event, sequence: ++sequence };
    },
  }, {
    async broadcast(event) { order.push(`event:broadcast:${event.type}`); },
  });
  return {
    persistence,
    agentRuns: new AgentRunService({
      drivers: {
        codex: new ScenarioDriver("codex", codexResult, order),
        claude: new ScenarioDriver("claude", claudeResult, order),
      },
      persistence,
      taskState,
      events,
      createId: () => "run-created-1",
      now: () => "2026-07-18T00:00:01.000Z",
    }),
    taskState,
    emitted,
  };
}

describe("AgentRunService", () => {
  test("persists exact session before its event and completes a developer run", async () => {
    const order: string[] = [];
    const { agentRuns, persistence } = service(order, {
      sessionId: "codex-session-exact",
      finalMessage: "Done",
      structuredOutput: null,
    }, new AgentProcessError("failed", "unused"));

    const started = await agentRuns.start({ task: task(), runType: "developer_initial", prompt: "Build it" });
    const completed = await started.completion;

    expect(started.run).toMatchObject({ id: "run-created-1", status: "queued", provider: "codex", reviewParseStatus: null });
    expect(completed).toMatchObject({ status: "completed", externalSessionId: "codex-session-exact", finalMessage: "Done" });
    expect(order.indexOf("session:developer_initial:task-1:codex-session-exact"))
      .toBeLessThan(order.indexOf("event:persist:session_started"));
    expect(persistence.finishes[0]?.patch).toMatchObject({ status: "completed", exitCode: 0 });
    expect(order).toContain("task:succeeded:developer_initial");
    expect(order.indexOf("task:succeeded:developer_initial"))
      .toBeLessThan(order.indexOf("event:persist:run_completed"));
  });

  test("does not persist completed when the terminal transaction fails", async () => {
    const order: string[] = [];
    const { agentRuns } = service(order, {
      sessionId: "codex-session-exact",
      finalMessage: "Done",
      structuredOutput: null,
    }, new AgentProcessError("failed", "unused"), { failSucceed: true });

    const terminal = await (await agentRuns.start({
      task: task(),
      runType: "developer_initial",
      prompt: "Build it",
    })).completion;

    expect(terminal.status).toBe("failed");
    expect(order).not.toContain("event:persist:run_completed");
    expect(order).toContain("event:persist:run_failed");
  });

  test("does not create a contradictory failed terminal when completed-event persistence fails", async () => {
    const order: string[] = [];
    const { agentRuns, persistence } = service(order, {
      sessionId: "codex-session-exact",
      finalMessage: "Done",
      structuredOutput: null,
    }, new AgentProcessError("failed", "unused"), { failEventType: "run_completed" });

    const terminal = await (await agentRuns.start({
      task: task(),
      runType: "developer_initial",
      prompt: "Build it",
    })).completion;

    expect(terminal.status).toBe("completed");
    expect(persistence.finishes).toHaveLength(1);
    expect(order).not.toContain("event:persist:run_failed");
    expect(order.some((entry) => entry.startsWith("task:failed"))).toBe(false);
  });

  test("classifies cancellation and delegates task fallback with the captured session", async () => {
    const order: string[] = [];
    const cancelled = new AgentProcessError("cancelled", "cancelled by user", 143);
    const { agentRuns } = service(order, cancelled, new AgentProcessError("failed", "unused"));

    const started = await agentRuns.start({ task: task(), runType: "developer_initial", prompt: "Build it" });
    const terminal = await started.completion;

    expect(terminal).toMatchObject({ status: "cancelled", exitCode: 143, errorMessage: "cancelled by user" });
    expect(order).toContain("task:cancelled:developer_initial:none");
    expect(order.indexOf("task:cancelled:developer_initial:none"))
      .toBeLessThan(order.indexOf("event:persist:run_cancelled"));
  });

  test("redacts token-bearing stderr before persisting a failed run", async () => {
    const order: string[] = [];
    const failure = new AgentProcessError(
      "failed",
      "OPENAI_API_KEY=plain-api-secret Authorization: Bearer bearer-secret",
      23,
    );
    const { agentRuns } = service(order, failure, new AgentProcessError("failed", "unused"));

    const terminal = await (await agentRuns.start({
      task: task(),
      runType: "developer_initial",
      prompt: "Build it",
    })).completion;

    expect(terminal.errorMessage).toContain("[REDACTED]");
    expect(terminal.errorMessage).not.toContain("plain-api-secret");
    expect(terminal.errorMessage).not.toContain("bearer-secret");
  });

  test("redacts successful output before run and lifecycle-event persistence", async () => {
    const order: string[] = [];
    const { agentRuns, persistence, emitted } = service(order, {
      sessionId: "codex-session-exact",
      finalMessage: "Bearer bearer-final-secret completed with sk-live-final-secret",
      structuredOutput: {
        summary: "Bearer bearer-summary-secret",
        nested: {
          apiKey: "plain-nested-api-key",
          child: { authToken: "plain-nested-auth-token", message: "sk-live-nested-secret" },
        },
      },
    }, new AgentProcessError("failed", "unused"));

    const terminal = await (await agentRuns.start({
      task: task(),
      runType: "developer_initial",
      prompt: "Build it",
    })).completion;

    const persisted = JSON.stringify(persistence.finishes[0]?.patch);
    const lifecycle = JSON.stringify(emitted.find((event) => event.type === "run_completed")?.payload);
    for (const rawSecret of [
      "bearer-final-secret",
      "sk-live-final-secret",
      "bearer-summary-secret",
      "plain-nested-api-key",
      "plain-nested-auth-token",
      "sk-live-nested-secret",
    ]) {
      expect(JSON.stringify(terminal)).not.toContain(rawSecret);
      expect(persisted).not.toContain(rawSecret);
      expect(lifecycle).not.toContain(rawSecret);
    }
    expect(terminal.structuredOutput).toEqual({
      summary: "Bearer [REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        child: { authToken: "[REDACTED]", message: "[REDACTED]" },
      },
    });
  });

  test("selects the task's reviewer provider and persists its session by run type", async () => {
    const order: string[] = [];
    const { agentRuns, taskState } = service(order, {
      sessionId: "codex-reviewer-session",
      finalMessage: "Review complete",
      structuredOutput: { summary: "Pass", verdict: "pass", findings: [] },
    }, new AgentProcessError("failed", "unused"));

    const started = await agentRuns.start({
      task: { ...task(), status: "ready_for_review", reviewerProvider: "codex" },
      runType: "reviewer",
      prompt: "Review",
      snapshotHash: "snapshot-review-1",
    });
    const completed = await started.completion;

    expect(started.run).toMatchObject({ provider: "codex", reviewParseStatus: "pending" });
    expect(completed.structuredOutput).toEqual({ summary: "Pass", verdict: "pass", findings: [] });
    expect(order).toContain("task:succeeded:reviewer");
    expect(order).toContain("session:reviewer:task-1:codex-reviewer-session");
    expect(taskState.queuedSnapshots).toEqual(["snapshot-review-1"]);
  });

  test("selects the task's developer provider and persists its session by run type", async () => {
    const order: string[] = [];
    const { agentRuns } = service(order, new AgentProcessError("failed", "unused"), {
      sessionId: "claude-developer-session",
      finalMessage: "Done",
      structuredOutput: null,
    });

    const started = await agentRuns.start({
      task: { ...task(), developerProvider: "claude" },
      runType: "developer_initial",
      prompt: "Build",
    });
    const completed = await started.completion;

    expect(started.run.provider).toBe("claude");
    expect(completed.externalSessionId).toBe("claude-developer-session");
    expect(order).toContain("session:developer_initial:task-1:claude-developer-session");
  });
});
