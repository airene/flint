import {
  cancelRunResponseSchema,
  cliRecheckResponseSchema,
  cliStatusResponseSchema,
  completeTaskResponseSchema,
  createProjectResponseSchema,
  createTaskResponseSchema,
  deleteProjectResponseSchema,
  developTaskResponseSchema,
  feedbackPreviewResponseSchema,
  feedbackDraftResponseSchema,
  feedbackTaskResponseSchema,
  findingResponseSchema,
  findingsResponseSchema,
  gitDiffResponseSchema,
  gitFileDiffResponseSchema,
  gitFilesResponseSchema,
  gitStatusResponseSchema,
  healthResponseSchema,
  projectListResponseSchema,
  projectFilesResponseSchema,
  projectResponseSchema,
  reviewTaskResponseSchema,
  runListResponseSchema,
  runResponseSchema,
  selectFindingsResponseSchema,
  saveFeedbackDraftResponseSchema,
  settingsResponseSchema,
  taskListResponseSchema,
  taskResponseSchema,
  type CancelRunResponse,
  type CliRecheckResponse,
  type CliRecheckRequest,
  type CliStatusResponse,
  type CompleteTaskResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type DeleteProjectRequest,
  type DeleteProjectResponse,
  type DevelopTaskRequest,
  type DevelopTaskResponse,
  type FeedbackPreviewRequest,
  type FeedbackPreviewResponse,
  type FeedbackDraftResponse,
  type FeedbackTaskRequest,
  type FeedbackTaskResponse,
  type FindingResponse,
  type FindingsResponse,
  type GitDiffResponse,
  type GitFileDiffResponse,
  type GitFilesResponse,
  type GitStatusResponse,
  type HealthResponse,
  type ProjectListResponse,
  type ProjectFilesRequest,
  type ProjectFilesResponse,
  type ProjectResponse,
  type ReviewTaskResponse,
  type RunListResponse,
  type RunResponse,
  type SelectFindingsRequest,
  type SelectFindingsResponse,
  type SaveFeedbackDraftRequest,
  type SaveFeedbackDraftResponse,
  type SettingsResponse,
  type TaskListResponse,
  type TaskResponse,
  type UpdateFindingRequest,
  type UpdateProjectRequest,
  type UpdateTaskRequest,
} from "@local-pair-review/shared";
import { apiClient, type ApiClient } from "./client";

function id(value: string): string {
  return encodeURIComponent(value);
}

export interface ApiEndpoints {
  health(): Promise<HealthResponse>;
  getCliStatus(): Promise<CliStatusResponse>;
  recheckClis(input?: CliRecheckRequest): Promise<CliRecheckResponse>;
  getSettings(): Promise<SettingsResponse>;
  updateSettings(input?: CliRecheckRequest): Promise<SettingsResponse>;
  listProjects(): Promise<ProjectListResponse>;
  createProject(input: CreateProjectRequest): Promise<CreateProjectResponse>;
  getProject(projectId: string): Promise<ProjectResponse>;
  listProjectFiles(projectId: string, input?: ProjectFilesRequest, signal?: AbortSignal): Promise<ProjectFilesResponse>;
  updateProject(projectId: string, input: UpdateProjectRequest): Promise<ProjectResponse>;
  deleteProject(projectId: string, input: DeleteProjectRequest): Promise<DeleteProjectResponse>;
  listTasks(projectId: string): Promise<TaskListResponse>;
  createTask(projectId: string, input: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(taskId: string): Promise<TaskResponse>;
  updateTask(taskId: string, input: UpdateTaskRequest): Promise<TaskResponse>;
  completeTask(taskId: string): Promise<CompleteTaskResponse>;
  developTask(taskId: string, input?: DevelopTaskRequest): Promise<DevelopTaskResponse>;
  reviewTask(taskId: string): Promise<ReviewTaskResponse>;
  sendFeedback(taskId: string, input: FeedbackTaskRequest): Promise<FeedbackTaskResponse>;
  cancelRun(runId: string): Promise<CancelRunResponse>;
  getRun(runId: string): Promise<RunResponse>;
  listRuns(taskId: string): Promise<RunListResponse>;
  getGitStatus(taskId: string): Promise<GitStatusResponse>;
  getGitDiff(taskId: string): Promise<GitDiffResponse>;
  getGitFiles(taskId: string): Promise<GitFilesResponse>;
  getGitFileDiff(taskId: string, path: string): Promise<GitFileDiffResponse>;
  listFindings(taskId: string): Promise<FindingsResponse>;
  updateFinding(findingId: string, input: UpdateFindingRequest): Promise<FindingResponse>;
  selectFindings(taskId: string, input: SelectFindingsRequest): Promise<SelectFindingsResponse>;
  previewFeedback(taskId: string, input: FeedbackPreviewRequest): Promise<FeedbackPreviewResponse>;
  getFeedbackDraft(taskId: string, reviewRunId: string): Promise<FeedbackDraftResponse>;
  saveFeedbackDraft(taskId: string, reviewRunId: string, input: SaveFeedbackDraftRequest): Promise<SaveFeedbackDraftResponse>;
}

export function createApiEndpoints(client: ApiClient): ApiEndpoints {
  return {
    health: () => client.request("/api/health", healthResponseSchema),
    getCliStatus: () => client.request("/api/system/clis", cliStatusResponseSchema),
    recheckClis: (input = {}) => client.request("/api/system/clis/recheck", cliRecheckResponseSchema, {
      method: "POST",
      body: input,
    }),
    getSettings: () => client.request("/api/system/settings", settingsResponseSchema),
    updateSettings: (input = {}) => client.request("/api/system/settings", settingsResponseSchema, {
      method: "POST",
      body: input,
    }),
    listProjects: () => client.request("/api/projects", projectListResponseSchema),
    createProject: (input) => client.request("/api/projects", createProjectResponseSchema, {
      method: "POST",
      body: input,
    }),
    getProject: (projectId) => client.request(`/api/projects/${id(projectId)}`, projectResponseSchema),
    listProjectFiles: (projectId, input = {}, signal) => client.request(
      `/api/projects/${id(projectId)}/files`,
      projectFilesResponseSchema,
      { query: input, signal },
    ),
    updateProject: (projectId, input) => client.request(`/api/projects/${id(projectId)}`, projectResponseSchema, {
      method: "PATCH",
      body: input,
    }),
    deleteProject: (projectId, input) => client.request(`/api/projects/${id(projectId)}`, deleteProjectResponseSchema, {
      method: "DELETE",
      body: input,
    }),
    listTasks: (projectId) => client.request(`/api/projects/${id(projectId)}/tasks`, taskListResponseSchema),
    createTask: (projectId, input) => client.request(`/api/projects/${id(projectId)}/tasks`, createTaskResponseSchema, {
      method: "POST",
      body: input,
    }),
    getTask: (taskId) => client.request(`/api/tasks/${id(taskId)}`, taskResponseSchema),
    updateTask: (taskId, input) => client.request(`/api/tasks/${id(taskId)}`, taskResponseSchema, {
      method: "PATCH",
      body: input,
    }),
    completeTask: (taskId) => client.request(`/api/tasks/${id(taskId)}/complete`, completeTaskResponseSchema, {
      method: "POST",
      body: {},
    }),
    developTask: (taskId, input = {}) => client.request(`/api/tasks/${id(taskId)}/develop`, developTaskResponseSchema, {
      method: "POST",
      body: input,
    }),
    reviewTask: (taskId) => client.request(`/api/tasks/${id(taskId)}/review`, reviewTaskResponseSchema, {
      method: "POST",
      body: {},
    }),
    sendFeedback: (taskId, input) => client.request(`/api/tasks/${id(taskId)}/feedback`, feedbackTaskResponseSchema, {
      method: "POST",
      body: input,
    }),
    cancelRun: (runId) => client.request(`/api/runs/${id(runId)}/cancel`, cancelRunResponseSchema, {
      method: "POST",
      body: {},
    }),
    getRun: (runId) => client.request(`/api/runs/${id(runId)}`, runResponseSchema),
    listRuns: (taskId) => client.request(`/api/tasks/${id(taskId)}/runs`, runListResponseSchema),
    getGitStatus: (taskId) => client.request(`/api/tasks/${id(taskId)}/git/status`, gitStatusResponseSchema),
    getGitDiff: (taskId) => client.request(`/api/tasks/${id(taskId)}/git/diff`, gitDiffResponseSchema),
    getGitFiles: (taskId) => client.request(`/api/tasks/${id(taskId)}/git/files`, gitFilesResponseSchema),
    getGitFileDiff: (taskId, path) => client.request(`/api/tasks/${id(taskId)}/git/file-diff`, gitFileDiffResponseSchema, {
      query: { path },
    }),
    listFindings: (taskId) => client.request(`/api/tasks/${id(taskId)}/findings`, findingsResponseSchema),
    updateFinding: (findingId, input) => client.request(`/api/findings/${id(findingId)}`, findingResponseSchema, {
      method: "PATCH",
      body: input,
    }),
    selectFindings: (taskId, input) => client.request(`/api/tasks/${id(taskId)}/findings/select`, selectFindingsResponseSchema, {
      method: "POST",
      body: input,
    }),
    previewFeedback: (taskId, input) => client.request(`/api/tasks/${id(taskId)}/feedback/preview`, feedbackPreviewResponseSchema, {
      method: "POST",
      body: input,
    }),
    getFeedbackDraft: (taskId, reviewRunId) => client.request(
      `/api/tasks/${id(taskId)}/reviews/${id(reviewRunId)}/feedback-draft`,
      feedbackDraftResponseSchema,
    ),
    saveFeedbackDraft: (taskId, reviewRunId, input) => client.request(
      `/api/tasks/${id(taskId)}/reviews/${id(reviewRunId)}/feedback-draft`,
      saveFeedbackDraftResponseSchema,
      { method: "PUT", body: input },
    ),
  };
}

export const apiEndpoints = createApiEndpoints(apiClient);
