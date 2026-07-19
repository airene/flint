import type {
  AgentDriver,
  AgentEvent,
  AgentRun,
  AgentRunStatus,
  AgentRunType,
  AgentStartResult,
  Provider,
  ReviewParseStatus,
  Task,
} from "@local-pair-review/shared";
import { AgentProcessError } from "../utils/process-supervisor";
import { redactSensitive } from "../utils/redact";
import { createRunEvent } from "../utils/agent-event";
import type { EventService } from "./event.service";
import { taskStatusPolicyForRun, type TaskStatusPolicy } from "./task-run-state";

export interface FinishRunInput {
  runId: string;
  patch: {
    status: AgentRunStatus;
    reviewParseStatus: ReviewParseStatus | null;
    exitCode: number | null;
    finalMessage: string | null;
    structuredOutput: unknown | null;
    errorMessage: string | null;
    finishedAt: string;
  };
}

export interface AgentRunPersistencePort {
  markRunning(runId: string, processId: number): Promise<void>;
  /** Must update AgentRun.externalSessionId and, for developer runs, Task.developerSessionId atomically. */
  recordSession(runId: string, taskId: string, runType: AgentRunType, sessionId: string): Promise<void>;
}

export interface TaskRunStatePort {
  /** Must atomically insert the queued Run, bind a delivery batch when supplied, check locks, and transition Task. */
  queue(run: AgentRun, options?: { snapshotHash?: string; deliveryBatchId?: string }): Promise<AgentRun>;
  /** Must atomically finish the Run and either transition or preserve current Task state according to policy. */
  succeed(input: FinishRunInput & {
    taskId: string;
    runType: AgentRunType;
    /** preserve_current means terminal persistence must not update Task.status. */
    taskStatusPolicy: TaskStatusPolicy;
  }): Promise<AgentRun>;
  /** Must atomically finish the Run and either apply the fallback or preserve current Task state according to policy. */
  fail(input: FinishRunInput & {
    taskId: string;
    runType: AgentRunType;
    sessionId: string | null;
    /** preserve_current means terminal persistence must not update Task.status. */
    taskStatusPolicy: TaskStatusPolicy;
  }): Promise<AgentRun>;
}

export interface StartAgentRunInput {
  task: Task;
  runType: AgentRunType;
  prompt: string;
  sessionId?: string;
  /** Review-only snapshot persisted atomically with the queued Run. */
  snapshotHash?: string;
  /** Absolute paths for images already claimed by this Task or message. */
  imagePaths?: readonly string[];
  /** Conversation batch associated atomically with the queued Run. */
  deliveryBatchId?: string;
  signal?: AbortSignal;
}

export interface StartedAgentRun {
  run: AgentRun;
  completion: Promise<AgentRun>;
}

interface AgentRunServiceOptions {
  drivers: Record<Provider, AgentDriver>;
  persistence: AgentRunPersistencePort;
  taskState: TaskRunStatePort;
  events: EventService;
  createId?: () => string;
  now?: () => string;
}

function providerFor(task: Task, runType: AgentRunType): Provider {
  return runType === "reviewer" || runType === "reviewer_followup"
    ? task.reviewerProvider
    : task.developerProvider;
}

function isFollowup(runType: AgentRunType): boolean {
  return runType === "developer_followup" || runType === "reviewer_followup";
}

function sessionFromEvent(event: AgentEvent): string | undefined {
  if (event.type !== "session_started" || !event.payload || typeof event.payload !== "object") return undefined;
  const payload = event.payload as Record<string, unknown>;
  const parsed = payload.parsed;
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.thread_id === "string") return record.thread_id;
  if (typeof record.session_id === "string") return record.session_id;
  return undefined;
}

export class AgentRunService {
  private readonly drivers: Record<Provider, AgentDriver>;
  private readonly persistence: AgentRunPersistencePort;
  private readonly taskState: TaskRunStatePort;
  private readonly events: EventService;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly activeDrivers = new Map<string, AgentDriver>();
  private readonly activeCompletions = new Map<string, Promise<AgentRun>>();
  private readonly interrupting = new Set<string>();

  constructor(options: AgentRunServiceOptions) {
    this.drivers = options.drivers;
    this.persistence = options.persistence;
    this.taskState = options.taskState;
    this.events = options.events;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(input: StartAgentRunInput): Promise<StartedAgentRun> {
    if (isFollowup(input.runType) && !input.sessionId) {
      throw new Error(`${input.runType} requires an exact session`);
    }
    const provider = providerFor(input.task, input.runType);
    const run: AgentRun = {
      id: this.createId(),
      taskId: input.task.id,
      projectId: input.task.projectId,
      provider,
      runType: input.runType,
      status: "queued",
      reviewParseStatus: input.runType === "reviewer" ? "pending" : null,
      externalSessionId: input.sessionId ?? null,
      processId: null,
      exitCode: null,
      prompt: input.prompt,
      finalMessage: null,
      structuredOutput: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    };

    const persisted = await this.taskState.queue(run, {
      ...(input.snapshotHash ? { snapshotHash: input.snapshotHash } : {}),
      ...(input.deliveryBatchId ? { deliveryBatchId: input.deliveryBatchId } : {}),
    });
    const driver = this.drivers[provider];
    this.activeDrivers.set(run.id, driver);
    const completion = Promise.resolve().then(() => this.execute(persisted, input, driver));
    this.activeCompletions.set(run.id, completion);
    const cleanup = () => {
      queueMicrotask(() => this.activeCompletions.delete(run.id));
    };
    void completion.then(cleanup, cleanup);
    return { run: persisted, completion };
  }

  async cancel(runId: string): Promise<void> {
    await this.activeDrivers.get(runId)?.cancel(runId);
  }

  async interrupt(runId: string): Promise<AgentRun | null> {
    const completion = this.activeCompletions.get(runId);
    if (!this.activeDrivers.has(runId) || !completion) return null;
    this.interrupting.add(runId);
    await this.activeDrivers.get(runId)?.cancel(runId);
    return await completion;
  }

  async waitForTerminal(runId: string): Promise<AgentRun | null> {
    return await (this.activeCompletions.get(runId) ?? Promise.resolve(null));
  }

  private async execute(run: AgentRun, input: StartAgentRunInput, driver: AgentDriver): Promise<AgentRun> {
    let capturedSession = input.sessionId ?? null;
    try {
      await this.events.publish(this.lifecycleEvent(run, "run_queued", { runType: run.runType }));
      const request = {
        runId: run.id,
        taskId: run.taskId,
        projectId: run.projectId,
        workingDirectory: input.task.workingDirectory,
        prompt: input.prompt,
        runType: run.runType,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.imagePaths?.length ? { imagePaths: input.imagePaths } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const result = await driver.start(request, async (event) => {
        if (event.type === "run_started") {
          const payload = event.payload as { processId?: unknown };
          if (typeof payload.processId === "number") await this.persistence.markRunning(run.id, payload.processId);
        }
        const sessionId = sessionFromEvent(event);
        if (sessionId && sessionId !== capturedSession) {
          capturedSession = sessionId;
          await this.persistence.recordSession(run.id, run.taskId, run.runType, sessionId);
        }
        await this.events.publish(event);
      });

      if (result.sessionId && result.sessionId !== capturedSession) {
        capturedSession = result.sessionId;
        await this.persistence.recordSession(run.id, run.taskId, run.runType, result.sessionId);
      }
      const patch = this.successPatch(run, result);
      const terminal = await this.taskState.succeed({
        runId: run.id,
        taskId: run.taskId,
        runType: run.runType,
        taskStatusPolicy: taskStatusPolicyForRun(run.runType),
        patch,
      });
      try {
        await this.events.publish(this.lifecycleEvent(run, "run_completed", { finalMessage: patch.finalMessage }));
      } catch {
        // The completed Run/Task transaction is authoritative; never emit a contradictory failure.
      }
      return terminal;
    } catch (error) {
      const interrupted = this.interrupting.has(run.id);
      const cancelled = error instanceof AgentProcessError && error.kind === "cancelled";
      const status = interrupted ? "interrupted" : cancelled ? "cancelled" : "failed";
      const terminal = await this.taskState.fail({
        runId: run.id,
        taskId: run.taskId,
        runType: run.runType,
        sessionId: capturedSession,
        taskStatusPolicy: taskStatusPolicyForRun(run.runType),
        patch: {
          status,
          reviewParseStatus: run.reviewParseStatus,
          exitCode: error instanceof AgentProcessError ? error.exitCode : null,
          finalMessage: null,
          structuredOutput: null,
          errorMessage: redactSensitive(error instanceof Error ? error.message : String(error)),
          finishedAt: this.now(),
        },
      });
      try {
        await this.events.publish(this.lifecycleEvent(
          run,
          interrupted ? "run_interrupted" : cancelled ? "run_cancelled" : "run_failed",
          { message: error instanceof Error ? error.message : String(error) },
        ));
      } catch {
        // The terminal Run/Task transaction is authoritative.
      }
      return terminal;
    } finally {
      this.activeDrivers.delete(run.id);
      this.interrupting.delete(run.id);
    }
  }

  private successPatch(run: AgentRun, result: AgentStartResult): FinishRunInput["patch"] {
    return {
      status: "completed",
      reviewParseStatus: run.reviewParseStatus,
      exitCode: 0,
      finalMessage: redactSensitive(result.finalMessage),
      structuredOutput: run.runType === "reviewer_followup"
        ? null
        : redactSensitive(result.structuredOutput),
      errorMessage: null,
      finishedAt: this.now(),
    };
  }

  private lifecycleEvent(run: AgentRun, type: AgentEvent["type"], payload: unknown): AgentEvent {
    return createRunEvent(run, "system", type, payload, this.now());
  }
}
