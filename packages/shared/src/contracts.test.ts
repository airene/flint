import { expect, test } from "bun:test";
import * as shared from "./index";

type RuntimeSchema = {
  safeParse: (value: unknown) => { success: boolean };
};

function getSchema(name: string): RuntimeSchema {
  const schema = (shared as Record<string, unknown>)[name] as RuntimeSchema | undefined;
  expect(schema, `${name} must be exported`).toBeDefined();
  return schema as RuntimeSchema;
}

function expectStrict(name: string, validValue: Record<string, unknown>): void {
  const schema = getSchema(name);
  expect(schema.safeParse(validValue).success, `${name} must accept its DTO`).toBe(true);
  expect(schema.safeParse({ ...validValue, unexpected: true }).success, `${name} must reject unknown keys`).toBe(false);
}

test("review finding defaults to selecting P0 and P1 findings", () => {
  const schema = (shared as { reviewFindingSchema?: { parse: (value: unknown) => { selected: boolean } } }).reviewFindingSchema;
  expect(schema).toBeDefined();
  if (!schema) return;

  const finding = (severity: "P0" | "P1" | "P2") => schema.parse({
    id: "finding_1",
    taskId: "task_1",
    runId: "run_1",
    severity,
    title: "A finding",
    description: "Description",
    suggestion: "Suggestion",
    file: null,
    startLine: null,
    endLine: null,
    dismissed: false,
    userNote: null,
    createdAt: "2026-07-18T00:00:00.000Z",
  });

  expect(finding("P0").selected).toBe(true);
  expect(finding("P1").selected).toBe(true);
  expect(finding("P2").selected).toBe(false);
});

test("review result rejects findings with an invalid line range", () => {
  const schema = (shared as { reviewResultSchema?: { safeParse: (value: unknown) => { success: boolean } } }).reviewResultSchema;
  expect(schema).toBeDefined();
  if (!schema) return;

  const result = schema.safeParse({
    summary: "Needs work",
    verdict: "changes_suggested",
    findings: [{
      severity: "P1",
      title: "Bad range",
      description: "Description",
      suggestion: "Suggestion",
      file: "src/example.ts",
      startLine: 0,
      endLine: 1,
    }],
  });

  expect(result.success).toBe(false);
});

test("project mutation DTOs are strict", () => {
  expectStrict("markProjectOpenedRequestSchema", { lastOpenedAt: "2026-07-19T00:00:00.000Z" });
  expectStrict("deleteProjectRequestSchema", { confirm: true });
});

test("agent action and run DTOs are strict", () => {
  expectStrict("developTaskRequestSchema", { prompt: "Continue the task" });
  expectStrict("reviewTaskRequestSchema", {});
  expectStrict("feedbackTaskRequestSchema", {
    sourceReviewRunId: "run_review",
    selectedFindingIds: ["finding_1"],
    finalText: "Please address this finding.",
    confirmStaleSnapshot: false,
  });
  expectStrict("cancelRunRequestSchema", {});
});

test("finding selection and feedback preview DTOs are strict", () => {
  expectStrict("updateFindingRequestSchema", { selected: true, userNote: null });
  expectStrict("selectFindingsRequestSchema", { sourceReviewRunId: "run_review", mode: "P0_P1" });
  expectStrict("feedbackPreviewRequestSchema", {
    sourceReviewRunId: "run_review",
    selectedFindingIds: ["finding_1"],
  });
  expectStrict("feedbackPreviewResponseSchema", { finalText: "Preview" });
  expectStrict("saveFeedbackDraftRequestSchema", { finalText: "Edited preview" });
  expectStrict("feedbackDraftSchema", {
    taskId: "task_1",
    sourceReviewRunId: "run_review",
    finalText: "Edited preview",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:01.000Z",
  });
  expectStrict("feedbackDraftResponseSchema", { draft: null });
});

test("Git response DTOs distinguish status, aggregate diff, files, and file diff", () => {
  const file = {
    path: "src/example.ts",
    previousPath: null,
    status: "modified",
    staged: false,
    tracked: true,
    binary: false,
  };

  expectStrict("gitStatusResponseSchema", { clean: false, files: [file], snapshotHash: "snapshot-1" });
  expectStrict("gitDiffResponseSchema", {
    baseCommit: "abc123",
    trackedPatch: "diff --git",
    stagedPatch: "",
    untrackedPatch: "",
    stat: "1 file changed",
    files: [file],
  });
  expectStrict("gitFilesResponseSchema", { files: [file] });
  expectStrict("gitFileDiffRequestSchema", { path: "src/example.ts" });
  expectStrict("gitFileDiffResponseSchema", { file, patch: "diff --git", originalText: "before", modifiedText: "after" });
});

test("project file search uses strict bounded request and response DTOs", () => {
  const request = getSchema("projectFilesRequestSchema");
  expect(request.safeParse({}).success).toBe(true);
  expect(request.safeParse({ q: "src/app", limit: "12" }).success).toBe(true);
  expect(request.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  expect(request.safeParse({ limit: "0" }).success).toBe(false);
  expect(request.safeParse({ limit: "51" }).success).toBe(false);
  expectStrict("projectFilesResponseSchema", { files: ["src/app.ts", "docs/design notes.md"] });
  const parsed = (shared as { projectFilesRequestSchema: { parse: (value: unknown) => unknown } })
    .projectFilesRequestSchema.parse({});
  expect(parsed).toEqual({ q: "", limit: 50 });
});

test("CLI status and recheck responses use strict availability records", () => {
  const cli = {
    installed: true,
    executablePath: "/usr/local/bin/codex",
    version: "1.0.0",
    authentication: "authenticated",
    model: "gpt-5.6-sol",
    modelSource: "user_config",
    reasoningEffort: "high",
    message: null,
  };
  const response = {
    codex: cli,
    claude: { ...cli, model: "sonnet", reasoningEffort: null },
    git: { ...cli, authentication: "unknown", model: null, modelSource: null, reasoningEffort: null },
  };

  expectStrict("cliStatusResponseSchema", response);
  expectStrict("cliRecheckResponseSchema", response);
});

test("role-aware settings contracts accept dynamic provider descriptors and reject unknown fields", () => {
  const availability = {
    installed: true,
    executablePath: "/usr/local/bin/codex",
    version: "1.0.0",
    authentication: "authenticated",
    model: "gpt-5.6-sol",
    modelSource: "user_config",
    reasoningEffort: "high",
    message: null,
  };
  const descriptor = {
    id: "codex",
    label: "Codex",
    executableSetting: "codexExecutable",
    roles: ["developer", "reviewer"],
    capabilities: {
      developerInitialImage: true,
      developerResumeImage: true,
      reviewerInitialImage: true,
      reviewerResumeImage: true,
      liveMessages: false,
      interrupt: true,
      approvals: true,
    },
    availability,
  };

  expectStrict("providerDescriptorSchema", descriptor);
  expectStrict("agentRoleSettingsSchema", { developerProvider: "claude", reviewerProvider: "codex" });
  expectStrict("settingsResponseSchema", {
    providers: [{ ...descriptor }, {
      ...descriptor,
      id: "claude",
      label: "Claude Code",
      executableSetting: "claudeExecutable",
    }],
    git: availability,
    roles: { developerProvider: "claude", reviewerProvider: "codex" },
  });
  expectStrict("settingsUpdateRequestSchema", {
    codexExecutable: null,
    developerProvider: "claude",
    reviewerProvider: "codex",
  });
});

test("tasks expose immutable developer and reviewer provider snapshots", () => {
  expectStrict("taskSchema", {
    id: "task_1",
    projectId: "project_1",
    title: "Role snapshot",
    originalPrompt: "Implement it",
    workingDirectory: "/tmp/project",
    baseCommit: "abc123",
    latestSnapshotHash: null,
    status: "draft",
    developerProvider: "claude",
    reviewerProvider: "codex",
    developerSessionId: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    completedAt: null,
  });
});

test("resource response DTO schemas are exported for the planned routes", () => {
  const schemaNames = [
    "projectResponseSchema",
    "projectListResponseSchema",
    "deleteProjectResponseSchema",
    "taskResponseSchema",
    "taskListResponseSchema",
    "developTaskResponseSchema",
    "reviewTaskResponseSchema",
    "feedbackTaskResponseSchema",
    "findingResponseSchema",
    "findingsResponseSchema",
    "runResponseSchema",
    "runListResponseSchema",
  ];

  for (const schemaName of schemaNames) {
    expect(getSchema(schemaName), schemaName).toBeDefined();
  }
});

test("interactive workflow records are strict and preserve explicit lifecycle state", () => {
  expectStrict("taskMessageSchema", {
    id: "message_1",
    projectId: "project_1",
    taskId: "task_1",
    targetRole: "reviewer",
    sourceReviewRunId: "review_1",
    text: "Why did you flag this?",
    deliveryMode: "queue",
    status: "queued",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    deliveredAt: null,
    errorMessage: null,
  });
  expectStrict("taskAttachmentSchema", {
    id: "attachment_1",
    projectId: "project_1",
    taskId: null,
    messageId: null,
    state: "draft",
    storagePath: "/data/drafts/attachment_1.png",
    mediaType: "image/png",
    sizeBytes: 128,
    checksum: "sha256:abc",
    createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    claimedAt: null,
  });
  expectStrict("approvalRequestSchema", {
    id: "approval_1",
    projectId: "project_1",
    taskId: "task_1",
    runId: "run_1",
    providerRequestId: "provider_request_1",
    toolName: "shell",
    actionSummary: "Run the test suite",
    workingDirectory: "/repo",
    status: "resolved",
    decision: "allow_once",
    reason: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    resolvedAt: "2026-07-19T00:00:01.000Z",
  });
});

test("follow-up runs and interaction events are distinct from a formal reviewer run", () => {
  const runTypes = getSchema("agentRunTypeSchema");
  expect(runTypes.safeParse("developer_followup").success).toBe(true);
  expect(runTypes.safeParse("reviewer_followup").success).toBe(true);
  expect(runTypes.safeParse("reviewer").success).toBe(true);

  const eventTypes = getSchema("agentEventTypeSchema");
  for (const eventType of [
    "message_queued",
    "message_delivered",
    "message_failed",
    "approval_requested",
    "approval_resolved",
  ]) expect(eventTypes.safeParse(eventType).success).toBe(true);
});

test("approval resolving state durably carries the first decision without a resolution time", () => {
  const approval = getSchema("approvalRequestSchema");
  const resolving = {
    id: "approval_1", projectId: "project_1", taskId: "task_1", runId: "run_1",
    providerRequestId: "provider_request_1", toolName: "shell", actionSummary: "Run tests",
    workingDirectory: "/repo", status: "resolving", decision: "deny", reason: "unsafe",
    createdAt: "2026-07-19T00:00:00.000Z", resolvedAt: null,
  };
  expect(approval.safeParse(resolving).success).toBe(true);
  expect(approval.safeParse({ ...resolving, decision: null }).success).toBe(false);
  expect(approval.safeParse({ ...resolving, resolvedAt: "2026-07-19T00:00:01.000Z" }).success).toBe(false);
});

test("provider interaction capabilities are independent by role and delivery phase", () => {
  expectStrict("providerCapabilitiesSchema", {
    developerInitialImage: true,
    developerResumeImage: false,
    reviewerInitialImage: true,
    reviewerResumeImage: false,
    liveMessages: false,
    interrupt: true,
    approvals: true,
  });
});

test("create-task and message requests carry at most four unique attachment IDs", () => {
  const createTask = getSchema("createTaskRequestSchema");
  expect(createTask.safeParse({
    title: "Task",
    originalPrompt: "Prompt",
    attachmentIds: ["attachment_1", "attachment_2", "attachment_3", "attachment_4"],
  }).success).toBe(true);
  expect(createTask.safeParse({
    title: "Task",
    originalPrompt: "Prompt",
    attachmentIds: ["1", "2", "3", "4", "5"],
  }).success).toBe(false);

  const message = getSchema("createTaskMessageRequestSchema");
  expect(message.safeParse({
    targetRole: "developer",
    sourceReviewRunId: null,
    text: "Please continue",
    deliveryMode: "interrupt",
    attachmentIds: ["attachment_1"],
  }).success).toBe(true);
  expect(message.safeParse({
    targetRole: "reviewer",
    sourceReviewRunId: null,
    text: "No exact review target",
    deliveryMode: "queue",
    attachmentIds: [],
  }).success).toBe(false);
  expect(message.safeParse({
    targetRole: "developer",
    sourceReviewRunId: null,
    text: "Duplicate attachment",
    deliveryMode: "queue",
    attachmentIds: ["attachment_1", "attachment_1"],
  }).success).toBe(false);
});

test("unfinished task summaries expose derived attention without prompt or activity bodies", () => {
  expectStrict("unfinishedTaskSummarySchema", {
    id: "task_1",
    projectId: "project_1",
    projectName: "Flint",
    title: "Interactive task",
    status: "waiting_for_human",
    latestRunStatus: "completed",
    pendingApprovalCount: 1,
    attention: "pending_approval",
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
});
