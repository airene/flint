import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Project } from "@local-pair-review/shared";
import { agentRuns, projects, tasks } from "../db/schema";
import type { AppDatabase } from "../db/database";
import { canonicalGitRoot } from "../utils/path";

export class DuplicateProjectError extends Error {
  constructor(readonly rootPath: string) {
    super("This Git repository is already registered");
    this.name = "DuplicateProjectError";
  }
}

export class ConfirmationRequiredError extends Error {
  constructor(readonly data: ProjectRemovalInfo) {
    super("Deleting this project also deletes its historical application data; confirmation is required");
    this.name = "ConfirmationRequiredError";
  }
}

export class ActiveProjectRunError extends Error {
  constructor(readonly projectId: string) {
    super("Cannot delete a project with an active run.");
    this.name = "ActiveProjectRunError";
  }
}

export interface ProjectRemovalInfo {
  projectId: string;
  taskCount: number;
  requiresConfirmation: boolean;
}

function now(): string { return new Date().toISOString(); }

export class ProjectService {
  constructor(private readonly database: AppDatabase, private readonly gitExecutable = "git") {}

  async add(path: string): Promise<Project> {
    const rootPath = await canonicalGitRoot(path, this.gitExecutable);
    const existing = await this.database.db.select().from(projects).where(eq(projects.rootPath, rootPath)).get();
    if (existing) throw new DuplicateProjectError(rootPath);
    const timestamp = now();
    const project: Project = {
      id: randomUUID(), name: basename(rootPath), rootPath, defaultDeveloper: "codex", defaultReviewer: "claude",
      createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null,
    };
    try {
      await this.database.db.insert(projects).values(project).run();
    } catch (cause) {
      // The database unique constraint remains authoritative for concurrent registration.
      if (String(cause).includes("projects.root_path")) throw new DuplicateProjectError(rootPath);
      throw cause;
    }
    return project;
  }

  async list(): Promise<Project[]> {
    return this.database.db.select().from(projects).orderBy(projects.name).all();
  }

  async get(projectId: string): Promise<Project | null> {
    return (await this.database.db.select().from(projects).where(eq(projects.id, projectId)).get()) ?? null;
  }

  async update(projectId: string, changes: Pick<Partial<Project>, "name" | "lastOpenedAt">): Promise<Project | null> {
    if (Object.keys(changes).length === 0) return this.get(projectId);
    await this.database.db.update(projects).set({ ...changes, updatedAt: now() }).where(eq(projects.id, projectId)).run();
    return this.get(projectId);
  }

  async removalInfo(projectId: string): Promise<ProjectRemovalInfo> {
    const project = await this.get(projectId);
    if (!project) throw new Error("Project not found");
    const result = await this.database.db.select({ value: count() }).from(tasks).where(eq(tasks.projectId, projectId)).get();
    const taskCount = result?.value ?? 0;
    return { projectId, taskCount, requiresConfirmation: taskCount > 0 };
  }

  async remove(projectId: string, confirmed = false): Promise<void> {
    this.database.db.transaction((transaction) => {
      const project = transaction.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new Error("Project not found");
      const activeRun = transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(
        eq(agentRuns.projectId, projectId),
        inArray(agentRuns.status, ["queued", "running"]),
      )).get();
      if (activeRun) throw new ActiveProjectRunError(projectId);
      const result = transaction.select({ value: count() }).from(tasks).where(eq(tasks.projectId, projectId)).get();
      const taskCount = result?.value ?? 0;
      const info = { projectId, taskCount, requiresConfirmation: taskCount > 0 };
      if (info.requiresConfirmation && !confirmed) throw new ConfirmationRequiredError(info);
      transaction.delete(projects).where(eq(projects.id, projectId)).run();
    }, { behavior: "immediate" });
  }
}
