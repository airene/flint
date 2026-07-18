import { describe, expect, test } from "bun:test";
import type { AgentRun, ReviewFinding } from "@local-pair-review/shared";
import { displayFindingsForRun } from "../../apps/web/src/components/review-display";

function reviewerRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "review-run",
    taskId: "task-1",
    projectId: "project-1",
    provider: "claude",
    runType: "reviewer",
    status: "completed",
    reviewParseStatus: "succeeded",
    externalSessionId: "session-1",
    processId: null,
    exitCode: 0,
    prompt: "Review the change.",
    finalMessage: "Done.",
    structuredOutput: {
      summary: "One issue found.",
      verdict: "changes_suggested",
      findings: [{
        severity: "P1",
        title: "Validate input",
        description: "The API accepts invalid input.",
        suggestion: "Validate input before saving.",
        file: "apps/server/src/api.ts",
        startLine: 12,
        endLine: 14,
      }],
    },
    errorMessage: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    finishedAt: "2026-07-18T00:01:00.000Z",
    ...overrides,
  };
}

function persistedFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "persisted-finding",
    taskId: "task-1",
    runId: "review-run",
    severity: "P2",
    title: "Persisted title",
    description: "Persisted description.",
    suggestion: "Persisted suggestion.",
    file: null,
    startLine: null,
    endLine: null,
    selected: false,
    dismissed: true,
    userNote: "Keep this human note",
    createdAt: "2026-07-18T00:02:00.000Z",
    ...overrides,
  };
}

describe("displayFindingsForRun", () => {
  test("uses only persisted findings belonging to the selected run", () => {
    const run = reviewerRun();
    const selectedFinding = persistedFinding();
    const unrelatedFinding = persistedFinding({ id: "unrelated-finding", runId: "older-review-run", title: "Unrelated" });

    expect(displayFindingsForRun(run, [unrelatedFinding, selectedFinding])).toEqual([selectedFinding]);
  });

  test("derives immutable display findings from valid structured output when an older run has no persisted findings", () => {
    const run = reviewerRun({ id: "older-review-run" });
    const unrelatedFinding = persistedFinding({ runId: "review-run" });

    const findings = displayFindingsForRun(run, [unrelatedFinding]);

    expect(findings).toMatchObject([{
      id: "structured:older-review-run:0",
      taskId: "task-1",
      runId: "older-review-run",
      severity: "P1",
      selected: true,
      dismissed: false,
      userNote: null,
      createdAt: "2026-07-18T00:01:00.000Z",
    }]);
    expect(Object.isFrozen(findings)).toBe(true);
    expect(Object.isFrozen(findings[0])).toBe(true);
  });
});
