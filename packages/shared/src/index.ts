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

export interface AgentAvailability {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  authentication: "unknown" | "authenticated" | "unauthenticated";
  message: string | null;
}

export interface AgentDriver {
  readonly provider: Provider;
  checkAvailability(): Promise<AgentAvailability>;
  start(request: AgentStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult>;
  cancel(runId: string): Promise<void>;
}
