import { describe, expect, test } from "bun:test";
import type { AgentRun, ReviewFinding } from "@local-pair-review/shared";
import { latestFeedbackReviewRun } from "../../apps/web/src/stores/task-workspace";

function reviewRun(id: string, reviewParseStatus: AgentRun["reviewParseStatus"]): AgentRun {
  return {
    id,
    taskId: "task-1",
    projectId: "project-1",
    provider: "claude",
    runType: "reviewer",
    status: "completed",
    reviewParseStatus,
    externalSessionId: `session-${id}`,
    processId: null,
    exitCode: 0,
    prompt: "review",
    finalMessage: "done",
    structuredOutput: null,
    errorMessage: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    finishedAt: "2026-07-18T00:00:01.000Z",
  };
}

function finding(runId: string): ReviewFinding {
  return {
    id: "finding-1",
    taskId: "task-1",
    runId,
    severity: "P1",
    title: "Finding",
    description: "Problem",
    suggestion: "Fix",
    file: null,
    startLine: null,
    endLine: null,
    selected: true,
    dismissed: false,
    userNote: "Keep this note",
    createdAt: "2026-07-18T00:00:02.000Z",
  };
}

describe("latestFeedbackReviewRun", () => {
  test("uses the successful review that owns retained findings after a later parse failure", () => {
    const successful = reviewRun("review-success", "succeeded");
    const failed = reviewRun("review-failed", "failed");

    expect(latestFeedbackReviewRun([successful, failed], [finding(successful.id)])?.id).toBe(successful.id);
  });

  test("uses the latest successful review when it produced no findings", () => {
    const earlier = reviewRun("review-earlier", "succeeded");
    const latest = reviewRun("review-latest", "succeeded");

    expect(latestFeedbackReviewRun([earlier, latest], [])?.id).toBe(latest.id);
  });

  test("uses the latest successful review while retaining findings from every review", () => {
    const earlier = reviewRun("review-earlier", "succeeded");
    const latest = reviewRun("review-latest", "succeeded");

    expect(latestFeedbackReviewRun(
      [earlier, latest],
      [finding(earlier.id), { ...finding(latest.id), id: "finding-latest" }],
    )?.id).toBe(latest.id);
  });
});
