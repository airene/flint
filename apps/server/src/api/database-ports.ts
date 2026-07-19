import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type {
  AgentEvent,
  AgentRun,
  AgentRunType,
  ApprovalDecision,
  ApprovalRequest,
  FeedbackDelivery,
  FeedbackDraft,
  FindingSelectionMode,
  Provider,
  ReviewFinding,
  Task,
  TaskAttachment,
  TaskMessage,
  TaskStatus,
  UnfinishedTaskSummary,
} from "@local-pair-review/shared";
import type { AppDatabase } from "../db/database";
import {
  agentEvents,
  agentRuns,
  approvalRequests,
  applicationLeases,
  conversationDeliveryBatches,
  feedbackDeliveries,
  feedbackDrafts,
  reviewFindings,
  reviewRunSnapshots,
  runLeases,
  taskAttachments,
  taskMessages,
  tasks,
  projects,
} from "../db/schema";
import type { AgentRunPersistencePort, FinishRunInput, TaskRunStatePort } from "../services/agent-run.service";
import type { EventPersistencePort, PersistAgentEventInput } from "../services/event.service";
import { StaleFeedbackLeaseError, type FeedbackDeliveryPersistencePort, type ReserveFeedbackResult } from "../services/feedback.service";
import type { ReviewPersistencePort } from "../services/review.service";
import type {
  ConversationDeliveryBatch,
  ReserveDeliveryBatchInput,
  SettleDeliveryBatchInput,
} from "../services/conversation.service";
import { GitService } from "../services/git.service";
import { CompletedTaskReadOnlyError, ProjectWriteRunConflictError } from "../services/task.service";
import { NotFoundError } from "./errors";
import {
  taskStatusForRunFailure,
  taskStatusForRunStart,
  taskStatusForRunSuccess,
} from "../services/task-run-state";
import { stopProcessTreeByPid } from "../utils/process-supervisor";

const activeStatuses = ["queued", "running"] as const;
const applicationLeaseSlot = 1;

export class ApplicationAlreadyRunningError extends Error {
  constructor(readonly ownerProcessId: number) {
    super(`Another Flint instance (PID ${ownerProcessId}) owns this database.`);
    this.name = "ApplicationAlreadyRunningError";
  }
}

export class StaleRunOwnershipError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} is no longer owned by this Flint instance.`);
    this.name = "StaleRunOwnershipError";
  }
}

export class PersistenceOwnershipError extends Error {
  constructor(entity: string) {
    super(`${entity} does not belong to the requested Project and Task.`);
    this.name = "PersistenceOwnershipError";
  }
}

export class AttachmentClaimConflictError extends Error {
  constructor(readonly attachmentId: string) {
    super(`Attachment ${attachmentId} is expired or already claimed.`);
    this.name = "AttachmentClaimConflictError";
  }
}

export class InactiveRunApprovalError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} is not active and cannot request approval.`);
    this.name = "InactiveRunApprovalError";
  }
}

export interface DatabasePortsOptions {
  instanceId?: string;
  leaseDurationMs?: number;
  now?: () => string;
}

function rowEvent(row: typeof agentEvents.$inferSelect): AgentEvent {
  const normalized = row.normalizedJson ? JSON.parse(row.normalizedJson) as AgentEvent : null;
  return normalized ?? {
    sequence: row.sequence,
    timestamp: row.createdAt,
    projectId: "",
    taskId: row.taskId,
    runId: row.runId,
    source: row.source,
    type: row.eventType as AgentEvent["type"],
    payload: { raw: row.rawJson },
  };
}

function attachmentExpired(expiresAt: string, now: string): boolean {
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(now);
  return !Number.isFinite(expiry) || !Number.isFinite(current) || expiry <= current;
}

export class DatabasePorts implements
  AgentRunPersistencePort,
  TaskRunStatePort,
  EventPersistencePort,
  ReviewPersistencePort,
  FeedbackDeliveryPersistencePort {
  private readonly feedbackLeases = new Map<string, string>();
  private readonly instanceId: string;
  private readonly managed: boolean;
  private readonly leaseDurationMs: number;
  private readonly now: () => string;

  constructor(
    readonly database: AppDatabase,
    private readonly git = new GitService(),
    options: DatabasePortsOptions = {},
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.managed = options.instanceId !== undefined;
    this.leaseDurationMs = options.leaseDurationMs ?? 5_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private leaseExpiresAt(now = this.now()): string {
    return new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
  }

  private assertApplicationOwner(): void {
    if (!this.managed) return;
    const lease = this.database.sqlite.query(
      "select owner_instance_id as ownerInstanceId from application_leases where slot = 1",
    ).get() as { ownerInstanceId: string } | null;
    if (lease?.ownerInstanceId !== this.instanceId) throw new StaleRunOwnershipError("application");
  }

  private assertRunOwner(runId: string): void {
    const lease = this.database.sqlite.query(
      "select owner_instance_id as ownerInstanceId from run_leases where run_id = ?",
    ).get(runId) as { ownerInstanceId: string } | null;
    if (lease?.ownerInstanceId === this.instanceId) return;
    if (!lease && !this.managed) return;
    throw new StaleRunOwnershipError(runId);
  }

  acquireApplicationLease(processId = process.pid): void {
    const now = this.now();
    this.database.db.transaction((transaction) => {
      const current = transaction.select().from(applicationLeases)
        .where(eq(applicationLeases.slot, applicationLeaseSlot)).get();
      if (current && current.ownerInstanceId !== this.instanceId && current.leaseExpiresAt > now) {
        throw new ApplicationAlreadyRunningError(current.processId);
      }
      if (current) {
        transaction.update(applicationLeases).set({
          ownerInstanceId: this.instanceId,
          processId,
          leaseExpiresAt: this.leaseExpiresAt(now),
        }).where(eq(applicationLeases.slot, applicationLeaseSlot)).run();
      } else {
        transaction.insert(applicationLeases).values({
          slot: applicationLeaseSlot,
          ownerInstanceId: this.instanceId,
          processId,
          leaseExpiresAt: this.leaseExpiresAt(now),
        }).run();
      }
    }, { behavior: "immediate" });
  }

  heartbeatApplicationLease(): boolean {
    const now = this.now();
    return this.database.db.transaction((transaction) => {
      const current = transaction.select().from(applicationLeases)
        .where(eq(applicationLeases.slot, applicationLeaseSlot)).get();
      if (current?.ownerInstanceId !== this.instanceId) return false;
      const leaseExpiresAt = this.leaseExpiresAt(now);
      transaction.update(applicationLeases).set({ leaseExpiresAt })
        .where(and(
          eq(applicationLeases.slot, applicationLeaseSlot),
          eq(applicationLeases.ownerInstanceId, this.instanceId),
        )).run();
      transaction.update(runLeases).set({ leaseExpiresAt })
        .where(eq(runLeases.ownerInstanceId, this.instanceId)).run();
      return true;
    }, { behavior: "immediate" });
  }

  releaseApplicationLease(): void {
    this.database.db.delete(applicationLeases).where(and(
      eq(applicationLeases.slot, applicationLeaseSlot),
      eq(applicationLeases.ownerInstanceId, this.instanceId),
    )).run();
  }

  async queue(run: AgentRun, options: { snapshotHash?: string; deliveryBatchId?: string } = {}): Promise<AgentRun> {
    try {
      return this.database.db.transaction((transaction) => {
        this.assertApplicationOwner();
        const task = transaction.select().from(tasks).where(eq(tasks.id, run.taskId)).get() as Task | undefined;
        if (!task) throw new NotFoundError("Task");
        if (task.projectId !== run.projectId) throw new PersistenceOwnershipError("Run");
        if (run.runType === "reviewer" && !options.snapshotHash) {
          throw new Error("Reviewer runs require a captured snapshot");
        }
        const target = taskStatusForRunStart(task.status, run.runType);
        const writerRun = run.runType === "developer_initial"
          || run.runType === "developer_feedback"
          || run.runType === "developer_followup";
        const activeConflict = transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(
          eq(agentRuns.projectId, run.projectId),
          ...(writerRun ? [] : [inArray(agentRuns.runType, [
            "developer_initial",
            "developer_feedback",
            "developer_followup",
          ])]),
          inArray(agentRuns.status, [...activeStatuses]),
        )).get();
        if (activeConflict) throw new ProjectWriteRunConflictError(run.projectId);
        transaction.insert(agentRuns).values(run).run();
        transaction.insert(runLeases).values({
          runId: run.id,
          ownerInstanceId: this.instanceId,
          leaseExpiresAt: this.leaseExpiresAt(),
        }).run();
        if (options.deliveryBatchId) {
          const batch = transaction.select().from(conversationDeliveryBatches)
            .where(eq(conversationDeliveryBatches.id, options.deliveryBatchId)).get();
          if (!batch
            || batch.projectId !== run.projectId
            || batch.taskId !== run.taskId
            || batch.status !== "open"
            || batch.runId !== null
            || (batch.targetRole === "reviewer") !== (run.runType === "reviewer_followup")) {
            throw new PersistenceOwnershipError("Conversation delivery batch");
          }
          transaction.update(conversationDeliveryBatches).set({
            runId: run.id,
            updatedAt: this.now(),
          }).where(and(
            eq(conversationDeliveryBatches.id, options.deliveryBatchId),
            eq(conversationDeliveryBatches.status, "open"),
            sql`${conversationDeliveryBatches.runId} is null`,
          )).run();
        }
        if (run.runType === "reviewer" && options.snapshotHash) {
          transaction.insert(reviewRunSnapshots).values({
            runId: run.id,
            snapshotHash: options.snapshotHash,
            createdAt: this.now(),
          }).run();
        }
        transaction.update(tasks).set({
          status: target,
          ...(options.snapshotHash ? { latestSnapshotHash: options.snapshotHash } : {}),
          updatedAt: this.now(),
        }).where(eq(tasks.id, task.id)).run();
        return run;
      }, { behavior: "immediate" });
    } catch (error) {
      if (error instanceof ProjectWriteRunConflictError) throw error;
      if (String(error).includes("active_write_run_per_project_unique")) {
        throw new ProjectWriteRunConflictError(run.projectId);
      }
      throw error;
    }
  }

  async markRunning(runId: string, processId: number): Promise<void> {
    this.database.db.transaction((transaction) => {
      this.assertApplicationOwner();
      this.assertRunOwner(runId);
      const run = transaction.select({ status: agentRuns.status }).from(agentRuns)
        .where(eq(agentRuns.id, runId)).get();
      if (run?.status !== "queued") throw new StaleRunOwnershipError(runId);
      transaction.update(agentRuns).set({ status: "running", processId, startedAt: this.now() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued"))).run();
    }, { behavior: "immediate" });
  }

  async recordSession(runId: string, _taskId: string, _runType: AgentRunType, sessionId: string): Promise<void> {
    this.database.db.transaction((transaction) => {
      this.assertApplicationOwner();
      this.assertRunOwner(runId);
      const run = transaction.select({
        status: agentRuns.status,
        taskId: agentRuns.taskId,
        runType: agentRuns.runType,
      }).from(agentRuns)
        .where(eq(agentRuns.id, runId)).get();
      if (!run || !activeStatuses.includes(run.status as typeof activeStatuses[number])) {
        throw new StaleRunOwnershipError(runId);
      }
      transaction.update(agentRuns).set({ externalSessionId: sessionId }).where(and(
        eq(agentRuns.id, runId),
        inArray(agentRuns.status, [...activeStatuses]),
      )).run();
      if (run.runType !== "reviewer" && run.runType !== "reviewer_followup") {
        transaction.update(tasks).set({ developerSessionId: sessionId, updatedAt: this.now() })
          .where(eq(tasks.id, run.taskId)).run();
      }
    }, { behavior: "immediate" });
  }

  async succeed(input: FinishRunInput & { taskId: string; runType: AgentRunType; taskStatusPolicy: "transition" | "preserve_current" }): Promise<AgentRun> {
    return this.finish(input, input.taskStatusPolicy === "preserve_current" ? null : taskStatusForRunSuccess(input.runType));
  }

  async fail(input: FinishRunInput & { taskId: string; runType: AgentRunType; sessionId: string | null; taskStatusPolicy: "transition" | "preserve_current" }): Promise<AgentRun> {
    if (input.taskStatusPolicy === "preserve_current") return this.finish(input, null);
    const task = await this.getTask(input.taskId);
    if (!task) throw new NotFoundError("Task");
    let workingTreeChanged = true;
    if (input.runType === "developer_initial" && !(input.sessionId || task.developerSessionId)) {
      try {
        workingTreeChanged = !(await this.git.status(task.workingDirectory)).clean;
      } catch {
        // Conservatively preserve a recoverable state when Git cannot be inspected.
      }
    }
    const target = taskStatusForRunFailure(input.runType, {
      hasDeveloperSession: Boolean(input.sessionId || task.developerSessionId),
      workingTreeChanged,
    });
    return this.finish(input, target);
  }

  private finish(input: FinishRunInput & { taskId: string }, taskStatus: TaskStatus | null): AgentRun {
    return this.database.db.transaction((transaction) => {
      this.assertApplicationOwner();
      this.assertRunOwner(input.runId);
      const current = transaction.select({ status: agentRuns.status }).from(agentRuns)
        .where(eq(agentRuns.id, input.runId)).get();
      if (!current || !activeStatuses.includes(current.status as typeof activeStatuses[number])) {
        throw new StaleRunOwnershipError(input.runId);
      }
      transaction.update(agentRuns).set({ ...input.patch, processId: null }).where(and(
        eq(agentRuns.id, input.runId),
        inArray(agentRuns.status, [...activeStatuses]),
      )).run();
      if (taskStatus) {
        transaction.update(tasks).set({ status: taskStatus, updatedAt: this.now() }).where(eq(tasks.id, input.taskId)).run();
      }
      transaction.delete(runLeases).where(and(
        eq(runLeases.runId, input.runId),
        eq(runLeases.ownerInstanceId, this.instanceId),
      )).run();
      const run = transaction.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).get();
      if (!run) throw new NotFoundError("Run");
      return run as AgentRun;
    }, { behavior: "immediate" });
  }

  async append(input: PersistAgentEventInput): Promise<AgentEvent> {
    return this.database.db.transaction((transaction) => {
      const latest = transaction.select({ sequence: agentEvents.sequence }).from(agentEvents)
        .where(eq(agentEvents.taskId, input.event.taskId)).orderBy(desc(agentEvents.sequence)).get();
      const event = { ...input.event, sequence: (latest?.sequence ?? 0) + 1 };
      transaction.insert(agentEvents).values({
        id: randomUUID(),
        taskId: event.taskId,
        runId: event.runId,
        sequence: event.sequence,
        source: event.source,
        eventType: event.type,
        rawJson: input.rawJson,
        normalizedJson: JSON.stringify(event),
        createdAt: event.timestamp,
      }).run();
      return event;
    }, { behavior: "immediate" });
  }

  async replay(taskId: string, afterSequence: number): Promise<AgentEvent[]> {
    const rows = await this.database.db.select().from(agentEvents).where(and(
      eq(agentEvents.taskId, taskId),
      gt(agentEvents.sequence, afterSequence),
    )).orderBy(asc(agentEvents.sequence)).all();
    return rows.map(rowEvent);
  }

  async createAttachmentDraft(attachment: TaskAttachment): Promise<TaskAttachment> {
    return this.database.db.transaction((transaction) => {
      const project = transaction.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, attachment.projectId)).get();
      if (!project) throw new NotFoundError("Project");
      if (attachment.state !== "draft" || attachment.taskId || attachment.messageId || attachment.claimedAt) {
        throw new AttachmentClaimConflictError(attachment.id);
      }
      transaction.insert(taskAttachments).values(attachment).run();
      return attachment;
    }, { behavior: "immediate" });
  }

  async getAttachment(attachmentId: string): Promise<TaskAttachment | null> {
    return (await this.database.db.select().from(taskAttachments)
      .where(eq(taskAttachments.id, attachmentId)).get() as TaskAttachment | undefined) ?? null;
  }

  async claimAttachments(
    projectId: string,
    taskId: string,
    attachmentIds: string[],
    messageId: string | null = null,
  ): Promise<TaskAttachment[]> {
    if (attachmentIds.length > 4 || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new AttachmentClaimConflictError(attachmentIds[0] ?? "unknown");
    }
    return this.database.db.transaction((transaction) => {
      const claimedAt = this.now();
      const task = transaction.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) throw new NotFoundError("Task");
      if (task.projectId !== projectId) throw new PersistenceOwnershipError("Attachment claim");
      if (messageId) {
        const message = transaction.select({ projectId: taskMessages.projectId, taskId: taskMessages.taskId })
          .from(taskMessages).where(eq(taskMessages.id, messageId)).get();
        if (!message || message.projectId !== projectId || message.taskId !== taskId) {
          throw new PersistenceOwnershipError("Attachment message");
        }
      }
      for (const attachmentId of attachmentIds) {
        const attachment = transaction.select().from(taskAttachments)
          .where(eq(taskAttachments.id, attachmentId)).get();
        const sameClaim = attachment?.state === "claimed"
          && attachment.projectId === projectId
          && attachment.taskId === taskId
          && attachment.messageId === messageId;
        if (sameClaim) continue;
        if (!attachment
          || attachment.projectId !== projectId
          || attachment.state !== "draft"
          || attachmentExpired(attachment.expiresAt, claimedAt)) {
          throw new AttachmentClaimConflictError(attachmentId);
        }
        transaction.update(taskAttachments).set({
          taskId,
          messageId,
          state: "claimed",
          claimedAt,
        }).where(and(
          eq(taskAttachments.id, attachmentId),
          eq(taskAttachments.state, "draft"),
        )).run();
      }
      if (attachmentIds.length === 0) return [];
      return transaction.select().from(taskAttachments)
        .where(inArray(taskAttachments.id, attachmentIds)).all() as TaskAttachment[];
    }, { behavior: "immediate" });
  }

  async createMessage(message: TaskMessage, attachmentIds: string[] = []): Promise<TaskMessage> {
    if (attachmentIds.length > 4 || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new AttachmentClaimConflictError(attachmentIds[0] ?? "unknown");
    }
    return this.database.db.transaction((transaction) => {
      const claimedAt = this.now();
      const task = transaction.select({ projectId: tasks.projectId, status: tasks.status }).from(tasks)
        .where(eq(tasks.id, message.taskId)).get();
      if (!task) throw new NotFoundError("Task");
      if (task.status === "completed") throw new CompletedTaskReadOnlyError(message.taskId);
      if (task.projectId !== message.projectId) throw new PersistenceOwnershipError("Message");
      if (message.targetRole === "reviewer" && !message.sourceReviewRunId) {
        throw new PersistenceOwnershipError("Reviewer message target must reference a formal completed Review Run");
      }
      if (message.sourceReviewRunId) {
        const source = transaction.select({
          projectId: agentRuns.projectId,
          taskId: agentRuns.taskId,
          runType: agentRuns.runType,
          status: agentRuns.status,
        }).from(agentRuns).where(eq(agentRuns.id, message.sourceReviewRunId)).get();
        if (!source
          || source.projectId !== message.projectId
          || source.taskId !== message.taskId
          || source.runType !== "reviewer"
          || (message.targetRole === "reviewer" && source.status !== "completed")) {
          throw new PersistenceOwnershipError("Reviewer message target must reference a formal completed Review Run");
        }
      }
      transaction.insert(taskMessages).values(message).run();
      for (const attachmentId of attachmentIds) {
        const attachment = transaction.select().from(taskAttachments)
          .where(eq(taskAttachments.id, attachmentId)).get();
        if (!attachment
          || attachment.projectId !== message.projectId
          || attachment.state !== "draft"
          || attachmentExpired(attachment.expiresAt, claimedAt)) {
          throw new AttachmentClaimConflictError(attachmentId);
        }
        transaction.update(taskAttachments).set({
          taskId: message.taskId,
          messageId: message.id,
          state: "claimed",
          claimedAt,
        }).where(and(
          eq(taskAttachments.id, attachmentId),
          eq(taskAttachments.state, "draft"),
        )).run();
      }
      return message;
    }, { behavior: "immediate" });
  }

  async listMessages(taskId: string): Promise<TaskMessage[]> {
    return await this.database.db.select().from(taskMessages).where(eq(taskMessages.taskId, taskId))
      .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id)).all() as TaskMessage[];
  }

  async listMessagesInFifoOrder(taskId: string): Promise<TaskMessage[]> {
    return this.listMessages(taskId);
  }

  async listOpenDeliveryBatches(taskId: string): Promise<ConversationDeliveryBatch[]> {
    return await this.database.db.select().from(conversationDeliveryBatches).where(and(
      eq(conversationDeliveryBatches.taskId, taskId),
      eq(conversationDeliveryBatches.status, "open"),
    )).orderBy(
      asc(conversationDeliveryBatches.createdAt),
      asc(conversationDeliveryBatches.id),
    ).all() as ConversationDeliveryBatch[];
  }

  async listOpenConversationTaskIds(): Promise<string[]> {
    return (await this.database.db.selectDistinct({ taskId: conversationDeliveryBatches.taskId })
      .from(conversationDeliveryBatches)
      .where(eq(conversationDeliveryBatches.status, "open"))
      .orderBy(asc(conversationDeliveryBatches.taskId)).all()).map(({ taskId }) => taskId);
  }

  async reserveDeliveryBatch(input: ReserveDeliveryBatchInput): Promise<ConversationDeliveryBatch | null> {
    if (input.messageIds.length === 0 || new Set(input.messageIds).size !== input.messageIds.length) return null;
    return this.database.db.transaction((transaction) => {
      const existing = transaction.select().from(conversationDeliveryBatches)
        .where(eq(conversationDeliveryBatches.id, input.id)).get();
      if (existing) return existing.status === "open" ? existing as ConversationDeliveryBatch : null;
      const task = transaction.select({ projectId: tasks.projectId }).from(tasks)
        .where(eq(tasks.id, input.taskId)).get();
      if (!task || task.projectId !== input.projectId) throw new PersistenceOwnershipError("Conversation delivery batch");
      const selected = transaction.select().from(taskMessages).where(inArray(taskMessages.id, input.messageIds))
        .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id)).all() as TaskMessage[];
      if (selected.length !== input.messageIds.length
        || selected.some((message) => message.projectId !== input.projectId
          || message.taskId !== input.taskId
          || message.status !== "queued"
          || message.targetRole !== input.targetRole
          || message.sourceReviewRunId !== input.sourceReviewRunId)) return null;
      const orderedIds = selected.map((message) => message.id);
      if (orderedIds.some((id, index) => id !== input.messageIds[index])) return null;
      transaction.insert(conversationDeliveryBatches).values({ ...input, runId: null, status: "open" }).run();
      transaction.update(taskMessages).set({
        status: "delivering",
        updatedAt: input.updatedAt,
        deliveredAt: null,
        errorMessage: null,
      }).where(and(
        inArray(taskMessages.id, input.messageIds),
        eq(taskMessages.status, "queued"),
      )).run();
      return { ...input, runId: null };
    }, { behavior: "immediate" });
  }

  async settleDeliveryBatch(input: SettleDeliveryBatchInput): Promise<TaskMessage[]> {
    return this.database.db.transaction((transaction) => {
      const batch = transaction.select().from(conversationDeliveryBatches)
        .where(eq(conversationDeliveryBatches.id, input.batchId)).get();
      if (!batch) throw new NotFoundError("Conversation delivery batch");
      const messageIds = batch.messageIds as string[];
      if (batch.status === "open") {
        transaction.update(taskMessages).set({
          status: input.status,
          updatedAt: input.updatedAt,
          deliveredAt: input.deliveredAt,
          errorMessage: input.errorMessage,
        }).where(and(
          inArray(taskMessages.id, messageIds),
          eq(taskMessages.status, "delivering"),
        )).run();
        transaction.update(conversationDeliveryBatches).set({
          status: "settled",
          updatedAt: input.updatedAt,
        }).where(and(
          eq(conversationDeliveryBatches.id, input.batchId),
          eq(conversationDeliveryBatches.status, "open"),
        )).run();
      }
      const messages = transaction.select().from(taskMessages).where(inArray(taskMessages.id, messageIds))
        .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id)).all() as TaskMessage[];
      if (messages.length !== messageIds.length) throw new PersistenceOwnershipError("Conversation delivery batch messages");
      return messages;
    }, { behavior: "immediate" });
  }

  async transitionMessage(
    messageId: string,
    from: TaskMessage["status"],
    patch: Pick<TaskMessage, "status" | "updatedAt" | "deliveredAt" | "errorMessage">,
  ): Promise<TaskMessage | null> {
    return this.database.db.transaction((transaction) => {
      const current = transaction.select().from(taskMessages).where(eq(taskMessages.id, messageId)).get();
      if (!current || current.status !== from) return null;
      transaction.update(taskMessages).set(patch).where(and(
        eq(taskMessages.id, messageId),
        eq(taskMessages.status, from),
      )).run();
      return transaction.select().from(taskMessages).where(eq(taskMessages.id, messageId)).get() as TaskMessage;
    }, { behavior: "immediate" });
  }

  async attachmentPaths(messageIds: readonly string[]): Promise<string[]> {
    if (messageIds.length === 0) return [];
    return (await this.database.db.select().from(taskAttachments).where(and(
      inArray(taskAttachments.messageId, [...messageIds]),
      eq(taskAttachments.state, "claimed"),
    )).orderBy(asc(taskAttachments.createdAt), asc(taskAttachments.id)).all() as TaskAttachment[])
      .map((attachment) => attachment.storagePath);
  }

  async initialAttachmentPaths(taskId: string): Promise<string[]> {
    const rows = await this.database.db.select().from(taskAttachments).where(and(
      eq(taskAttachments.taskId, taskId),
      eq(taskAttachments.state, "claimed"),
    )).orderBy(asc(taskAttachments.createdAt), asc(taskAttachments.id)).all() as TaskAttachment[];
    return rows.filter((attachment) => attachment.messageId === null).map((attachment) => attachment.storagePath);
  }

  async discardIncompleteFormalFindings(runId: string): Promise<void> {
    await this.database.db.delete(reviewFindings).where(eq(reviewFindings.runId, runId)).run();
  }

  async createApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    return this.database.db.transaction((transaction) => {
      const run = transaction.select({ projectId: agentRuns.projectId, taskId: agentRuns.taskId, status: agentRuns.status })
        .from(agentRuns).where(eq(agentRuns.id, request.runId)).get();
      if (!run) throw new NotFoundError("Run");
      if (run.projectId !== request.projectId || run.taskId !== request.taskId) {
        throw new PersistenceOwnershipError("Approval request");
      }
      if (run.status !== "queued" && run.status !== "running") {
        throw new InactiveRunApprovalError(request.runId);
      }
      const existing = transaction.select().from(approvalRequests).where(and(
        eq(approvalRequests.runId, request.runId),
        eq(approvalRequests.providerRequestId, request.providerRequestId),
      )).get();
      if (existing) return existing as ApprovalRequest;
      transaction.insert(approvalRequests).values(request).run();
      return request;
    }, { behavior: "immediate" });
  }

  async reserveDecision(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string | null,
  ): Promise<ApprovalRequest> {
    return this.database.db.transaction((transaction) => {
      const existing = transaction.select().from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId)).get();
      if (!existing) throw new NotFoundError("Approval request");
      if (existing.status === "pending") {
        transaction.update(approvalRequests).set({
          status: "resolving",
          decision,
          reason,
        }).where(and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.status, "pending"),
        )).run();
      }
      return transaction.select().from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId)).get() as ApprovalRequest;
    }, { behavior: "immediate" });
  }

  async completeDecision(approvalId: string, resolvedAt: string): Promise<ApprovalRequest> {
    return this.database.db.transaction((transaction) => {
      const existing = transaction.select().from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId)).get();
      if (!existing) throw new NotFoundError("Approval request");
      if (existing.status === "resolving") {
        transaction.update(approvalRequests).set({ status: "resolved", resolvedAt }).where(and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.status, "resolving"),
        )).run();
      }
      return transaction.select().from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId)).get() as ApprovalRequest;
    }, { behavior: "immediate" });
  }

  async getApproval(approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.database.db.select().from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId)).get();
    if (!approval) throw new NotFoundError("Approval request");
    return approval as ApprovalRequest;
  }

  async providerForRun(runId: string): Promise<Provider> {
    const run = await this.database.db.select({ provider: agentRuns.provider }).from(agentRuns)
      .where(eq(agentRuns.id, runId)).get();
    if (!run) throw new NotFoundError("Run");
    return run.provider;
  }

  async expireApprovals(runId: string, expiredAt: string): Promise<ApprovalRequest[]> {
    return this.database.db.transaction((transaction) => {
      const pending = transaction.select({ id: approvalRequests.id }).from(approvalRequests).where(and(
        eq(approvalRequests.runId, runId),
        eq(approvalRequests.status, "pending"),
      )).all();
      if (pending.length === 0) return [];
      const ids = pending.map(({ id }) => id);
      transaction.update(approvalRequests).set({ status: "expired", resolvedAt: expiredAt }).where(inArray(
        approvalRequests.id,
        ids,
      )).run();
      return transaction.select().from(approvalRequests)
        .where(inArray(approvalRequests.id, ids)).orderBy(asc(approvalRequests.createdAt)).all() as ApprovalRequest[];
    }, { behavior: "immediate" });
  }

  async listPendingApprovals(taskId: string): Promise<ApprovalRequest[]> {
    return await this.database.db.select().from(approvalRequests).where(and(
      eq(approvalRequests.taskId, taskId),
      eq(approvalRequests.status, "pending"),
    )).orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id)).all() as ApprovalRequest[];
  }

  async listApprovals(taskId: string): Promise<ApprovalRequest[]> {
    return await this.database.db.select().from(approvalRequests)
      .where(eq(approvalRequests.taskId, taskId))
      .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id)).all() as ApprovalRequest[];
  }

  async findRunBySession(taskId: string, provider: Provider, externalSessionId: string): Promise<AgentRun | null> {
    return (await this.database.db.select().from(agentRuns).where(and(
      eq(agentRuns.taskId, taskId),
      eq(agentRuns.provider, provider),
      eq(agentRuns.externalSessionId, externalSessionId),
    )).orderBy(desc(sql`rowid`)).get() as AgentRun | undefined) ?? null;
  }

  async listUnfinishedTasks(): Promise<UnfinishedTaskSummary[]> {
    const rows = this.database.sqlite.query(`
      SELECT
        t.id,
        t.project_id AS projectId,
        p.name AS projectName,
        t.title,
        t.status,
        t.updated_at AS updatedAt,
        (
          SELECT ar.status FROM agent_runs ar
          WHERE ar.task_id = t.id
          ORDER BY ar.rowid DESC LIMIT 1
        ) AS latestRunStatus,
        (
          SELECT COUNT(*) FROM approval_requests approval
          WHERE approval.task_id = t.id AND approval.status IN ('pending', 'resolving')
        ) AS pendingApprovalCount,
        EXISTS (
          SELECT 1 FROM agent_runs active
          WHERE active.task_id = t.id AND active.status IN ('queued', 'running')
        ) AS hasActiveRun
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status <> 'completed'
    `).all() as Array<{
      id: string;
      projectId: string;
      projectName: string;
      title: string;
      status: TaskStatus;
      updatedAt: string;
      latestRunStatus: AgentRun["status"] | null;
      pendingApprovalCount: number;
      hasActiveRun: number;
    }>;
    const priority: Record<UnfinishedTaskSummary["attention"], number> = {
      pending_approval: 0,
      needs_attention: 1,
      running: 2,
      waiting_for_human: 3,
      ready_for_review: 4,
      pending_start: 5,
      other: 6,
    };
    return rows.map(({ hasActiveRun, ...row }) => ({
      ...row,
      attention: row.pendingApprovalCount > 0
        ? "pending_approval" as const
        : row.latestRunStatus && ["failed", "cancelled", "interrupted"].includes(row.latestRunStatus)
          ? "needs_attention" as const
          : hasActiveRun
            ? "running" as const
            : row.status === "waiting_for_human"
              ? "waiting_for_human" as const
              : row.status === "ready_for_review"
                ? "ready_for_review" as const
                : row.status === "draft"
                  ? "pending_start" as const
                  : "other" as const,
    })).sort((left, right) => (
      priority[left.attention] - priority[right.attention]
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id)
    ));
  }

  async reviewSnapshotHash(runId: string): Promise<string | null> {
    const row = await this.database.db.select({ snapshotHash: reviewRunSnapshots.snapshotHash })
      .from(reviewRunSnapshots).where(eq(reviewRunSnapshots.runId, runId)).get();
    if (row) return row.snapshotHash;

    const legacyRow = await this.database.db.select().from(agentEvents).where(and(
      eq(agentEvents.runId, runId),
      eq(agentEvents.eventType, "review_parsed"),
    )).orderBy(desc(agentEvents.sequence)).get();
    if (!legacyRow) return null;
    try {
      const event = rowEvent(legacyRow);
      if (!event.payload || typeof event.payload !== "object") return null;
      const snapshotHash = (event.payload as Record<string, unknown>).startSnapshotHash;
      return typeof snapshotHash === "string" && snapshotHash.length > 0 ? snapshotHash : null;
    } catch {
      return null;
    }
  }

  async replaceFindings(taskId: string, runId: string, findings: ReviewFinding[]): Promise<void> {
    this.database.db.transaction((transaction) => {
      transaction.delete(reviewFindings).where(and(
        eq(reviewFindings.taskId, taskId),
        eq(reviewFindings.runId, runId),
      )).run();
      if (findings.length > 0) transaction.insert(reviewFindings).values(findings).run();
      transaction.update(agentRuns).set({ reviewParseStatus: "succeeded" }).where(eq(agentRuns.id, runId)).run();
    }, { behavior: "immediate" });
  }

  async setParseStatus(run: AgentRun, status: "succeeded" | "failed"): Promise<AgentRun> {
    await this.database.db.update(agentRuns).set({ reviewParseStatus: status }).where(eq(agentRuns.id, run.id)).run();
    return { ...run, reviewParseStatus: status };
  }

  async reserve(candidate: FeedbackDelivery, leaseToken: string): Promise<ReserveFeedbackResult> {
    return this.database.db.transaction((transaction) => {
      const candidates = transaction.select().from(feedbackDeliveries).where(and(
        eq(feedbackDeliveries.taskId, candidate.taskId),
        eq(feedbackDeliveries.sourceReviewRunId, candidate.sourceReviewRunId),
      )).orderBy(desc(feedbackDeliveries.createdAt)).all() as FeedbackDelivery[];
      const existing = candidates.find((delivery) => (
        delivery.finalText === candidate.finalText
        && JSON.stringify(delivery.selectedFindingIds) === JSON.stringify(candidate.selectedFindingIds)
      ));
      const delivery = existing ?? candidate;
      if (!existing) transaction.insert(feedbackDeliveries).values(candidate).run();
      if (delivery.sentAt !== null || this.feedbackLeases.has(delivery.id)) return { delivery, allowStart: false };
      this.feedbackLeases.set(delivery.id, leaseToken);
      return { delivery, allowStart: true };
    }, { behavior: "immediate" });
  }

  async attachRun(deliveryId: string, runId: string, leaseToken: string): Promise<FeedbackDelivery> {
    this.assertLease(deliveryId, leaseToken);
    await this.database.db.update(feedbackDeliveries).set({ targetDeveloperRunId: runId })
      .where(eq(feedbackDeliveries.id, deliveryId)).run();
    return this.getDelivery(deliveryId);
  }

  async release(deliveryId: string, leaseToken: string): Promise<void> {
    this.assertLease(deliveryId, leaseToken);
    this.feedbackLeases.delete(deliveryId);
  }

  async markSent(deliveryId: string, leaseToken: string, sentAt: string): Promise<FeedbackDelivery> {
    this.assertLease(deliveryId, leaseToken);
    await this.database.db.update(feedbackDeliveries).set({ sentAt }).where(eq(feedbackDeliveries.id, deliveryId)).run();
    this.feedbackLeases.delete(deliveryId);
    return this.getDelivery(deliveryId);
  }

  private assertLease(deliveryId: string, leaseToken: string): void {
    if (this.feedbackLeases.get(deliveryId) !== leaseToken) throw new StaleFeedbackLeaseError();
  }

  private async getDelivery(deliveryId: string): Promise<FeedbackDelivery> {
    const delivery = await this.database.db.select().from(feedbackDeliveries).where(eq(feedbackDeliveries.id, deliveryId)).get();
    if (!delivery) throw new NotFoundError("Feedback delivery");
    return delivery as FeedbackDelivery;
  }

  async getFeedbackDraft(taskId: string, sourceReviewRunId: string): Promise<FeedbackDraft | null> {
    return (await this.database.db.select().from(feedbackDrafts).where(and(
      eq(feedbackDrafts.taskId, taskId),
      eq(feedbackDrafts.sourceReviewRunId, sourceReviewRunId),
    )).get() as FeedbackDraft | undefined) ?? null;
  }

  async saveFeedbackDraft(candidate: FeedbackDraft): Promise<FeedbackDraft> {
    return this.database.db.transaction((transaction) => {
      const task = transaction.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, candidate.taskId)).get();
      if (task?.status === "completed") throw new CompletedTaskReadOnlyError(candidate.taskId);
      const existing = transaction.select().from(feedbackDrafts).where(and(
        eq(feedbackDrafts.taskId, candidate.taskId),
        eq(feedbackDrafts.sourceReviewRunId, candidate.sourceReviewRunId),
      )).get();
      if (existing) {
        transaction.update(feedbackDrafts).set({
          finalText: candidate.finalText,
          updatedAt: candidate.updatedAt,
        }).where(eq(feedbackDrafts.sourceReviewRunId, candidate.sourceReviewRunId)).run();
      } else {
        transaction.insert(feedbackDrafts).values(candidate).run();
      }
      return transaction.select().from(feedbackDrafts)
        .where(eq(feedbackDrafts.sourceReviewRunId, candidate.sourceReviewRunId)).get() as FeedbackDraft;
    }, { behavior: "immediate" });
  }

  async getTask(taskId: string): Promise<Task | null> {
    return (await this.database.db.select().from(tasks).where(eq(tasks.id, taskId)).get() as Task | undefined) ?? null;
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    return (await this.database.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get() as AgentRun | undefined) ?? null;
  }

  async listRuns(taskId: string): Promise<AgentRun[]> {
    return await this.database.db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId))
      .orderBy(
        asc(sql`case when ${agentRuns.status} in ('queued', 'running') then 1 else 0 end`),
        asc(sql`coalesce(${agentRuns.finishedAt}, ${agentRuns.startedAt})`),
      ).all() as AgentRun[];
  }

  async listFindings(taskId: string): Promise<ReviewFinding[]> {
    return await this.database.db.select().from(reviewFindings).where(eq(reviewFindings.taskId, taskId))
      .orderBy(asc(reviewFindings.createdAt), asc(reviewFindings.id)).all() as ReviewFinding[];
  }

  async updateFinding(findingId: string, changes: Partial<Pick<ReviewFinding, "selected" | "dismissed" | "userNote">>): Promise<ReviewFinding | null> {
    return this.database.db.transaction((transaction) => {
      const finding = transaction.select().from(reviewFindings).where(eq(reviewFindings.id, findingId)).get();
      if (!finding) return null;
      const task = transaction.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, finding.taskId)).get();
      if (task?.status === "completed") throw new CompletedTaskReadOnlyError(finding.taskId);
      transaction.update(reviewFindings).set(changes).where(eq(reviewFindings.id, findingId)).run();
      return transaction.select().from(reviewFindings).where(eq(reviewFindings.id, findingId)).get() as ReviewFinding;
    }, { behavior: "immediate" });
  }

  async selectFindings(taskId: string, runId: string, mode: FindingSelectionMode): Promise<ReviewFinding[]> {
    return this.database.db.transaction((transaction) => {
      const task = transaction.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get();
      if (task?.status === "completed") throw new CompletedTaskReadOnlyError(taskId);
      const reviewScope = and(eq(reviewFindings.taskId, taskId), eq(reviewFindings.runId, runId));
      const findings = transaction.select().from(reviewFindings).where(reviewScope)
        .orderBy(asc(reviewFindings.createdAt), asc(reviewFindings.id)).all() as ReviewFinding[];
      for (const finding of findings) {
        const selected = mode === "all" || (mode === "P0" && finding.severity === "P0")
          || (mode === "P0_P1" && finding.severity !== "P2");
        transaction.update(reviewFindings).set({ selected }).where(eq(reviewFindings.id, finding.id)).run();
      }
      return transaction.select().from(reviewFindings).where(reviewScope)
        .orderBy(asc(reviewFindings.createdAt), asc(reviewFindings.id)).all() as ReviewFinding[];
    }, { behavior: "immediate" });
  }

  async recoverInterrupted(runIds?: string[]): Promise<AgentRun[]> {
    if (runIds?.length === 0) return [];
    const scope = runIds
      ? and(inArray(agentRuns.status, [...activeStatuses]), inArray(agentRuns.id, runIds))
      : inArray(agentRuns.status, [...activeStatuses]);
    const candidates = await this.database.db.select().from(agentRuns).where(scope).all() as AgentRun[];
    const recovered: AgentRun[] = [];
    for (const run of candidates) {
      const expectedLease = await this.database.db.select().from(runLeases)
        .where(eq(runLeases.runId, run.id)).get();
      if (run.processId) await stopProcessTreeByPid(run.processId);
      const task = await this.getTask(run.taskId);
      if (!task) continue;
      const hasDeveloperSession = Boolean(run.externalSessionId || task.developerSessionId);
      let workingTreeChanged = true;
      if (run.runType === "developer_initial" && !hasDeveloperSession) {
        try {
          workingTreeChanged = !(await this.git.status(task.workingDirectory)).clean;
        } catch {
          // Conservatively preserve a recoverable state when Git cannot be inspected.
        }
      }
      const target = taskStatusForRunFailure(run.runType, { hasDeveloperSession, workingTreeChanged });
      const finishedAt = this.now();
      const interrupted = this.database.db.transaction((transaction) => {
        this.assertApplicationOwner();
        const currentRun = transaction.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get();
        if (!currentRun || !activeStatuses.includes(currentRun.status as typeof activeStatuses[number])) return null;
        const currentLease = transaction.select().from(runLeases).where(eq(runLeases.runId, run.id)).get();
        if (currentLease?.ownerInstanceId !== expectedLease?.ownerInstanceId) return null;
        transaction.update(agentRuns).set({ status: "interrupted", processId: null, finishedAt })
          .where(and(
            eq(agentRuns.id, run.id),
            inArray(agentRuns.status, [...activeStatuses]),
          )).run();
        transaction.delete(runLeases).where(eq(runLeases.runId, run.id)).run();
        transaction.update(tasks).set({ status: target, updatedAt: finishedAt }).where(eq(tasks.id, run.taskId)).run();
        return { ...currentRun, status: "interrupted" as const, processId: null, finishedAt } as AgentRun;
      }, { behavior: "immediate" });
      if (interrupted) recovered.push(interrupted);
    }
    return recovered;
  }
}
