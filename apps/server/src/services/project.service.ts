import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { count, eq } from "drizzle-orm";
import type { Project } from "@local-pair-review/shared";
import { projects, tasks } from "../db/schema";
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

export interface ProjectRemovalInfo {
  projectId: string;
  taskCount: number;
  requiresConfirmation: boolean;
}

function now(): string { return new Date().toISOString(); }

export class ProjectService {
  constructor(private readonly database: AppDatabase) {}

  async add(path: string): Promise<Project> {
    const rootPath = await canonicalGitRoot(path);
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
    const info = await this.removalInfo(projectId);
    if (info.requiresConfirmation && !confirmed) throw new ConfirmationRequiredError(info);
    await this.database.db.delete(projects).where(eq(projects.id, projectId)).run();
  }
}
