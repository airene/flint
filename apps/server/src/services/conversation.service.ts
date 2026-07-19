import type {
  AgentRole,
  AgentRun,
  CreateTaskMessageRequest,
  MessageDeliveryMode,
  Task,
  TaskMessage,
} from "@local-pair-review/shared";
import type { StartAgentRunInput, StartedAgentRun } from "./agent-run.service";

export interface ConversationDeliveryBatch {
  id: string;
  projectId: string;
  taskId: string;
  /** Stable FIFO order; this is also the prompt concatenation order. */
  messageIds: string[];
  targetRole: AgentRole;
  sourceReviewRunId: string | null;
  deliveryMode: MessageDeliveryMode;
  /** Set atomically with Run insertion by TaskRunStatePort.queue. */
  runId: string | null;
  /** A formal Review whose incomplete findings must be discarded before delivery. */
  interruptedReviewRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveDeliveryBatchInput extends Omit<ConversationDeliveryBatch, "runId"> {
  runId?: never;
}

export interface SettleDeliveryBatchInput {
  batchId: string;
  status: "delivered" | "failed";
  updatedAt: string;
  deliveredAt: string | null;
  errorMessage: string | null;
}

export interface ConversationPersistencePort {
  createMessage(message: TaskMessage, attachmentIds?: string[]): Promise<TaskMessage>;
  /** Must return every Task message in a durable monotonically increasing FIFO order. */
  listMessagesInFifoOrder(taskId: string): Promise<TaskMessage[]>;
  /** Must return open batches in their durable reservation order. */
  listOpenDeliveryBatches(taskId: string): Promise<ConversationDeliveryBatch[]>;
  /** Atomically creates the batch and transitions every named queued message to delivering, or returns null. */
  reserveDeliveryBatch(input: ReserveDeliveryBatchInput): Promise<ConversationDeliveryBatch | null>;
  /** Atomically applies one terminal state to every batch message and closes the batch. */
  settleDeliveryBatch(input: SettleDeliveryBatchInput): Promise<TaskMessage[]>;
  getTask(taskId: string): Promise<Task | null>;
  getRun(runId: string): Promise<AgentRun | null>;
  listRuns(taskId: string): Promise<AgentRun[]>;
  attachmentPaths(messageIds: readonly string[]): Promise<string[]>;
  /** Must be idempotent so an open batch can retry after a crash or persistence error. */
  discardIncompleteFormalFindings(runId: string): Promise<void>;
}

export interface ConversationAgentRunPort {
  start(input: StartAgentRunInput): Promise<StartedAgentRun>;
  interrupt(runId: string): Promise<AgentRun | null>;
  waitForTerminal(runId: string): Promise<AgentRun | null>;
}

export interface QueueTaskMessageInput extends CreateTaskMessageRequest {
  projectId: string;
  taskId: string;
}

export interface ConversationServiceOptions {
  persistence: ConversationPersistencePort;
  agentRuns: ConversationAgentRunPort;
  createId?: () => string;
  createDeliveryBatchId?: () => string;
  now?: () => string;
  /** Used only when a provider/control race has no terminal acknowledgement. */
  retryDelay?: (attempt: number) => Promise<void>;
}

const activeRunStatuses = new Set<AgentRun["status"]>(["queued", "running"]);
const visibleMessageSeparator = "\n\n---\n\n";

function roleForRun(run: AgentRun): AgentRole {
  return run.runType === "reviewer" || run.runType === "reviewer_followup"
    ? "reviewer"
    : "developer";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultRetryDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(50 * (2 ** Math.max(0, attempt - 1)), 1_000);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

class MissingExactSessionError extends Error {
  constructor(role: AgentRole) {
    super(`Cannot deliver ${role} follow-up without the exact stored ${role} session`);
    this.name = "MissingExactSessionError";
  }
}

type ClearActiveResult =
  | { kind: "cleared"; interruptedReviewRunId: string | null }
  | { kind: "waiting" };

export class ConversationService {
  private readonly persistence: ConversationPersistencePort;
  private readonly agentRuns: ConversationAgentRunPort;
  private readonly createId: () => string;
  private readonly createDeliveryBatchId: () => string;
  private readonly now: () => string;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly terminalWaiters = new Map<string, { runId: string; promise: Promise<void> }>();
  private readonly retries = new Map<string, Promise<void>>();
  private readonly retryAttempts = new Map<string, number>();

  constructor(options: ConversationServiceOptions) {
    this.persistence = options.persistence;
    this.agentRuns = options.agentRuns;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.createDeliveryBatchId = options.createDeliveryBatchId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  async enqueue(input: QueueTaskMessageInput): Promise<TaskMessage> {
    const timestamp = this.now();
    const message: TaskMessage = {
      id: this.createId(),
      projectId: input.projectId,
      taskId: input.taskId,
      targetRole: input.targetRole,
      sourceReviewRunId: input.sourceReviewRunId,
      text: input.text,
      deliveryMode: input.deliveryMode,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveredAt: null,
      errorMessage: null,
    };

    const persisted = await this.persistence.createMessage(message, input.attachmentIds);
    this.schedule(input.taskId);
    return persisted;
  }

  resume(taskId: string): void {
    this.schedule(taskId);
  }

  async drain(taskId: string): Promise<void> {
    while (true) {
      const current = this.pumps.get(taskId);
      const waiter = this.terminalWaiters.get(taskId)?.promise;
      const retry = this.retries.get(taskId);
      if (!current && !waiter && !retry) return;
      await Promise.all([current, waiter, retry].filter((promise): promise is Promise<void> => Boolean(promise)));
    }
  }

  private schedule(taskId: string): void {
    const prior = this.pumps.get(taskId) ?? Promise.resolve();
    const pump = prior.catch(() => {}).then(() => this.processTask(taskId));
    this.pumps.set(taskId, pump);
    const cleanup = () => {
      if (this.pumps.get(taskId) === pump) this.pumps.delete(taskId);
    };
    void pump.then(cleanup, (error) => {
      cleanup();
      this.scheduleRetry(taskId);
      return error;
    });
  }

  private async processTask(taskId: string): Promise<void> {
    while (true) {
      const openBatch = (await this.persistence.listOpenDeliveryBatches(taskId))[0] ?? null;
      if (openBatch) {
        if (!(await this.processBatch(openBatch))) return;
        continue;
      }

      const queued = (await this.persistence.listMessagesInFifoOrder(taskId))
        .filter((message) => message.status === "queued");
      if (queued.length === 0) return;

      const active = await this.activeRun(taskId);
      const candidate = this.nextMessage(queued, active);
      if (!candidate) return;
      let interruptedReviewRunId: string | null = null;
      if (active) {
        const result = await this.clearActiveRun(active, candidate, queued);
        if (result.kind === "waiting") return;
        interruptedReviewRunId = result.interruptedReviewRunId;
      }

      const group = this.messageGroup(queued, candidate);
      const batch = await this.reserveBatch(group, interruptedReviewRunId);
      if (!batch) {
        this.scheduleRetry(taskId);
        return;
      }
      if (!(await this.processBatch(batch))) return;
    }
  }

  private async processBatch(batch: ConversationDeliveryBatch): Promise<boolean> {
    const ordered = await this.persistence.listMessagesInFifoOrder(batch.taskId);
    const byId = new Map(ordered.map((message) => [message.id, message]));
    const messages = batch.messageIds.map((id) => byId.get(id)).filter((message): message is TaskMessage => Boolean(message));
    if (messages.length !== batch.messageIds.length) {
      return await this.settleBatch(batch, "failed", "Delivery batch references missing messages");
    }

    if (batch.interruptedReviewRunId) {
      try {
        await this.persistence.discardIncompleteFormalFindings(batch.interruptedReviewRunId);
      } catch {
        this.scheduleRetry(batch.taskId);
        return false;
      }
    }

    if (batch.runId) return await this.reconcileBatchRun(batch);

    const active = await this.activeRun(batch.taskId);
    if (active) {
      const result = await this.clearActiveRun(active, messages[0]!, messages);
      if (result.kind === "waiting") return false;
      if (result.interruptedReviewRunId) {
        try {
          await this.persistence.discardIncompleteFormalFindings(result.interruptedReviewRunId);
        } catch {
          this.scheduleRetry(batch.taskId);
          return false;
        }
      }
    }

    try {
      const task = await this.persistence.getTask(batch.taskId);
      if (!task || task.projectId !== batch.projectId) throw new Error("Task not found for message delivery");
      const sessionId = await this.exactSession(task, messages[0]!);
      const imagePaths = await this.persistence.attachmentPaths(batch.messageIds);
      const started = await this.agentRuns.start({
        task,
        runType: batch.targetRole === "reviewer" ? "reviewer_followup" : "developer_followup",
        prompt: messages.map((message) => message.text).join(visibleMessageSeparator),
        sessionId,
        deliveryBatchId: batch.id,
        imagePaths,
      });
      const terminal = await started.completion;
      return terminal.status === "completed"
        ? await this.settleBatch(batch, "delivered", null)
        : await this.settleBatch(batch, "failed", terminal.errorMessage ?? `Follow-up Run ended as ${terminal.status}`);
    } catch (error) {
      return await this.settleBatch(batch, "failed", errorText(error));
    }
  }

  private async reconcileBatchRun(batch: ConversationDeliveryBatch): Promise<boolean> {
    let run: AgentRun | null;
    try {
      run = await this.persistence.getRun(batch.runId!);
    } catch {
      this.scheduleRetry(batch.taskId);
      return false;
    }
    if (!run) {
      this.scheduleRetry(batch.taskId);
      return false;
    }
    if (activeRunStatuses.has(run.status)) {
      this.watchTerminal(run);
      return false;
    }
    return run.status === "completed"
      ? await this.settleBatch(batch, "delivered", null)
      : await this.settleBatch(batch, "failed", run.errorMessage ?? `Follow-up Run ended as ${run.status}`);
  }

  private async settleBatch(
    batch: ConversationDeliveryBatch,
    status: SettleDeliveryBatchInput["status"],
    errorMessage: string | null,
  ): Promise<boolean> {
    try {
      const timestamp = this.now();
      await this.persistence.settleDeliveryBatch({
        batchId: batch.id,
        status,
        updatedAt: timestamp,
        deliveredAt: status === "delivered" ? timestamp : null,
        errorMessage,
      });
      this.resetRetry(batch.taskId);
      return true;
    } catch {
      this.scheduleRetry(batch.taskId);
      return false;
    }
  }

  private async reserveBatch(
    messages: TaskMessage[],
    interruptedReviewRunId: string | null,
  ): Promise<ConversationDeliveryBatch | null> {
    if (messages.length === 0) return null;
    const first = messages[0]!;
    const timestamp = this.now();
    try {
      return await this.persistence.reserveDeliveryBatch({
        id: this.createDeliveryBatchId(),
        projectId: first.projectId,
        taskId: first.taskId,
        messageIds: messages.map((message) => message.id),
        targetRole: first.targetRole,
        sourceReviewRunId: first.sourceReviewRunId,
        deliveryMode: messages.some((message) => message.deliveryMode === "interrupt") ? "interrupt" : "queue",
        interruptedReviewRunId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch {
      return null;
    }
  }

  private nextMessage(queued: TaskMessage[], active: AgentRun | null): TaskMessage | null {
    if (!active) return queued[0] ?? null;
    const activeRole = roleForRun(active);
    if (activeRole === "reviewer") {
      return queued.find((message) => message.targetRole === "developer") ?? queued[0] ?? null;
    }
    return queued.find((message) => (
      message.targetRole === "developer" && message.deliveryMode === "interrupt"
    )) ?? queued[0] ?? null;
  }

  private async clearActiveRun(
    active: AgentRun,
    message: TaskMessage,
    queued: TaskMessage[],
  ): Promise<ClearActiveResult> {
    const activeRole = roleForRun(active);
    const mustInterruptReviewer = activeRole === "reviewer" && message.targetRole === "developer";
    const mayInterruptSameRole = queued.some((queuedMessage) => (
      queuedMessage.targetRole === activeRole && queuedMessage.deliveryMode === "interrupt"
    ));

    if (!mustInterruptReviewer && !mayInterruptSameRole) {
      this.watchTerminal(active);
      return { kind: "waiting" };
    }

    try {
      await this.agentRuns.interrupt(active.id);
    } catch {
      // Provider acknowledgement can race terminal persistence; persisted Run state is authoritative.
    }

    let persisted: AgentRun | null;
    try {
      persisted = await this.persistence.getRun(active.id);
      if (persisted && activeRunStatuses.has(persisted.status)) {
        this.scheduleRetry(active.taskId);
        return { kind: "waiting" };
      }
      if (await this.activeRun(active.taskId)) {
        this.scheduleRetry(active.taskId);
        return { kind: "waiting" };
      }
    } catch {
      this.scheduleRetry(active.taskId);
      return { kind: "waiting" };
    }

    this.resetRetry(active.taskId);
    return {
      kind: "cleared",
      interruptedReviewRunId: mustInterruptReviewer
        && active.runType === "reviewer"
        && (persisted?.status === "cancelled" || persisted?.status === "interrupted")
        ? active.id
        : null,
    };
  }

  private watchTerminal(active: AgentRun): void {
    const current = this.terminalWaiters.get(active.taskId);
    if (current?.runId === active.id) return;
    const promise = Promise.resolve()
      .then(() => this.agentRuns.waitForTerminal(active.id))
      .catch(() => null)
      .then(async () => {
        try {
          const persisted = await this.persistence.getRun(active.id);
          if (!persisted || !activeRunStatuses.has(persisted.status)) {
            this.resetRetry(active.taskId);
            this.schedule(active.taskId);
            return;
          }
        } catch {
          // Fall through to bounded retry.
        }
        this.scheduleRetry(active.taskId);
      });
    this.terminalWaiters.set(active.taskId, { runId: active.id, promise });
    const cleanup = () => {
      if (this.terminalWaiters.get(active.taskId)?.promise === promise) {
        this.terminalWaiters.delete(active.taskId);
      }
    };
    void promise.then(cleanup, cleanup);
  }

  private scheduleRetry(taskId: string): void {
    if (this.retries.has(taskId)) return;
    const attempt = (this.retryAttempts.get(taskId) ?? 0) + 1;
    this.retryAttempts.set(taskId, attempt);
    const retry = this.retryDelay(attempt).then(() => {
      if (this.retries.get(taskId) === retry) this.retries.delete(taskId);
      this.schedule(taskId);
    });
    this.retries.set(taskId, retry);
    void retry.catch(() => {
      if (this.retries.get(taskId) === retry) this.retries.delete(taskId);
      this.scheduleRetry(taskId);
    });
  }

  private resetRetry(taskId: string): void {
    this.retryAttempts.delete(taskId);
  }

  private async activeRun(taskId: string): Promise<AgentRun | null> {
    return (await this.persistence.listRuns(taskId))
      .find((run) => activeRunStatuses.has(run.status)) ?? null;
  }

  private messageGroup(queued: TaskMessage[], first: TaskMessage): TaskMessage[] {
    let start = queued.findIndex((message) => message.id === first.id);
    if (start < 0) return [];
    while (start > 0) {
      const previous = queued[start - 1]!;
      if (previous.targetRole !== first.targetRole) break;
      if (previous.targetRole === "reviewer" && previous.sourceReviewRunId !== first.sourceReviewRunId) break;
      start -= 1;
    }
    const grouped: TaskMessage[] = [];
    for (let index = start; index < queued.length; index += 1) {
      const message = queued[index]!;
      if (message.targetRole !== first.targetRole) break;
      if (message.targetRole === "reviewer" && message.sourceReviewRunId !== first.sourceReviewRunId) break;
      grouped.push(message);
    }
    return grouped;
  }

  private async exactSession(task: Task, message: TaskMessage): Promise<string> {
    if (message.targetRole === "developer") {
      if (!task.developerSessionId) throw new MissingExactSessionError("developer");
      return task.developerSessionId;
    }

    if (!message.sourceReviewRunId) throw new MissingExactSessionError("reviewer");
    const selected = await this.persistence.getRun(message.sourceReviewRunId);
    // Task provider snapshots are immutable; reject corrupted/mismatched history instead of resuming through another driver.
    if (!selected
      || selected.projectId !== message.projectId
      || selected.taskId !== message.taskId
      || selected.runType !== "reviewer"
      || selected.status !== "completed"
      || selected.provider !== task.reviewerProvider
      || !selected.externalSessionId) {
      throw new MissingExactSessionError("reviewer");
    }
    return selected.externalSessionId;
  }
}
