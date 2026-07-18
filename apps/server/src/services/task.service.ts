import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { AgentRunType, Task, TaskStatus } from "@local-pair-review/shared";
import type { AppDatabase } from "../db/database";
import { agentRuns, projects, tasks } from "../db/schema";
import { GitService } from "./git.service";

export class DirtyWorkingTreeError extends Error {
  constructor(readonly files: string[]) {
    super("The working tree has uncommitted changes; explicit confirmation is required");
    this.name = "DirtyWorkingTreeError";
  }
}

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Cannot transition task from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

export class TaskTransitionConflictError extends Error {
  constructor(readonly taskId: string, readonly expectedStatus: TaskStatus) {
    super("Task status changed concurrently");
    this.name = "TaskTransitionConflictError";
  }
}

export class ProjectWriteRunConflictError extends Error {
  constructor(readonly projectId: string) {
    super("This project already has an active developer run");
    this.name = "ProjectWriteRunConflictError";
  }
}

export interface CreateTaskInput {
  title: string;
  originalPrompt: string;
  confirmDirtyWorkingTree?: boolean;
}

export interface FallbackContext {
  hasSessionId?: boolean;
  workingTreeChanged?: boolean;
  reviewParseFailed?: boolean;
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["developing"],
  developing: ["ready_for_review"],
  ready_for_review: ["reviewing", "fixing"],
  reviewing: ["waiting_for_human"],
  waiting_for_human: ["fixing", "reviewing", "completed"],
  fixing: ["ready_for_review"],
  completed: [],
};

function now(): string { return new Date().toISOString(); }

export class TaskService {
  constructor(private readonly database: AppDatabase, private readonly git = new GitService()) {}

  async create(projectId: string, input: CreateTaskInput): Promise<Task> {
    const project = await this.database.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Error("Project not found");
    let baseCommit: string;
    try {
      baseCommit = await this.git.head(project.rootPath);
    } catch {
      throw new Error("A task requires a Git repository with an initial commit");
    }
    const status = await this.git.status(project.rootPath);
    if (!status.clean && !input.confirmDirtyWorkingTree) throw new DirtyWorkingTreeError(status.files.map((file) => file.path));
    const timestamp = now();
    const task: Task = {
      id: randomUUID(), projectId, title: input.title, originalPrompt: input.originalPrompt,
      workingDirectory: project.rootPath, baseCommit, latestSnapshotHash: null, status: "draft",
      developerSessionId: null, reviewerSessionId: null, createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    };
    await this.database.db.insert(tasks).values(task).run();
    return task;
  }

  async get(taskId: string): Promise<Task | null> {
    return (await this.database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()) ?? null;
  }

  async list(projectId: string): Promise<Task[]> {
    return this.database.db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(tasks.createdAt).all();
  }

  async update(taskId: string, changes: Pick<Partial<Task>, "title" | "originalPrompt">): Promise<Task | null> {
    if (Object.keys(changes).length > 0) await this.database.db.update(tasks).set({ ...changes, updatedAt: now() }).where(eq(tasks.id, taskId)).run();
    return this.get(taskId);
  }

  async transition(taskId: string, target: TaskStatus): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new Error("Task not found");
    if (!transitions[task.status].includes(target)) throw new InvalidTaskTransitionError(task.status, target);
    const completedAt = target === "completed" ? now() : null;
    const updated = await this.database.db.update(tasks).set({ status: target, updatedAt: now(), completedAt }).where(and(
      eq(tasks.id, taskId),
      eq(tasks.status, task.status),
    )).returning({ id: tasks.id }).get();
    if (!updated) throw new TaskTransitionConflictError(taskId, task.status);
    return (await this.get(taskId))!;
  }

  async complete(taskId: string): Promise<Task> {
    return this.transition(taskId, "completed");
  }

  async fallbackAfterRun(taskId: string, runType: AgentRunType, context: FallbackContext = {}): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new Error("Task not found");
    let status: TaskStatus;
    if (runType === "developer_initial") {
      const changed = context.workingTreeChanged ?? !(await this.git.status(task.workingDirectory)).clean;
      status = context.hasSessionId || Boolean(task.developerSessionId) || changed ? "ready_for_review" : "draft";
    } else if (runType === "reviewer" && context.reviewParseFailed) {
      status = "waiting_for_human";
    } else if (runType === "developer_feedback" || runType === "reviewer") {
      status = "ready_for_review";
    } else {
      status = task.status;
    }
    await this.database.db.update(tasks).set({ status, updatedAt: now() }).where(eq(tasks.id, taskId)).run();
    return (await this.get(taskId))!;
  }

  async hasActiveProjectWriteRun(projectId: string): Promise<boolean> {
    return Boolean(await this.database.db.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.projectId, projectId),
      inArray(agentRuns.runType, ["developer_initial", "developer_feedback"]),
      inArray(agentRuns.status, ["queued", "running"]),
    )).get());
  }

  async assertNoActiveProjectWriteRun(projectId: string): Promise<void> {
    if (await this.hasActiveProjectWriteRun(projectId)) throw new ProjectWriteRunConflictError(projectId);
  }
}
