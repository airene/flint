import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type {
  AgentEvent,
  AgentRun,
  AgentRunType,
  FeedbackDelivery,
  FindingSelectionMode,
  Provider,
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
  tasks,
} from "../db/schema";
import type { AgentRunPersistencePort, FinishRunInput, TaskRunStatePort } from "../services/agent-run.service";
import type { EventPersistencePort, PersistAgentEventInput } from "../services/event.service";
import type { FeedbackDeliveryPersistencePort, ReserveFeedbackResult } from "../services/feedback.service";
import type { ReviewPersistencePort } from "../services/review.service";
import { GitService } from "../services/git.service";
import { CompletedTaskReadOnlyError, InvalidTaskTransitionError, ProjectWriteRunConflictError } from "../services/task.service";

const activeStatuses = ["queued", "running"] as const;

function taskStartStatus(task: Task, runType: AgentRunType): TaskStatus {
  if (runType === "developer_initial") {
    if (task.status !== "draft") throw new InvalidTaskTransitionError(task.status, "developing");
    return "developing";
  }
  if (runType === "developer_feedback") {
    if (task.status !== "waiting_for_human" && task.status !== "ready_for_review") {
      throw new InvalidTaskTransitionError(task.status, "fixing");
    }
    return "fixing";
  }
  if (task.status !== "ready_for_review" && task.status !== "waiting_for_human") {
    throw new InvalidTaskTransitionError(task.status, "reviewing");
  }
  return "reviewing";
}

function successStatus(runType: AgentRunType): TaskStatus {
  return runType === "reviewer" ? "waiting_for_human" : "ready_for_review";
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

  async queue(run: AgentRun): Promise<AgentRun> {
    try {
      return this.database.db.transaction((transaction) => {
        const task = transaction.select().from(tasks).where(eq(tasks.id, run.taskId)).get() as Task | undefined;
        if (!task) throw new Error("Task not found");
        const target = taskStartStatus(task, run.runType);
        const activeWrite = transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(
          eq(agentRuns.projectId, run.projectId),
          inArray(agentRuns.runType, ["developer_initial", "developer_feedback"]),
          inArray(agentRuns.status, [...activeStatuses]),
        )).get();
        if (activeWrite) throw new ProjectWriteRunConflictError(run.projectId);
        transaction.insert(agentRuns).values(run).run();
        transaction.update(tasks).set({ status: target, updatedAt: this.now() }).where(eq(tasks.id, task.id)).run();
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

  async recordSession(runId: string, taskId: string, provider: Provider, sessionId: string): Promise<void> {
    this.database.db.transaction((transaction) => {
      transaction.update(agentRuns).set({ externalSessionId: sessionId }).where(eq(agentRuns.id, runId)).run();
      transaction.update(tasks).set({
        ...(provider === "codex" ? { developerSessionId: sessionId } : { reviewerSessionId: sessionId }),
        updatedAt: this.now(),
      }).where(eq(tasks.id, taskId)).run();
    }, { behavior: "immediate" });
  }

  async succeed(input: FinishRunInput & { taskId: string; runType: AgentRunType }): Promise<AgentRun> {
    return this.finish(input, successStatus(input.runType));
  }

  async fail(input: FinishRunInput & { taskId: string; runType: AgentRunType; sessionId: string | null }): Promise<AgentRun> {
    const task = await this.getTask(input.taskId);
    if (!task) throw new Error("Task not found");
    let target: TaskStatus;
    if (input.runType === "developer_initial") {
      const changed = !(await this.git.status(task.workingDirectory)).clean;
      target = input.sessionId || task.developerSessionId || changed ? "ready_for_review" : "draft";
    } else {
      target = "ready_for_review";
    }
    return this.finish(input, target);
  }

  private finish(input: FinishRunInput & { taskId: string }, taskStatus: TaskStatus): AgentRun {
    return this.database.db.transaction((transaction) => {
      transaction.update(agentRuns).set({ ...input.patch, processId: null }).where(eq(agentRuns.id, input.runId)).run();
      transaction.update(tasks).set({ status: taskStatus, updatedAt: this.now() }).where(eq(tasks.id, input.taskId)).run();
      const run = transaction.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).get();
      if (!run) throw new Error("Run not found");
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

  async recordSnapshot(taskId: string, snapshotHash: string): Promise<void> {
    await this.database.db.update(tasks).set({ latestSnapshotHash: snapshotHash, updatedAt: this.now() })
      .where(eq(tasks.id, taskId)).run();
  }

  async replaceFindings(taskId: string, runId: string, findings: ReviewFinding[]): Promise<void> {
    this.database.db.transaction((transaction) => {
      transaction.delete(reviewFindings).where(eq(reviewFindings.taskId, taskId)).run();
      if (findings.length > 0) transaction.insert(reviewFindings).values(findings).run();
      transaction.update(agentRuns).set({ reviewParseStatus: "succeeded" }).where(eq(agentRuns.id, runId)).run();
    }, { behavior: "immediate" });
  }

  async setParseStatus(run: AgentRun, status: "succeeded" | "failed"): Promise<AgentRun> {
    this.database.db.transaction((transaction) => {
      transaction.update(agentRuns).set({ reviewParseStatus: status }).where(eq(agentRuns.id, run.id)).run();
      if (status === "failed") transaction.delete(reviewFindings).where(eq(reviewFindings.taskId, run.taskId)).run();
    }, { behavior: "immediate" });
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
    if (this.feedbackLeases.get(deliveryId) !== leaseToken) throw new Error("stale feedback lease");
  }

  private async getDelivery(deliveryId: string): Promise<FeedbackDelivery> {
    const delivery = await this.database.db.select().from(feedbackDeliveries).where(eq(feedbackDeliveries.id, deliveryId)).get();
    if (!delivery) throw new Error("Feedback delivery not found");
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
      .orderBy(asc(agentRuns.startedAt), asc(agentRuns.finishedAt)).all() as AgentRun[];
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
      let target: TaskStatus = "ready_for_review";
      if (run.runType === "developer_initial") {
        if (run.externalSessionId || task.developerSessionId) {
          target = "ready_for_review";
        } else {
          try {
            target = (await this.git.status(task.workingDirectory)).clean ? "draft" : "ready_for_review";
          } catch {
            target = "ready_for_review";
          }
        }
      }
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
