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
    return { installed: true, executablePath: `/fake/${this.provider}`, version: "fake", authentication: "authenticated", message: null };
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
    status: "draft",
    developerSessionId: null,
    reviewerSessionId: null,
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

  async recordSession(runId: string, taskId: string, provider: "codex" | "claude", sessionId: string): Promise<void> {
    const run = this.runs.get(runId)!;
    this.runs.set(runId, { ...run, externalSessionId: sessionId });
    this.order.push(`session:${provider}:${taskId}:${sessionId}`);
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
  constructor(
    private readonly order: string[],
    private readonly persistence: MemoryRunPersistence,
  ) {}

  async queue(run: AgentRun): Promise<AgentRun> {
    this.order.push(`task:queued:${run.runType}`);
    return this.persistence.create(run);
  }

  async succeed(input: FinishRunInput & { taskId: string; runType: AgentRun["runType"] }): Promise<AgentRun> {
    this.order.push(`task:succeeded:${input.runType}`);
    return this.persistence.finish(input);
  }

  async fail(input: FinishRunInput & { taskId: string; runType: AgentRun["runType"]; sessionId: string | null }): Promise<AgentRun> {
    this.order.push(`task:${input.patch.status}:${input.runType}:${input.sessionId ?? "none"}`);
    return this.persistence.finish(input);
  }
}

function service(order: string[], codexResult: AgentStartResult | AgentProcessError, claudeResult: AgentStartResult | AgentProcessError) {
  const persistence = new MemoryRunPersistence(order);
  let sequence = 0;
  const events = new EventService({
    async append(input) {
      order.push(`event:persist:${input.event.type}`);
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
      taskState: new RecordingTaskState(order, persistence),
      events,
      createId: () => "run-created-1",
      now: () => "2026-07-18T00:00:01.000Z",
    }),
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
    expect(order.indexOf("session:codex:task-1:codex-session-exact"))
      .toBeLessThan(order.indexOf("event:persist:session_started"));
    expect(persistence.finishes[0]?.patch).toMatchObject({ status: "completed", exitCode: 0 });
    expect(order).toContain("task:succeeded:developer_initial");
  });

  test("classifies cancellation and delegates task fallback with the captured session", async () => {
    const order: string[] = [];
    const cancelled = new AgentProcessError("cancelled", "cancelled by user", 143);
    const { agentRuns } = service(order, cancelled, new AgentProcessError("failed", "unused"));

    const started = await agentRuns.start({ task: task(), runType: "developer_initial", prompt: "Build it" });
    const terminal = await started.completion;

    expect(terminal).toMatchObject({ status: "cancelled", exitCode: 143, errorMessage: "cancelled by user" });
    expect(order).toContain("task:cancelled:developer_initial:none");
  });

  test("creates reviewer runs with pending parse status and Claude provider", async () => {
    const order: string[] = [];
    const { agentRuns } = service(order, new AgentProcessError("failed", "unused"), {
      sessionId: "claude-session-exact",
      finalMessage: "Review complete",
      structuredOutput: { summary: "Pass", verdict: "pass", findings: [] },
    });

    const started = await agentRuns.start({ task: { ...task(), status: "ready_for_review" }, runType: "reviewer", prompt: "Review" });
    const completed = await started.completion;

    expect(started.run).toMatchObject({ provider: "claude", reviewParseStatus: "pending" });
    expect(completed.structuredOutput).toEqual({ summary: "Pass", verdict: "pass", findings: [] });
    expect(order).toContain("task:succeeded:reviewer");
  });
});
