import { z } from "zod";

export const providerSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof providerSchema>;

export const taskStatusSchema = z.enum([
  "draft",
  "developing",
  "ready_for_review",
  "reviewing",
  "waiting_for_human",
  "fixing",
  "completed",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const agentRunTypeSchema = z.enum([
  "developer_initial",
  "developer_feedback",
  "reviewer",
]);
export type AgentRunType = z.infer<typeof agentRunTypeSchema>;

export const agentRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const reviewParseStatusSchema = z.enum(["pending", "succeeded", "failed"]);
export type ReviewParseStatus = z.infer<typeof reviewParseStatusSchema>;

export const reviewSeveritySchema = z.enum(["P0", "P1", "P2"]);
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  defaultDeveloper: z.literal("codex"),
  defaultReviewer: z.literal("claude"),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string().nullable(),
}).strict();
export type Project = z.infer<typeof projectSchema>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  originalPrompt: z.string(),
  workingDirectory: z.string(),
  baseCommit: z.string(),
  latestSnapshotHash: z.string().nullable(),
  status: taskStatusSchema,
  developerSessionId: z.string().nullable(),
  reviewerSessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
}).strict();
export type Task = z.infer<typeof taskSchema>;

export const agentRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  provider: providerSchema,
  runType: agentRunTypeSchema,
  status: agentRunStatusSchema,
  reviewParseStatus: reviewParseStatusSchema.nullable(),
  externalSessionId: z.string().nullable(),
  processId: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  prompt: z.string(),
  finalMessage: z.string().nullable(),
  structuredOutput: z.unknown().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
}).strict();
export type AgentRun = z.infer<typeof agentRunSchema>;

const reviewFindingInputSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  severity: reviewSeveritySchema,
  title: z.string(),
  description: z.string(),
  suggestion: z.string(),
  file: z.string().nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  selected: z.boolean().optional(),
  dismissed: z.boolean(),
  userNote: z.string().nullable(),
  createdAt: z.string(),
}).strict();

export const reviewFindingSchema = reviewFindingInputSchema.transform((finding) => ({
  ...finding,
  selected: finding.selected ?? finding.severity !== "P2",
}));
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const feedbackDeliverySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sourceReviewRunId: z.string(),
  targetDeveloperRunId: z.string().nullable(),
  selectedFindingIds: z.array(z.string()),
  finalText: z.string(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
}).strict();
export type FeedbackDelivery = z.infer<typeof feedbackDeliverySchema>;

export const reviewResultSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "changes_suggested"]),
  findings: z.array(z.object({
    severity: reviewSeveritySchema,
    title: z.string(),
    description: z.string(),
    suggestion: z.string(),
    file: z.string().nullable(),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  }).strict()),
}).strict();
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const agentEventTypeSchema = z.enum([
  "run_queued",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "session_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "message",
  "plan",
  "tool",
  "command",
  "file_changed",
  "usage",
  "stderr",
  "review_parsed",
  "review_parse_failed",
  "raw",
]);
export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

export const agentEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  source: z.enum(["codex", "claude", "system", "git"]),
  type: agentEventTypeSchema,
  payload: z.unknown(),
}).strict();
export type AgentEvent<T = unknown> = Omit<z.infer<typeof agentEventSchema>, "payload"> & { payload: T };

export const webSocketSubscribeSchema = z.object({
  action: z.literal("subscribe"),
  taskId: z.string().min(1),
  afterSequence: z.number().int().nonnegative().default(0),
}).strict();
export type WebSocketSubscribe = z.infer<typeof webSocketSubscribeSchema>;

export const webSocketSubscribedMessageSchema = z.object({
  action: z.literal("subscribed"),
  taskId: z.string().min(1),
  afterSequence: z.number().int().nonnegative(),
}).strict();
export type WebSocketSubscribedMessage = z.infer<typeof webSocketSubscribedMessageSchema>;

export const webSocketEventMessageSchema = z.object({
  action: z.literal("event"),
  event: agentEventSchema,
}).strict();
export type WebSocketEventMessage = z.infer<typeof webSocketEventMessageSchema>;

export const healthResponseSchema = z.object({ status: z.literal("ok") }).strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const createProjectRequestSchema = z.object({ rootPath: z.string().min(1) }).strict();
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export const createTaskRequestSchema = z.object({
  title: z.string().min(1),
  originalPrompt: z.string().min(1),
  confirmDirtyWorkingTree: z.boolean().optional(),
}).strict();
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const projectResponseSchema = projectSchema;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export const projectListResponseSchema = z.array(projectSchema);
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export const createProjectResponseSchema = projectResponseSchema;
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const updateProjectRequestSchema = z.object({
  name: z.string().min(1).optional(),
  lastOpenedAt: z.string().nullable().optional(),
}).strict().refine((request) => Object.keys(request).length > 0, {
  message: "At least one project field is required",
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const deleteProjectRequestSchema = z.object({
  confirm: z.boolean().default(false),
}).strict();
export type DeleteProjectRequest = z.infer<typeof deleteProjectRequestSchema>;
export const deleteProjectResponseSchema = z.object({ deleted: z.literal(true) }).strict();
export type DeleteProjectResponse = z.infer<typeof deleteProjectResponseSchema>;

export const taskResponseSchema = taskSchema;
export type TaskResponse = z.infer<typeof taskResponseSchema>;
export const taskListResponseSchema = z.array(taskSchema);
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
export const createTaskResponseSchema = taskResponseSchema;
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

export const updateTaskRequestSchema = z.object({
  title: z.string().min(1).optional(),
  originalPrompt: z.string().min(1).optional(),
}).strict().refine((request) => Object.keys(request).length > 0, {
  message: "At least one task field is required",
});
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export const completeTaskRequestSchema = z.object({}).strict();
export type CompleteTaskRequest = z.infer<typeof completeTaskRequestSchema>;
export const completeTaskResponseSchema = taskResponseSchema;
export type CompleteTaskResponse = z.infer<typeof completeTaskResponseSchema>;

export const developTaskRequestSchema = z.object({
  prompt: z.string().min(1).optional(),
}).strict();
export type DevelopTaskRequest = z.infer<typeof developTaskRequestSchema>;
export const reviewTaskRequestSchema = z.object({}).strict();
export type ReviewTaskRequest = z.infer<typeof reviewTaskRequestSchema>;
export const feedbackTaskRequestSchema = z.object({
  sourceReviewRunId: z.string().min(1),
  selectedFindingIds: z.array(z.string().min(1)),
  finalText: z.string().min(1),
  confirmStaleSnapshot: z.boolean().default(false),
}).strict();
export type FeedbackTaskRequest = z.infer<typeof feedbackTaskRequestSchema>;

const taskRunResponseSchema = z.object({
  task: taskSchema,
  run: agentRunSchema,
}).strict();
export const developTaskResponseSchema = taskRunResponseSchema;
export type DevelopTaskResponse = z.infer<typeof developTaskResponseSchema>;
export const reviewTaskResponseSchema = taskRunResponseSchema;
export type ReviewTaskResponse = z.infer<typeof reviewTaskResponseSchema>;
export const feedbackTaskResponseSchema = z.object({
  task: taskSchema,
  run: agentRunSchema,
  delivery: feedbackDeliverySchema,
}).strict();
export type FeedbackTaskResponse = z.infer<typeof feedbackTaskResponseSchema>;

export const cancelRunRequestSchema = z.object({}).strict();
export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;
export const runResponseSchema = agentRunSchema;
export type RunResponse = z.infer<typeof runResponseSchema>;
export const cancelRunResponseSchema = runResponseSchema;
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;
export const runListResponseSchema = z.array(agentRunSchema);
export type RunListResponse = z.infer<typeof runListResponseSchema>;

export const updateFindingRequestSchema = z.object({
  selected: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  userNote: z.string().nullable().optional(),
}).strict().refine((request) => Object.keys(request).length > 0, {
  message: "At least one finding field is required",
});
export type UpdateFindingRequest = z.infer<typeof updateFindingRequestSchema>;
export const findingResponseSchema = reviewFindingSchema;
export type FindingResponse = z.infer<typeof findingResponseSchema>;
export const findingsResponseSchema = z.array(reviewFindingSchema);
export type FindingsResponse = z.infer<typeof findingsResponseSchema>;

export const findingSelectionModeSchema = z.enum(["P0", "P0_P1", "all", "none"]);
export type FindingSelectionMode = z.infer<typeof findingSelectionModeSchema>;
export const selectFindingsRequestSchema = z.object({ mode: findingSelectionModeSchema }).strict();
export type SelectFindingsRequest = z.infer<typeof selectFindingsRequestSchema>;
export const selectFindingsResponseSchema = findingsResponseSchema;
export type SelectFindingsResponse = z.infer<typeof selectFindingsResponseSchema>;

export const feedbackPreviewRequestSchema = z.object({
  sourceReviewRunId: z.string().min(1),
  selectedFindingIds: z.array(z.string().min(1)),
}).strict();
export type FeedbackPreviewRequest = z.infer<typeof feedbackPreviewRequestSchema>;
export const feedbackPreviewResponseSchema = z.object({ finalText: z.string() }).strict();
export type FeedbackPreviewResponse = z.infer<typeof feedbackPreviewResponseSchema>;

export const gitFileStatusSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  staged: z.boolean(),
  tracked: z.boolean(),
  binary: z.boolean(),
}).strict();
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;

export const gitStatusRequestSchema = z.object({}).strict();
export type GitStatusRequest = z.infer<typeof gitStatusRequestSchema>;
export const gitStatusResponseSchema = z.object({
  clean: z.boolean(),
  files: z.array(gitFileStatusSchema),
  snapshotHash: z.string().min(1).optional(),
}).strict();
export type GitStatusResponse = z.infer<typeof gitStatusResponseSchema>;

export const gitDiffRequestSchema = z.object({}).strict();
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;
export const gitDiffResponseSchema = z.object({
  baseCommit: z.string().min(1),
  trackedPatch: z.string(),
  stagedPatch: z.string(),
  untrackedPatch: z.string(),
  stat: z.string(),
  files: z.array(gitFileStatusSchema),
}).strict();
export type GitDiffResponse = z.infer<typeof gitDiffResponseSchema>;

export const gitFilesRequestSchema = z.object({}).strict();
export type GitFilesRequest = z.infer<typeof gitFilesRequestSchema>;
export const gitFilesResponseSchema = z.object({ files: z.array(gitFileStatusSchema) }).strict();
export type GitFilesResponse = z.infer<typeof gitFilesResponseSchema>;
export const gitFileDiffRequestSchema = z.object({ path: z.string().min(1) }).strict();
export type GitFileDiffRequest = z.infer<typeof gitFileDiffRequestSchema>;
export const gitFileDiffResponseSchema = z.object({
  file: gitFileStatusSchema,
  patch: z.string(),
  originalText: z.string().nullable(),
  modifiedText: z.string().nullable(),
}).strict();
export type GitFileDiffResponse = z.infer<typeof gitFileDiffResponseSchema>;

export const agentAvailabilitySchema = z.object({
  installed: z.boolean(),
  executablePath: z.string().nullable(),
  version: z.string().nullable(),
  authentication: z.enum(["unknown", "authenticated", "unauthenticated"]),
  message: z.string().nullable(),
}).strict();
export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;

export const cliStatusRequestSchema = z.object({}).strict();
export type CliStatusRequest = z.infer<typeof cliStatusRequestSchema>;
export const cliStatusResponseSchema = z.object({
  codex: agentAvailabilitySchema,
  claude: agentAvailabilitySchema,
  git: agentAvailabilitySchema,
}).strict();
export type CliStatusResponse = z.infer<typeof cliStatusResponseSchema>;
const cliExecutableOverrideSchema = z.string().min(1).nullable().optional();
export const cliRecheckRequestSchema = z.object({
  codexExecutable: cliExecutableOverrideSchema,
  claudeExecutable: cliExecutableOverrideSchema,
  gitExecutable: cliExecutableOverrideSchema,
}).strict();
export type CliRecheckRequest = z.infer<typeof cliRecheckRequestSchema>;
export const cliRecheckResponseSchema = cliStatusResponseSchema;
export type CliRecheckResponse = z.infer<typeof cliRecheckResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "CLI_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
}).strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export interface AgentStartRequest {
  runId: string;
  taskId: string;
  projectId: string;
  workingDirectory: string;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AgentStartResult {
  sessionId: string | null;
  finalMessage: string | null;
  structuredOutput: unknown | null;
}

export interface AgentDriver {
  readonly provider: Provider;
  checkAvailability(): Promise<AgentAvailability>;
  start(request: AgentStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult>;
  cancel(runId: string): Promise<void>;
}
