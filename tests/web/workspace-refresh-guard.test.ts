import { describe, expect, test } from "bun:test";
import type { AgentRun } from "@local-pair-review/shared";
import { WorkspaceRefreshGuard, shouldApplyRunUpdate } from "../../apps/web/src/stores/workspace-refresh-guard";

function run(status: AgentRun["status"]): AgentRun {
  return {
    id: "run-1",
    taskId: "task-1",
    projectId: "project-1",
    provider: "codex",
    runType: "developer_initial",
    status,
    reviewParseStatus: null,
    externalSessionId: null,
    processId: null,
    exitCode: null,
    prompt: "Implement the change.",
    finalMessage: null,
    structuredOutput: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
  };
}

describe("WorkspaceRefreshGuard", () => {
  test("supersedes older same-task refresh requests", () => {
    const guard = new WorkspaceRefreshGuard();
    const older = guard.begin();
    const newer = guard.begin();

    expect(guard.disposition(older)).toBe("superseded");
    expect(guard.disposition(newer)).toBe("apply");
  });

  test("requests a retry when a local mutation overtakes the latest refresh", () => {
    const guard = new WorkspaceRefreshGuard();
    const overtaken = guard.begin();
    let retries = 0;

    guard.mutate();

    expect(guard.disposition(overtaken)).toBe("retry");
    expect(guard.shouldApply(overtaken, () => { retries += 1; })).toBe(false);
    expect(retries).toBe(1);
    expect(guard.disposition(guard.begin())).toBe("apply");
  });
});

describe("shouldApplyRunUpdate", () => {
  test("does not regress a running or terminal run to an earlier status", () => {
    expect(shouldApplyRunUpdate(run("running"), run("queued"))).toBe(false);
    expect(shouldApplyRunUpdate(run("completed"), run("running"))).toBe(false);
    expect(shouldApplyRunUpdate(run("failed"), run("queued"))).toBe(false);
  });

  test("accepts forward progress and same-status detail updates", () => {
    expect(shouldApplyRunUpdate(run("queued"), run("running"))).toBe(true);
    expect(shouldApplyRunUpdate(run("running"), run("completed"))).toBe(true);
    expect(shouldApplyRunUpdate(run("completed"), run("completed"))).toBe(true);
  });
});
