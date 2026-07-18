import { describe, expect, test } from "bun:test";
import type { AgentRun } from "@local-pair-review/shared";
import { buildRunHistory, selectRunAfterUpdate } from "../../apps/web/src/components/run-history";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    taskId: "task-1",
    projectId: "project-1",
    provider: "codex",
    runType: "developer_initial",
    status: "completed",
    reviewParseStatus: null,
    externalSessionId: "session-1",
    processId: null,
    exitCode: 0,
    prompt: "Implement the requested change.",
    finalMessage: "Done.",
    structuredOutput: null,
    errorMessage: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    finishedAt: "2026-07-18T00:01:00.000Z",
    ...overrides,
  };
}

const providerLabel = (provider: AgentRun["provider"]): string => provider === "codex" ? "Codex" : "Claude";

describe("buildRunHistory", () => {
  test("orders runs newest first and assigns role-local ordinals", () => {
    const entries = buildRunHistory([
      run({ id: "developer-1", startedAt: "2026-07-18T00:00:00.000Z" }),
      run({ id: "reviewer-1", provider: "claude", runType: "reviewer", startedAt: "2026-07-18T00:02:00.000Z" }),
      run({ id: "developer-2", runType: "developer_feedback", startedAt: "2026-07-18T00:04:00.000Z" }),
    ], providerLabel);

    expect(entries.map((entry) => entry.runId)).toEqual(["developer-2", "reviewer-1", "developer-1"]);
    expect(entries.map(({ roleLabel, roleOrdinal }) => ({ roleLabel, roleOrdinal }))).toEqual([
      { roleLabel: "Developer", roleOrdinal: 2 },
      { roleLabel: "Reviewer", roleOrdinal: 1 },
      { roleLabel: "Developer", roleOrdinal: 1 },
    ]);
    expect(entries[0]).toMatchObject({ providerLabel: "Codex", status: "completed", timestamp: "2026-07-18T00:04:00.000Z" });
  });

  test("summarizes the first non-empty prompt line", () => {
    const [entry] = buildRunHistory([run({ prompt: "\n  Implement the history rail\nwith keyboard support\n" })], providerLabel);

    expect(entry?.promptSummary).toBe("Implement the history rail");
  });
});

describe("selectRunAfterUpdate", () => {
  const initialRuns = [run({ id: "older" }), run({ id: "latest", startedAt: "2026-07-18T00:05:00.000Z" })];

  test("selects the latest run on initial load", () => {
    expect(selectRunAfterUpdate(null, [], initialRuns)).toBe("latest");
  });

  test("preserves a valid manual selection during an ordinary refresh", () => {
    expect(selectRunAfterUpdate("older", ["older", "latest"], initialRuns)).toBe("older");
  });

  test("falls back to the latest run when the current selection is absent", () => {
    expect(selectRunAfterUpdate("removed", ["older", "latest"], initialRuns)).toBe("latest");
  });

  test("selects a newly added run", () => {
    const runs = [...initialRuns, run({ id: "newest", startedAt: "2026-07-18T00:10:00.000Z" })];

    expect(selectRunAfterUpdate("older", ["older", "latest"], runs)).toBe("newest");
  });
});
