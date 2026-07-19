import { z } from "zod";

export const providerSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof providerSchema>;

export const agentRoleSchema = z.enum(["developer", "reviewer"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

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
  "developer_followup",
  "reviewer",
  "reviewer_followup",
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

export const messageDeliveryModeSchema = z.enum(["queue", "interrupt"]);
export type MessageDeliveryMode = z.infer<typeof messageDeliveryModeSchema>;

export const taskMessageStatusSchema = z.enum(["queued", "delivering", "delivered", "failed"]);
export type TaskMessageStatus = z.infer<typeof taskMessageStatusSchema>;

export const attachmentStateSchema = z.enum(["draft", "claimed"]);
export type AttachmentState = z.infer<typeof attachmentStateSchema>;

export const approvalStatusSchema = z.enum(["pending", "resolving", "resolved", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalDecisionSchema = z.enum(["allow_once", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const taskAttentionSchema = z.enum([
  "pending_approval",
  "needs_attention",
  "running",
  "waiting_for_human",
  "ready_for_review",
  "pending_start",
  "other",
]);
export type TaskAttention = z.infer<typeof taskAttentionSchema>;

export const reviewParseStatusSchema = z.enum(["pending", "succeeded", "failed"]);
export type ReviewParseStatus = z.infer<typeof reviewParseStatusSchema>;

export const reviewSeveritySchema = z.enum(["P0", "P1", "P2"]);
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
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
  developerProvider: providerSchema,
  reviewerProvider: providerSchema,
  developerSessionId: z.string().nullable(),
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

export const taskMessageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  targetRole: agentRoleSchema,
  sourceReviewRunId: z.string().min(1).nullable(),
  text: z.string().min(1),
  deliveryMode: messageDeliveryModeSchema,
  status: taskMessageStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deliveredAt: z.string().min(1).nullable(),
  errorMessage: z.string().nullable(),
}).strict();
export type TaskMessage = z.infer<typeof taskMessageSchema>;

export const taskAttachmentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  messageId: z.string().min(1).nullable(),
  state: attachmentStateSchema,
  storagePath: z.string().min(1),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  checksum: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  claimedAt: z.string().min(1).nullable(),
}).strict().superRefine((attachment, context) => {
  if (attachment.state === "draft" && (attachment.taskId || attachment.messageId || attachment.claimedAt)) {
    context.addIssue({ code: "custom", message: "Draft attachments cannot have a claimed owner" });
  }
  if (attachment.state === "claimed" && (!attachment.taskId || !attachment.claimedAt)) {
    context.addIssue({ code: "custom", message: "Claimed attachments require a Task owner and claim time" });
  }
});
export type TaskAttachment = z.infer<typeof taskAttachmentSchema>;

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  providerRequestId: z.string().min(1),
  toolName: z.string().min(1),
  actionSummary: z.string().min(1),
  workingDirectory: z.string().min(1),
  status: approvalStatusSchema,
  decision: approvalDecisionSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().min(1),
  resolvedAt: z.string().min(1).nullable(),
}).strict().superRefine((approval, context) => {
  if (approval.status === "resolved" && (!approval.decision || !approval.resolvedAt)) {
    context.addIssue({ code: "custom", message: "Resolved approvals require a decision and resolution time" });
  }
  if (approval.status === "resolving" && (!approval.decision || approval.resolvedAt)) {
    context.addIssue({ code: "custom", message: "Resolving approvals require a decision and no resolution time" });
  }
  if (approval.status === "pending" && (approval.decision || approval.resolvedAt)) {
    context.addIssue({ code: "custom", message: "Pending approvals cannot have a decision" });
  }
  if (approval.status === "expired" && (approval.decision || !approval.resolvedAt)) {
    context.addIssue({ code: "custom", message: "Expired approvals require an expiry time and no decision" });
  }
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const unfinishedTaskSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema,
  latestRunStatus: agentRunStatusSchema.nullable(),
  pendingApprovalCount: z.number().int().nonnegative(),
  attention: taskAttentionSchema,
  updatedAt: z.string().min(1),
}).strict();
export type UnfinishedTaskSummary = z.infer<typeof unfinishedTaskSummarySchema>;

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

export const feedbackDraftSchema = z.object({
  taskId: z.string(),
  sourceReviewRunId: z.string(),
  finalText: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type FeedbackDraft = z.infer<typeof feedbackDraftSchema>;

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
  "review_parsed",
  "review_parse_failed",
  "message_queued",
  "message_delivered",
  "message_failed",
  "approval_requested",
  "approval_resolved",
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
  attachmentIds: z.array(z.string().min(1)).max(4).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: "Attachment IDs must be unique" },
  ).optional(),
  confirmDirtyWorkingTree: z.boolean().optional(),
}).strict();
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const createTaskMessageRequestSchema = z.object({
  targetRole: agentRoleSchema,
  sourceReviewRunId: z.string().min(1).nullable(),
  text: z.string().min(1),
  deliveryMode: messageDeliveryModeSchema,
  attachmentIds: z.array(z.string().min(1)).max(4).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: "Attachment IDs must be unique" },
  ),
}).strict().superRefine((message, context) => {
  if (message.targetRole === "reviewer" && !message.sourceReviewRunId) {
    context.addIssue({
      code: "custom",
      path: ["sourceReviewRunId"],
      message: "Reviewer messages require an exact source Review Run",
    });
  }
});
export type CreateTaskMessageRequest = z.infer<typeof createTaskMessageRequestSchema>;

export const approvalDecisionRequestSchema = z.object({
  decision: approvalDecisionSchema,
  reason: z.string().min(1).nullable().optional(),
}).strict();
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

export const projectResponseSchema = projectSchema;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export const projectListResponseSchema = z.array(projectSchema);
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export const createProjectResponseSchema = projectResponseSchema;
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const markProjectOpenedRequestSchema = z.object({ lastOpenedAt: z.string().min(1) }).strict();
export type MarkProjectOpenedRequest = z.infer<typeof markProjectOpenedRequestSchema>;

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
export const taskMessageResponseSchema = taskMessageSchema;
export type TaskMessageResponse = z.infer<typeof taskMessageResponseSchema>;
export const taskMessageListResponseSchema = z.array(taskMessageSchema);
export type TaskMessageListResponse = z.infer<typeof taskMessageListResponseSchema>;
export const approvalResponseSchema = approvalRequestSchema;
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
export const approvalListResponseSchema = z.array(approvalRequestSchema);
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;
export const unfinishedTaskListResponseSchema = z.array(unfinishedTaskSummarySchema);
export type UnfinishedTaskListResponse = z.infer<typeof unfinishedTaskListResponseSchema>;

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
export const selectFindingsRequestSchema = z.object({
  sourceReviewRunId: z.string().min(1),
  mode: findingSelectionModeSchema,
}).strict();
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
export const feedbackDraftResponseSchema = z.object({ draft: feedbackDraftSchema.nullable() }).strict();
export type FeedbackDraftResponse = z.infer<typeof feedbackDraftResponseSchema>;
export const saveFeedbackDraftRequestSchema = z.object({ finalText: z.string() }).strict();
export type SaveFeedbackDraftRequest = z.infer<typeof saveFeedbackDraftRequestSchema>;
export const saveFeedbackDraftResponseSchema = feedbackDraftSchema;
export type SaveFeedbackDraftResponse = z.infer<typeof saveFeedbackDraftResponseSchema>;

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

export const projectFilesRequestSchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number<string | number>().int().min(1).max(50).default(50),
}).strict();
export type ProjectFilesRequest = z.input<typeof projectFilesRequestSchema>;
export const projectFilesResponseSchema = z.object({ files: z.array(z.string()) }).strict();
export type ProjectFilesResponse = z.infer<typeof projectFilesResponseSchema>;

export const agentAvailabilitySchema = z.object({
  installed: z.boolean(),
  executablePath: z.string().nullable(),
  version: z.string().nullable(),
  authentication: z.enum(["unknown", "authenticated", "unauthenticated"]),
  model: z.string().nullable(),
  modelSource: z.enum([
    "environment",
    "user_config",
    "project_config",
    "managed_config",
    "system_config",
    "session_override",
    "cli_default",
  ]).nullable(),
  reasoningEffort: z.string().nullable(),
  message: z.string().nullable(),
}).strict();
export type CliModelSource = NonNullable<z.infer<typeof agentAvailabilitySchema>["modelSource"]>;
export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;

export const cliExecutableSettingSchema = z.enum(["codexExecutable", "claudeExecutable"]);
export type CliExecutableSetting = z.infer<typeof cliExecutableSettingSchema>;

export const providerCapabilitiesSchema = z.object({
  developerInitialImage: z.boolean(),
  developerResumeImage: z.boolean(),
  reviewerInitialImage: z.boolean(),
  reviewerResumeImage: z.boolean(),
  liveMessages: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
}).strict();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerDescriptorSchema = z.object({
  id: providerSchema,
  label: z.string().min(1),
  executableSetting: cliExecutableSettingSchema,
  roles: z.array(agentRoleSchema).min(1),
  capabilities: providerCapabilitiesSchema.optional(),
  availability: agentAvailabilitySchema,
}).strict();
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;

export const agentRoleSettingsSchema = z.object({
  developerProvider: providerSchema,
  reviewerProvider: providerSchema,
}).strict();
export type AgentRoleSettings = z.infer<typeof agentRoleSettingsSchema>;

const cliExecutableOverrideSchema = z.string().min(1).nullable().optional();
export const settingsUpdateRequestSchema = z.object({
  codexExecutable: cliExecutableOverrideSchema,
  claudeExecutable: cliExecutableOverrideSchema,
  gitExecutable: cliExecutableOverrideSchema,
  developerProvider: providerSchema.optional(),
  reviewerProvider: providerSchema.optional(),
}).strict();
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;

export const settingsResponseSchema = z.object({
  providers: z.array(providerDescriptorSchema),
  git: agentAvailabilitySchema,
  roles: agentRoleSettingsSchema,
}).strict();
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const cliStatusRequestSchema = z.object({}).strict();
export type CliStatusRequest = z.infer<typeof cliStatusRequestSchema>;
export const cliStatusResponseSchema = z.object({
  codex: agentAvailabilitySchema,
  claude: agentAvailabilitySchema,
  git: agentAvailabilitySchema,
}).strict();
export type CliStatusResponse = z.infer<typeof cliStatusResponseSchema>;
export const cliRecheckRequestSchema = settingsUpdateRequestSchema;
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
  runType: AgentRunType;
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
