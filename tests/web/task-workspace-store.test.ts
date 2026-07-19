import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { AgentRun, ReviewFinding, Task } from "@local-pair-review/shared";
import { ApiClientError } from "../../apps/web/src/api/client";
import { apiEndpoints } from "../../apps/web/src/api/endpoints";
import { latestFeedbackReviewRun, useTaskWorkspaceStore } from "../../apps/web/src/stores/task-workspace";

const { createPinia } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pinia") as {
  createPinia(): Parameters<typeof useTaskWorkspaceStore>[0];
};
const originalEndpoints = { ...apiEndpoints };
const originalWebSocket = globalThis.WebSocket;

class SilentWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  send(): void {}
  close(): void {}
}

afterEach(() => {
  Object.assign(apiEndpoints, originalEndpoints);
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalWebSocket });
});

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

function task(): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Persisted task",
    originalPrompt: "Keep history readable",
    workingDirectory: "/missing/repository",
    baseCommit: "0123456789abcdef",
    latestSnapshotHash: null,
    status: "completed",
    developerProvider: "codex",
    reviewerProvider: "claude",
    developerSessionId: "developer-session",
    reviewerSessionId: "reviewer-session",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:03.000Z",
    completedAt: "2026-07-18T00:00:03.000Z",
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

describe("task workspace repository loading", () => {
  test("publishes persisted history when the repository is unavailable", async () => {
    const persistedRun = reviewRun("review-success", "succeeded");
    const persistedFinding = finding(persistedRun.id);
    let rejectRepository!: (error: unknown) => void;
    const repositoryStatus = new Promise<never>((_resolve, reject) => { rejectRepository = reject; });
    Object.assign(apiEndpoints, {
      getTask: async () => task(),
      listRuns: async () => [persistedRun],
      listFindings: async () => [persistedFinding],
      getFeedbackDraft: async () => ({ draft: null }),
      getGitStatus: async () => repositoryStatus,
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SilentWebSocket });
    const workspace = useTaskWorkspaceStore(createPinia());

    const loading = workspace.load("task-1");
    await Bun.sleep(0);

    expect(workspace.task?.id).toBe("task-1");
    expect(workspace.runs.map((run) => run.id)).toEqual([persistedRun.id]);
    expect(workspace.findings.map((item) => item.id)).toEqual([persistedFinding.id]);
    expect(workspace.error).toBeNull();
    expect(workspace.repositoryLoading).toBe(true);

    rejectRepository(new ApiClientError(
      422,
      "CLI_UNAVAILABLE",
      "Git cannot be executed for this repository.",
      { provider: "git" },
    ));
    await loading;

    expect(workspace.repositoryError).toContain("Git cannot be executed");
    expect(workspace.files).toEqual([]);
    workspace.dispose();
  });

  test("retries a status and file-diff race once without making the task unavailable", async () => {
    let statusCalls = 0;
    let diffCalls = 0;
    Object.assign(apiEndpoints, {
      getTask: async () => task(),
      listRuns: async () => [],
      listFindings: async () => [],
      getGitStatus: async () => {
        statusCalls += 1;
        return {
          clean: false,
          snapshotHash: `snapshot-${statusCalls}`,
          files: [{
            path: "changed.ts", previousPath: null, status: "modified", staged: false, tracked: true, binary: false,
          }],
        };
      },
      getGitFileDiff: async () => {
        diffCalls += 1;
        if (diffCalls === 1) throw new Error("File is not changed in this task");
        return {
          file: { path: "changed.ts", previousPath: null, status: "modified", staged: false, tracked: true, binary: false },
          patch: "patch",
          originalText: "before\n",
          modifiedText: "after\n",
        };
      },
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SilentWebSocket });
    const workspace = useTaskWorkspaceStore(createPinia());

    await workspace.load("task-1");

    expect(statusCalls).toBe(2);
    expect(diffCalls).toBe(2);
    expect(workspace.task?.id).toBe("task-1");
    expect(workspace.selectedDiff?.modifiedText).toBe("after\n");
    expect(workspace.error).toBeNull();
    expect(workspace.repositoryError).toBeNull();
    expect(workspace.diffError).toBeNull();
    workspace.dispose();
  });

  test("stops after one file-diff retry and keeps repository status available", async () => {
    let statusCalls = 0;
    let diffCalls = 0;
    const file = { path: "changed.ts", previousPath: null, status: "modified" as const, staged: false, tracked: true, binary: false };
    Object.assign(apiEndpoints, {
      getTask: async () => task(),
      listRuns: async () => [],
      listFindings: async () => [],
      getGitStatus: async () => {
        statusCalls += 1;
        return { clean: false, snapshotHash: "snapshot", files: [file] };
      },
      getGitFileDiff: async () => {
        diffCalls += 1;
        throw new Error("File changed during diff loading");
      },
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SilentWebSocket });
    const workspace = useTaskWorkspaceStore(createPinia());

    await workspace.load("task-1");

    expect(statusCalls).toBe(2);
    expect(diffCalls).toBe(2);
    expect(workspace.task?.id).toBe("task-1");
    expect(workspace.files).toEqual([file]);
    expect(workspace.selectedDiff).toBeNull();
    expect(workspace.diffError).toContain("File changed during diff loading");
    expect(workspace.repositoryError).toBeNull();
    expect(workspace.error).toBeNull();
    workspace.dispose();
  });
});
