import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AgentRoleSettings, Task, TaskStatus } from "@local-pair-review/shared";
import type { AppDatabase } from "../db/database";
import { projects, tasks } from "../db/schema";
import { GitCliExecutionError, GitService } from "./git.service";
import { assertTaskTransition } from "./task-run-state";

export { InvalidTaskTransitionError } from "./task-run-state";

export class DirtyWorkingTreeError extends Error {
  constructor(readonly files: string[]) {
    super("The working tree has uncommitted changes; explicit confirmation is required");
    this.name = "DirtyWorkingTreeError";
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
    super("This project has an active run that conflicts with development or review");
    this.name = "ProjectWriteRunConflictError";
  }
}

export class CompletedTaskReadOnlyError extends Error {
  constructor(readonly taskId: string) {
    super("Completed task history is read-only");
    this.name = "CompletedTaskReadOnlyError";
  }
}

export interface CreateTaskInput {
  title: string;
  originalPrompt: string;
  confirmDirtyWorkingTree?: boolean;
}

export interface AgentRoleSettingsReader {
  loadAgentRoles(): AgentRoleSettings;
}

const legacyAgentRoleSettings: AgentRoleSettings = {
  developerProvider: "codex",
  reviewerProvider: "claude",
};

function now(): string { return new Date().toISOString(); }

export class TaskService {
  constructor(
    private readonly database: AppDatabase,
    private readonly git = new GitService(),
    private readonly roleSettings: AgentRoleSettingsReader = { loadAgentRoles: () => legacyAgentRoleSettings },
  ) {}

  async create(projectId: string, input: CreateTaskInput): Promise<Task> {
    const project = await this.database.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Error("Project not found");
    let baseCommit: string;
    try {
      baseCommit = await this.git.head(project.rootPath);
    } catch (error) {
      if (error instanceof GitCliExecutionError) throw error;
      throw new Error("A task requires a Git repository with an initial commit");
    }
    const status = await this.git.status(project.rootPath);
    if (!status.clean && !input.confirmDirtyWorkingTree) throw new DirtyWorkingTreeError(status.files.map((file) => file.path));
    const timestamp = now();
    const roles = this.roleSettings.loadAgentRoles();
    const task: Task = {
      id: randomUUID(), projectId, title: input.title, originalPrompt: input.originalPrompt,
      workingDirectory: project.rootPath, baseCommit, latestSnapshotHash: null, status: "draft",
      developerProvider: roles.developerProvider, reviewerProvider: roles.reviewerProvider,
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
    const task = await this.get(taskId);
    if (!task) return null;
    if (task.status === "completed") throw new CompletedTaskReadOnlyError(taskId);
    if (Object.keys(changes).length === 0) return task;
    await this.database.db.update(tasks).set({ ...changes, updatedAt: now() }).where(eq(tasks.id, taskId)).run();
    return this.get(taskId);
  }

  async transition(taskId: string, target: TaskStatus): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) throw new Error("Task not found");
    assertTaskTransition(task.status, target);
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

}
