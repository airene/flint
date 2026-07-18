import { expect, test } from "bun:test";
import * as shared from "./index";

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
