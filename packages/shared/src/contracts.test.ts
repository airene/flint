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

test("project and task mutation DTOs are strict", () => {
  expectStrict("updateProjectRequestSchema", { name: "Renamed project" });
  expectStrict("deleteProjectRequestSchema", { confirm: true });
  expectStrict("updateTaskRequestSchema", { title: "Renamed task" });
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
  expectStrict("selectFindingsRequestSchema", { mode: "P0_P1" });
  expectStrict("feedbackPreviewRequestSchema", { selectedFindingIds: ["finding_1"] });
  expectStrict("feedbackPreviewResponseSchema", { finalText: "Preview" });
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

  expectStrict("gitStatusResponseSchema", { clean: false, files: [file] });
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
  expectStrict("gitFileDiffResponseSchema", { file, patch: "diff --git" });
});

test("CLI status and recheck responses use strict availability records", () => {
  const cli = {
    installed: true,
    executablePath: "/usr/local/bin/codex",
    version: "1.0.0",
    authentication: "authenticated",
    message: null,
  };
  const response = { codex: cli, claude: cli, git: { ...cli, authentication: "unknown" } };

  expectStrict("cliStatusResponseSchema", response);
  expectStrict("cliRecheckResponseSchema", response);
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
