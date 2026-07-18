import type {
  CreateProjectRequest,
  CreateTaskRequest,
  Project,
  Task,
  UpdateProjectRequest,
  UpdateTaskRequest,
} from "@local-pair-review/shared";
import { defineStore } from "pinia";
import { ApiClientError } from "../api/client";
import { apiEndpoints } from "../api/endpoints";

export interface PendingDirtyTask {
  projectId: string;
  input: Omit<CreateTaskRequest, "confirmDirtyWorkingTree">;
  files: string[];
}

function clientError(error: unknown): ApiClientError {
  return error instanceof ApiClientError
    ? error
    : new ApiClientError(0, "INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected client error.");
}

function dirtyWorkingTreeFiles(error: ApiClientError): string[] | null {
  if (error.status !== 409 || error.code !== "CONFLICT" || !error.details || typeof error.details !== "object") return null;
  const files = (error.details as { files?: unknown }).files;
  return Array.isArray(files) && files.every((file) => typeof file === "string") ? files : null;
}

function withoutDirtyConfirmation(input: CreateTaskRequest): Omit<CreateTaskRequest, "confirmDirtyWorkingTree"> {
  const { confirmDirtyWorkingTree: _confirmation, ...draft } = input;
  return draft;
}

function upsert<T extends { id: string }>(values: T[], value: T): void {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) values.push(value);
  else values.splice(index, 1, value);
}

export const useProjectsStore = defineStore("projects", {
  state: () => ({
    projects: [] as Project[],
    currentProject: null as Project | null,
    tasks: [] as Task[],
    unfinishedTasks: [] as Task[],
    unfinishedLoading: false,
    loading: false,
    error: null as ApiClientError | null,
    pendingDirtyTask: null as PendingDirtyTask | null,
    selectionGeneration: 0,
  }),
  getters: {
    currentProjectId: (state): string | null => state.currentProject?.id ?? null,
    dirtyWorkingTreeFiles: (state): string[] => state.pendingDirtyTask?.files ?? [],
  },
  actions: {
    clearError(): void {
      this.error = null;
    },
    async loadProjects(): Promise<Project[]> {
      this.loading = true;
      this.error = null;
      try {
        this.projects = await apiEndpoints.listProjects();
        if (this.currentProject) {
          this.currentProject = this.projects.find((project) => project.id === this.currentProject?.id) ?? null;
          if (!this.currentProject) this.tasks = [];
        }
        return this.projects;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      } finally {
        this.loading = false;
      }
    },
    async selectProject(projectId: string): Promise<Project> {
      const selectionGeneration = ++this.selectionGeneration;
      this.loading = true;
      this.error = null;
      this.pendingDirtyTask = null;
      this.currentProject = null;
      this.tasks = [];
      try {
        const [project, tasks] = await Promise.all([
          apiEndpoints.getProject(projectId),
          apiEndpoints.listTasks(projectId),
        ]);
        if (selectionGeneration === this.selectionGeneration) {
          this.currentProject = project;
          this.tasks = tasks;
          upsert(this.projects, project);
        }
        return project;
      } catch (error) {
        const failure = clientError(error);
        if (selectionGeneration === this.selectionGeneration) this.error = failure;
        throw failure;
      } finally {
        if (selectionGeneration === this.selectionGeneration) this.loading = false;
      }
    },
    async createProject(input: CreateProjectRequest): Promise<Project> {
      this.loading = true;
      this.error = null;
      try {
        const project = await apiEndpoints.createProject(input);
        upsert(this.projects, project);
        this.currentProject = project;
        this.tasks = [];
        return project;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      } finally {
        this.loading = false;
      }
    },
    async updateProject(projectId: string, input: UpdateProjectRequest): Promise<Project> {
      this.error = null;
      try {
        const project = await apiEndpoints.updateProject(projectId, input);
        upsert(this.projects, project);
        if (this.currentProject?.id === project.id) this.currentProject = project;
        return project;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      }
    },
    async deleteProject(projectId: string, confirm = false): Promise<void> {
      this.error = null;
      try {
        await apiEndpoints.deleteProject(projectId, { confirm });
        this.projects = this.projects.filter((project) => project.id !== projectId);
        if (this.currentProject?.id === projectId) {
          this.currentProject = null;
          this.tasks = [];
        }
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      }
    },
    syncTask(task: Task): void {
      // Reflect the currently-open task's live status into the sidebar list immediately,
      // instead of waiting for the next navigation-triggered refetch.
      const others = this.unfinishedTasks.filter((candidate) => candidate.id !== task.id);
      this.unfinishedTasks = (task.status === "completed" ? others : [...others, task])
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async loadUnfinishedTasks(): Promise<Task[]> {
      this.unfinishedLoading = true;
      try {
        const projects = this.projects.length ? this.projects : await this.loadProjects();
        const perProject = await Promise.all(
          projects.map((project) => apiEndpoints.listTasks(project.id).catch(() => [] as Task[])),
        );
        this.unfinishedTasks = perProject
          .flat()
          .filter((task) => task.status !== "completed")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return this.unfinishedTasks;
      } finally {
        this.unfinishedLoading = false;
      }
    },
    async loadTasks(projectId?: string): Promise<Task[]> {
      const selectedProjectId = projectId ?? this.currentProject?.id;
      if (!selectedProjectId) {
        this.tasks = [];
        return this.tasks;
      }
      this.loading = true;
      this.error = null;
      try {
        const tasks = await apiEndpoints.listTasks(selectedProjectId);
        if (this.currentProject?.id === selectedProjectId) this.tasks = tasks;
        return tasks;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      } finally {
        this.loading = false;
      }
    },
    async loadTask(taskId: string): Promise<Task> {
      this.error = null;
      try {
        const task = await apiEndpoints.getTask(taskId);
        if (this.currentProject?.id === task.projectId) upsert(this.tasks, task);
        return task;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      }
    },
    async createTask(projectId: string, input: CreateTaskRequest): Promise<Task> {
      const selectionGeneration = this.selectionGeneration;
      this.error = null;
      this.pendingDirtyTask = null;
      try {
        const task = await apiEndpoints.createTask(projectId, input);
        if (selectionGeneration === this.selectionGeneration && this.currentProject?.id === projectId) upsert(this.tasks, task);
        return task;
      } catch (error) {
        const failure = clientError(error);
        if (selectionGeneration === this.selectionGeneration && this.currentProject?.id === projectId) {
          this.error = failure;
          const files = dirtyWorkingTreeFiles(failure);
          if (files) {
            this.pendingDirtyTask = {
              projectId,
              input: withoutDirtyConfirmation(input),
              files,
            };
          }
        }
        throw failure;
      }
    },
    async retryCreateTaskWithDirtyWorkingTreeConfirmation(expectedProjectId?: string): Promise<Task | null> {
      const pending = this.pendingDirtyTask;
      if (!pending || (expectedProjectId && pending.projectId !== expectedProjectId)
        || this.currentProject?.id !== pending.projectId) return null;
      return this.createTask(pending.projectId, {
        ...pending.input,
        confirmDirtyWorkingTree: true,
      });
    },
    async updateTask(taskId: string, input: UpdateTaskRequest): Promise<Task> {
      this.error = null;
      try {
        const task = await apiEndpoints.updateTask(taskId, input);
        upsert(this.tasks, task);
        return task;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      }
    },
    async completeTask(taskId: string): Promise<Task> {
      this.error = null;
      try {
        const task = await apiEndpoints.completeTask(taskId);
        upsert(this.tasks, task);
        return task;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      }
    },
  },
});
