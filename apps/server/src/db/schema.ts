import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull().unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastOpenedAt: text("last_opened_at"),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  originalPrompt: text("original_prompt").notNull(),
  workingDirectory: text("working_directory").notNull(),
  baseCommit: text("base_commit").notNull(),
  latestSnapshotHash: text("latest_snapshot_hash"),
  status: text("status", { enum: ["draft", "developing", "ready_for_review", "reviewing", "waiting_for_human", "fixing", "completed"] }).notNull(),
  developerProvider: text("developer_provider", { enum: ["codex", "claude"] }).notNull().default("codex"),
  reviewerProvider: text("reviewer_provider", { enum: ["codex", "claude"] }).notNull().default("claude"),
  developerSessionId: text("developer_session_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [index("tasks_project_id_index").on(table.projectId)]);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["codex", "claude"] }).notNull(),
  runType: text("run_type", { enum: [
    "developer_initial",
    "developer_feedback",
    "developer_followup",
    "reviewer",
    "reviewer_followup",
  ] }).notNull(),
  status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled", "interrupted"] }).notNull(),
  reviewParseStatus: text("review_parse_status", { enum: ["pending", "succeeded", "failed"] }),
  externalSessionId: text("external_session_id"),
  processId: integer("process_id"),
  exitCode: integer("exit_code"),
  prompt: text("prompt").notNull(),
  finalMessage: text("final_message"),
  structuredOutput: text("structured_output", { mode: "json" }),
  errorMessage: text("error_message"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
}, (table) => [
  index("agent_runs_task_id_index").on(table.taskId),
  index("agent_runs_project_id_index").on(table.projectId),
  uniqueIndex("active_agent_run_per_task_unique")
    .on(table.taskId)
    .where(sql`${table.status} in ('queued', 'running')`),
  uniqueIndex("active_write_run_per_project_unique")
    .on(table.projectId)
    .where(sql`${table.runType} in ('developer_initial', 'developer_feedback', 'developer_followup') and ${table.status} in ('queued', 'running')`),
]);

export const taskMessages = sqliteTable("task_messages", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  targetRole: text("target_role", { enum: ["developer", "reviewer"] }).notNull(),
  sourceReviewRunId: text("source_review_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  text: text("text").notNull(),
  deliveryMode: text("delivery_mode", { enum: ["queue", "interrupt"] }).notNull(),
  status: text("status", { enum: ["queued", "delivering", "delivered", "failed"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deliveredAt: text("delivered_at"),
  errorMessage: text("error_message"),
}, (table) => [
  index("task_messages_task_id_index").on(table.taskId),
  index("task_messages_source_review_run_id_index").on(table.sourceReviewRunId),
]);

export const taskAttachments = sqliteTable("task_attachments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => taskMessages.id, { onDelete: "cascade" }),
  state: text("state", { enum: ["draft", "claimed"] }).notNull(),
  storagePath: text("storage_path").notNull().unique(),
  mediaType: text("media_type", { enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  claimedAt: text("claimed_at"),
}, (table) => [
  index("task_attachments_project_state_index").on(table.projectId, table.state),
  index("task_attachments_task_id_index").on(table.taskId),
  index("task_attachments_message_id_index").on(table.messageId),
]);

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  providerRequestId: text("provider_request_id").notNull(),
  toolName: text("tool_name").notNull(),
  actionSummary: text("action_summary").notNull(),
  workingDirectory: text("working_directory").notNull(),
  status: text("status", { enum: ["pending", "resolving", "resolved", "expired"] }).notNull(),
  decision: text("decision", { enum: ["allow_once", "deny"] }),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => [
  uniqueIndex("approval_requests_run_provider_request_unique").on(table.runId, table.providerRequestId),
  index("approval_requests_task_status_index").on(table.taskId, table.status),
]);

export const applicationLeases = sqliteTable("application_leases", {
  slot: integer("slot").primaryKey(),
  ownerInstanceId: text("owner_instance_id").notNull(),
  processId: integer("process_id").notNull(),
  leaseExpiresAt: text("lease_expires_at").notNull(),
});

export const runLeases = sqliteTable("run_leases", {
  runId: text("run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  ownerInstanceId: text("owner_instance_id").notNull(),
  leaseExpiresAt: text("lease_expires_at").notNull(),
}, (table) => [index("run_leases_owner_instance_id_index").on(table.ownerInstanceId)]);

export const reviewRunSnapshots = sqliteTable("review_run_snapshots", {
  runId: text("run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  snapshotHash: text("snapshot_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const agentEvents = sqliteTable("agent_events", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  source: text("source", { enum: ["codex", "claude", "system", "git"] }).notNull(),
  eventType: text("event_type").notNull(),
  rawJson: text("raw_json").notNull(),
  normalizedJson: text("normalized_json"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("agent_events_task_sequence_unique").on(table.taskId, table.sequence),
  index("agent_events_run_id_index").on(table.runId),
]);

export const reviewFindings = sqliteTable("review_findings", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  severity: text("severity", { enum: ["P0", "P1", "P2"] }).notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  suggestion: text("suggestion").notNull(),
  file: text("file"),
  startLine: integer("start_line"),
  endLine: integer("end_line"),
  selected: integer("selected", { mode: "boolean" }).notNull(),
  dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false),
  userNote: text("user_note"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("review_findings_task_id_index").on(table.taskId)]);

export const feedbackDeliveries = sqliteTable("feedback_deliveries", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  sourceReviewRunId: text("source_review_run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  targetDeveloperRunId: text("target_developer_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  selectedFindingIds: text("selected_finding_ids", { mode: "json" }).$type<string[]>().notNull(),
  finalText: text("final_text").notNull(),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("feedback_deliveries_task_id_index").on(table.taskId)]);

export const feedbackDrafts = sqliteTable("feedback_drafts", {
  sourceReviewRunId: text("source_review_run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  finalText: text("final_text").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("feedback_drafts_task_id_index").on(table.taskId)]);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
