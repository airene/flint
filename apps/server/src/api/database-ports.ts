import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type {
  AgentEvent,
  AgentRun,
  AgentRunType,
  FeedbackDelivery,
  FindingSelectionMode,
  ReviewFinding,
  Task,
  TaskStatus,
} from "@local-pair-review/shared";
import type { AppDatabase } from "../db/database";
import {
  agentEvents,
  agentRuns,
  feedbackDeliveries,
  reviewFindings,
  reviewRunSnapshots,
  tasks,
} from "../db/schema";
import type { AgentRunPersistencePort, FinishRunInput, TaskRunStatePort } from "../services/agent-run.service";
import type { EventPersistencePort, PersistAgentEventInput } from "../services/event.service";
import { StaleFeedbackLeaseError, type FeedbackDeliveryPersistencePort, type ReserveFeedbackResult } from "../services/feedback.service";
import type { ReviewPersistencePort } from "../services/review.service";
import { GitService } from "../services/git.service";
import { CompletedTaskReadOnlyError, ProjectWriteRunConflictError } from "../services/task.service";
import { NotFoundError } from "./errors";
import {
  taskStatusForRunFailure,
  taskStatusForRunStart,
  taskStatusForRunSuccess,
} from "../services/task-run-state";

const activeStatuses = ["queued", "running"] as const;

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

export class DatabasePorts implements
  AgentRunPersistencePort,
  TaskRunStatePort,
  EventPersistencePort,
  ReviewPersistencePort,
  FeedbackDeliveryPersistencePort {
  private readonly feedbackLeases = new Map<string, string>();

  constructor(
    readonly database: AppDatabase,
    private readonly git = new GitService(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async queue(run: AgentRun, options: { snapshotHash?: string } = {}): Promise<AgentRun> {
    try {
      return this.database.db.transaction((transaction) => {
        const task = transaction.select().from(tasks).where(eq(tasks.id, run.taskId)).get() as Task | undefined;
        if (!task) throw new NotFoundError("Task");
        if (run.runType === "reviewer" && !options.snapshotHash) {
          throw new Error("Reviewer runs require a captured snapshot");
        }
        const target = taskStatusForRunStart(task.status, run.runType);
        const writerRun = run.runType === "developer_initial" || run.runType === "developer_feedback";
        const activeConflict = transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(
          eq(agentRuns.projectId, run.projectId),
          ...(writerRun ? [] : [inArray(agentRuns.runType, ["developer_initial", "developer_feedback"])]),
          inArray(agentRuns.status, [...activeStatuses]),
        )).get();
        if (activeConflict) throw new ProjectWriteRunConflictError(run.projectId);
        transaction.insert(agentRuns).values(run).run();
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
    await this.database.db.update(agentRuns).set({ status: "running", processId, startedAt: this.now() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued"))).run();
  }

  async recordSession(runId: string, taskId: string, runType: AgentRunType, sessionId: string): Promise<void> {
    this.database.db.transaction((transaction) => {
      transaction.update(agentRuns).set({ externalSessionId: sessionId }).where(eq(agentRuns.id, runId)).run();
      transaction.update(tasks).set({
        ...(runType === "reviewer" ? { reviewerSessionId: sessionId } : { developerSessionId: sessionId }),
        updatedAt: this.now(),
      }).where(eq(tasks.id, taskId)).run();
    }, { behavior: "immediate" });
  }

  async succeed(input: FinishRunInput & { taskId: string; runType: AgentRunType }): Promise<AgentRun> {
    return this.finish(input, taskStatusForRunSuccess(input.runType));
  }

  async fail(input: FinishRunInput & { taskId: string; runType: AgentRunType; sessionId: string | null }): Promise<AgentRun> {
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

  private finish(input: FinishRunInput & { taskId: string }, taskStatus: TaskStatus): AgentRun {
    return this.database.db.transaction((transaction) => {
      transaction.update(agentRuns).set({ ...input.patch, processId: null }).where(eq(agentRuns.id, input.runId)).run();
      transaction.update(tasks).set({ status: taskStatus, updatedAt: this.now() }).where(eq(tasks.id, input.taskId)).run();
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
      transaction.delete(reviewFindings).where(eq(reviewFindings.taskId, taskId)).run();
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

  async hasActiveProjectRun(projectId: string): Promise<boolean> {
    return Boolean(await this.database.db.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.projectId, projectId),
      inArray(agentRuns.status, [...activeStatuses]),
    )).get());
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

  async selectFindings(taskId: string, mode: FindingSelectionMode): Promise<ReviewFinding[]> {
    return this.database.db.transaction((transaction) => {
      const task = transaction.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get();
      if (task?.status === "completed") throw new CompletedTaskReadOnlyError(taskId);
      const findings = transaction.select().from(reviewFindings).where(eq(reviewFindings.taskId, taskId))
        .orderBy(asc(reviewFindings.createdAt), asc(reviewFindings.id)).all() as ReviewFinding[];
      for (const finding of findings) {
        const selected = mode === "all" || (mode === "P0" && finding.severity === "P0")
          || (mode === "P0_P1" && finding.severity !== "P2");
        transaction.update(reviewFindings).set({ selected }).where(eq(reviewFindings.id, finding.id)).run();
      }
      return transaction.select().from(reviewFindings).where(eq(reviewFindings.taskId, taskId))
        .orderBy(asc(reviewFindings.createdAt), asc(reviewFindings.id)).all() as ReviewFinding[];
    }, { behavior: "immediate" });
  }

  async recoverInterrupted(runIds?: string[]): Promise<AgentRun[]> {
    const all = await this.database.db.select().from(agentRuns).all() as AgentRun[];
    const candidates = all.filter((run) => runIds
      ? runIds.includes(run.id) && ["queued", "running", "cancelled"].includes(run.status)
      : activeStatuses.includes(run.status as typeof activeStatuses[number]));
    const recovered: AgentRun[] = [];
    for (const run of candidates) {
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
        transaction.update(agentRuns).set({ status: "interrupted", processId: null, finishedAt })
          .where(eq(agentRuns.id, run.id)).run();
        transaction.update(tasks).set({ status: target, updatedAt: finishedAt }).where(eq(tasks.id, run.taskId)).run();
        return { ...run, status: "interrupted" as const, processId: null, finishedAt };
      }, { behavior: "immediate" });
      recovered.push(interrupted);
    }
    return recovered;
  }
}
