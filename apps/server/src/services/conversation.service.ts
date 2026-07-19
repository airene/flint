import type {
  AgentRole,
  AgentRun,
  CreateTaskMessageRequest,
  Task,
  TaskMessage,
  TaskMessageStatus,
} from "@local-pair-review/shared";
import type { StartAgentRunInput, StartedAgentRun } from "./agent-run.service";

export type MessageTransitionPatch = Pick<
  TaskMessage,
  "status" | "updatedAt" | "deliveredAt" | "errorMessage"
>;

export interface ConversationPersistencePort {
  createMessage(message: TaskMessage, attachmentIds?: string[]): Promise<TaskMessage>;
  transitionMessage(
    messageId: string,
    from: TaskMessageStatus,
    patch: MessageTransitionPatch,
  ): Promise<TaskMessage | null>;
  getTask(taskId: string): Promise<Task | null>;
  getRun(runId: string): Promise<AgentRun | null>;
  listRuns(taskId: string): Promise<AgentRun[]>;
  listMessages(taskId: string): Promise<TaskMessage[]>;
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
  now?: () => string;
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

class MissingExactSessionError extends Error {
  constructor(role: AgentRole) {
    super(`Cannot deliver ${role} follow-up without the exact stored ${role} session`);
    this.name = "MissingExactSessionError";
  }
}

export class ConversationService {
  private readonly persistence: ConversationPersistencePort;
  private readonly agentRuns: ConversationAgentRunPort;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly terminalWaiters = new Map<string, { runId: string; promise: Promise<void> }>();

  constructor(options: ConversationServiceOptions) {
    this.persistence = options.persistence;
    this.agentRuns = options.agentRuns;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
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
      if (!current && !waiter) return;
      await Promise.all([current, waiter].filter((promise): promise is Promise<void> => Boolean(promise)));
    }
  }

  private schedule(taskId: string): void {
    const prior = this.pumps.get(taskId) ?? Promise.resolve();
    const pump = prior.catch(() => {}).then(() => this.processTask(taskId));
    this.pumps.set(taskId, pump);
    const cleanup = () => {
      if (this.pumps.get(taskId) === pump) this.pumps.delete(taskId);
    };
    void pump.then(cleanup, cleanup);
  }

  private async processTask(taskId: string): Promise<void> {
    while (true) {
      const queued = (await this.persistence.listMessages(taskId))
        .filter((message) => message.status === "queued");
      if (queued.length === 0) return;

      const active = (await this.persistence.listRuns(taskId))
        .find((run) => activeRunStatuses.has(run.status)) ?? null;
      const candidate = this.nextMessage(queued, active);
      if (!candidate) return;

      if (active) {
        const cleared = await this.clearActiveRun(active, candidate, queued);
        if (!cleared) return;
        continue;
      }

      const group = this.messageGroup(queued, candidate);
      await this.deliver(group);
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
  ): Promise<boolean> {
    const activeRole = roleForRun(active);
    const mustInterruptReviewer = activeRole === "reviewer" && message.targetRole === "developer";
    const mayInterruptSameRole = queued.some((queuedMessage) => (
      queuedMessage.targetRole === activeRole && queuedMessage.deliveryMode === "interrupt"
    ));

    if (!mustInterruptReviewer && !mayInterruptSameRole) {
      this.watchTerminal(active);
      return false;
    }

    const terminal = await this.agentRuns.interrupt(active.id);
    if (!terminal || (terminal.status !== "cancelled" && terminal.status !== "interrupted")) return false;
    if (mustInterruptReviewer && active.runType === "reviewer") {
      await this.persistence.discardIncompleteFormalFindings(active.id);
    }
    return true;
  }

  private watchTerminal(active: AgentRun): void {
    const current = this.terminalWaiters.get(active.taskId);
    if (current?.runId === active.id) return;
    const promise = Promise.resolve()
      .then(() => this.agentRuns.waitForTerminal(active.id))
      .then((terminal) => {
        if (terminal && !activeRunStatuses.has(terminal.status)) this.schedule(active.taskId);
      });
    this.terminalWaiters.set(active.taskId, { runId: active.id, promise });
    const cleanup = () => {
      if (this.terminalWaiters.get(active.taskId)?.promise === promise) {
        this.terminalWaiters.delete(active.taskId);
      }
    };
    void promise.then(cleanup, cleanup);
  }

  private messageGroup(queued: TaskMessage[], first: TaskMessage): TaskMessage[] {
    const start = queued.findIndex((message) => message.id === first.id);
    if (start < 0) return [];
    const grouped: TaskMessage[] = [];
    for (let index = start; index < queued.length; index += 1) {
      const message = queued[index]!;
      if (message.targetRole !== first.targetRole) break;
      if (message.targetRole === "reviewer" && message.sourceReviewRunId !== first.sourceReviewRunId) break;
      grouped.push(message);
    }
    return grouped;
  }

  private async deliver(messages: TaskMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const delivering: TaskMessage[] = [];
    for (const message of messages) {
      const transitioned = await this.persistence.transitionMessage(message.id, "queued", {
        status: "delivering",
        updatedAt: this.now(),
        deliveredAt: null,
        errorMessage: null,
      });
      if (transitioned) delivering.push(transitioned);
    }
    if (delivering.length === 0) return;

    try {
      const task = await this.persistence.getTask(delivering[0]!.taskId);
      if (!task || task.projectId !== delivering[0]!.projectId) throw new Error("Task not found for message delivery");
      const sessionId = await this.exactSession(task, delivering[0]!);
      const started = await this.agentRuns.start({
        task,
        runType: delivering[0]!.targetRole === "reviewer" ? "reviewer_followup" : "developer_followup",
        prompt: delivering.map((message) => message.text).join(visibleMessageSeparator),
        sessionId,
      });
      const terminal = await started.completion;
      if (terminal.status !== "completed") {
        throw new Error(terminal.errorMessage ?? `Follow-up Run ended as ${terminal.status}`);
      }
      for (const message of delivering) {
        await this.persistence.transitionMessage(message.id, "delivering", {
          status: "delivered",
          updatedAt: this.now(),
          deliveredAt: this.now(),
          errorMessage: null,
        });
      }
    } catch (error) {
      for (const message of delivering) {
        await this.persistence.transitionMessage(message.id, "delivering", {
          status: "failed",
          updatedAt: this.now(),
          deliveredAt: null,
          errorMessage: errorText(error),
        });
      }
    }
  }

  private async exactSession(task: Task, message: TaskMessage): Promise<string> {
    if (message.targetRole === "developer") {
      if (!task.developerSessionId) throw new MissingExactSessionError("developer");
      return task.developerSessionId;
    }

    if (!message.sourceReviewRunId) throw new MissingExactSessionError("reviewer");
    const selected = await this.persistence.getRun(message.sourceReviewRunId);
    if (!selected
      || selected.projectId !== message.projectId
      || selected.taskId !== message.taskId
      || selected.runType !== "reviewer"
      || selected.status !== "completed"
      || !selected.externalSessionId) {
      throw new MissingExactSessionError("reviewer");
    }
    return selected.externalSessionId;
  }
}
