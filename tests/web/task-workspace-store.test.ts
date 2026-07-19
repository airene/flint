import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { AgentEvent, AgentRun, CreateTaskMessageRequest, ReviewFinding, Task, TaskAttachmentMetadata, TaskMessage } from "@local-pair-review/shared";
import { ApiClientError } from "../../apps/web/src/api/client";
import { apiEndpoints } from "../../apps/web/src/api/endpoints";
import { browserNotificationController } from "../../apps/web/src/realtime/browser-notification-runtime";
import type { PersistedRunEvent } from "../../apps/web/src/realtime/browser-notifications";
import { latestFeedbackReviewRun, useTaskWorkspaceStore } from "../../apps/web/src/stores/task-workspace";

const { createPinia } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pinia") as {
  createPinia(): Parameters<typeof useTaskWorkspaceStore>[0];
};
const originalEndpoints = { ...apiEndpoints };
const originalWebSocket = globalThis.WebSocket;
const originalNotificationConsumer = browserNotificationController.consumePersistedEvent;

class SilentWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  send(): void {}
  close(): void {}
}

class CapturingWebSocket extends SilentWebSocket {
  static latest: CapturingWebSocket | null = null;
  constructor() {
    super();
    CapturingWebSocket.latest = this;
  }
}

afterEach(() => {
  Object.assign(apiEndpoints, originalEndpoints);
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalWebSocket });
  browserNotificationController.consumePersistedEvent = originalNotificationConsumer;
  CapturingWebSocket.latest = null;
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
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:03.000Z",
    completedAt: "2026-07-18T00:00:03.000Z",
  };
}

function developerFollowupRun(): AgentRun {
  return {
    id: "developer-followup-1",
    taskId: "task-1",
    projectId: "project-1",
    provider: "codex",
    runType: "developer_followup",
    status: "completed",
    reviewParseStatus: null,
    externalSessionId: "developer-session",
    processId: null,
    exitCode: 0,
    prompt: "Continue",
    finalMessage: "Done",
    structuredOutput: null,
    errorMessage: null,
    startedAt: "2026-07-18T00:00:04.000Z",
    finishedAt: "2026-07-18T00:00:05.000Z",
  };
}

function messageInput(): CreateTaskMessageRequest {
  return {
    targetRole: "developer",
    sourceReviewRunId: null,
    text: "Continue",
    deliveryMode: "queue",
    attachmentIds: [],
  };
}

function queuedMessage(): TaskMessage {
  return {
    id: "message-1",
    projectId: "project-1",
    taskId: "task-1",
    targetRole: "developer",
    sourceReviewRunId: null,
    text: "Continue",
    deliveryMode: "queue",
    status: "queued",
    createdAt: "2026-07-18T00:00:04.000Z",
    updatedAt: "2026-07-18T00:00:04.000Z",
    deliveredAt: null,
    errorMessage: null,
  };
}

function claimedAttachment(): TaskAttachmentMetadata {
  return {
    id: "attachment-1",
    projectId: "project-1",
    taskId: "task-1",
    messageId: "message-1",
    mediaType: "image/png",
    sizeBytes: 1024,
    createdAt: "2026-07-18T00:00:03.000Z",
    claimedAt: "2026-07-18T00:00:04.000Z",
  };
}

const LIVE_COMPLETION_TIMESTAMP = new Date(Date.now() + 60_000).toISOString();

function completionEvent(runId = "developer-followup-1"): AgentEvent {
  return {
    sequence: 1,
    timestamp: LIVE_COMPLETION_TIMESTAMP,
    projectId: "project-1",
    taskId: "task-1",
    runId,
    source: "system",
    type: "run_completed",
    payload: { finalMessage: "Done" },
  };
}

function sessionStartedEvent(): AgentEvent {
  return {
    sequence: 1,
    timestamp: LIVE_COMPLETION_TIMESTAMP,
    projectId: "project-1",
    taskId: "task-1",
    runId: "developer-initial-1",
    source: "claude",
    type: "session_started",
    payload: {
      parsed: {
        type: "system",
        subtype: "init",
        session_id: "claude-session-exact",
      },
    },
  };
}

function stubWorkspaceLoad(listRuns: () => Promise<AgentRun[]>): void {
  Object.assign(apiEndpoints, {
    getTask: async () => task(),
    listRuns,
    listFindings: async () => [],
    listMessages: async () => [],
    listApprovals: async () => [],
    getGitStatus: async () => ({ clean: true, snapshotHash: "snapshot", files: [] }),
  });
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

describe("task workspace message delivery", () => {
  test("coalesces concurrent message actions and exposes the in-flight state", async () => {
    let resolveMessage!: (message: TaskMessage) => void;
    const response = new Promise<TaskMessage>((resolve) => { resolveMessage = resolve; });
    let calls = 0;
    Object.assign(apiEndpoints, {
      sendMessage: async () => {
        calls += 1;
        return await response;
      },
    });
    const workspace = useTaskWorkspaceStore(createPinia());
    workspace.task = task();

    const first = workspace.sendMessage(messageInput());
    const duplicate = workspace.sendMessage(messageInput());

    expect(calls).toBe(1);
    expect(workspace.sendingMessage).toBe(true);
    resolveMessage(queuedMessage());
    expect(await duplicate).toEqual(await first);
    expect(workspace.sendingMessage).toBe(false);
    expect(workspace.messages).toEqual([queuedMessage()]);
  });

  test("unlocks message delivery after a failed action", async () => {
    let calls = 0;
    Object.assign(apiEndpoints, {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) throw new Error("delivery unavailable");
        return queuedMessage();
      },
    });
    const workspace = useTaskWorkspaceStore(createPinia());
    workspace.task = task();

    expect(await workspace.sendMessage(messageInput())).toBeUndefined();
    expect(workspace.sendingMessage).toBe(false);
    expect(await workspace.sendMessage(messageInput())).toEqual(queuedMessage());
    expect(calls).toBe(2);
  });

  test("refreshes claimed attachment metadata after an image message succeeds", async () => {
    let attachmentReads = 0;
    Object.assign(apiEndpoints, {
      sendMessage: async () => queuedMessage(),
      listAttachments: async () => {
        attachmentReads += 1;
        return [claimedAttachment()];
      },
    });
    const workspace = useTaskWorkspaceStore(createPinia());
    workspace.task = task();

    await workspace.sendMessage({ ...messageInput(), attachmentIds: [claimedAttachment().id] });

    expect(attachmentReads).toBe(1);
    expect(workspace.attachments).toEqual([claimedAttachment()]);
  });

  test("does not report a stale image send as successful after switching tasks", async () => {
    let resolveAttachments!: (attachments: TaskAttachmentMetadata[]) => void;
    let attachmentReadStarted = false;
    const attachmentRead = new Promise<TaskAttachmentMetadata[]>((resolve) => { resolveAttachments = resolve; });
    Object.assign(apiEndpoints, {
      sendMessage: async () => queuedMessage(),
      listAttachments: async () => {
        attachmentReadStarted = true;
        return await attachmentRead;
      },
    });
    const workspace = useTaskWorkspaceStore(createPinia());
    workspace.task = task();

    const sending = workspace.sendMessage({ ...messageInput(), attachmentIds: [claimedAttachment().id] });
    for (let attempt = 0; attempt < 10 && !attachmentReadStarted; attempt += 1) await Bun.sleep(0);
    workspace.dispose();
    workspace.task = { ...task(), id: "task-2" };
    resolveAttachments([claimedAttachment()]);

    expect(await sending).toBeUndefined();
    expect(workspace.attachments).toEqual([]);
  });
});

describe("task workspace live session refresh", () => {
  test("loads the persisted Developer session while the initial Run is still active", async () => {
    let taskReads = 0;
    const runningTask: Task = {
      ...task(),
      status: "developing",
      developerProvider: "claude",
      developerSessionId: null,
      completedAt: null,
    };
    const sessionTask: Task = { ...runningTask, developerSessionId: "claude-session-exact" };
    Object.assign(apiEndpoints, {
      getTask: async () => (++taskReads === 1 ? runningTask : sessionTask),
      listRuns: async () => [],
      listFindings: async () => [],
      listMessages: async () => [],
      listAttachments: async () => [],
      listApprovals: async () => [],
      getGitStatus: async () => ({ clean: true, snapshotHash: "snapshot", files: [] }),
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: CapturingWebSocket });
    const workspace = useTaskWorkspaceStore(createPinia());
    await workspace.load("task-1");
    const socket = CapturingWebSocket.latest!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ action: "subscribed", taskId: "task-1", afterSequence: 0 }) });

    socket.onmessage?.({ data: JSON.stringify({ action: "event", event: sessionStartedEvent() }) });
    for (let attempt = 0; attempt < 20 && taskReads < 2; attempt += 1) await Bun.sleep(10);

    expect(taskReads).toBe(2);
    expect(workspace.task?.status).toBe("developing");
    expect(workspace.task?.developerSessionId).toBe("claude-session-exact");
    workspace.dispose();
  });
});

describe("task workspace completion notifications", () => {
  test("refreshes a missing Run before resolving its role and notifying", async () => {
    let runReads = 0;
    const completedRun = developerFollowupRun();
    stubWorkspaceLoad(async () => (++runReads === 1 ? [] : [completedRun]));
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: CapturingWebSocket });
    const consumed: PersistedRunEvent[] = [];
    browserNotificationController.consumePersistedEvent = ((input) => {
      consumed.push(input);
      return true;
    }) as typeof browserNotificationController.consumePersistedEvent;
    const workspace = useTaskWorkspaceStore(createPinia());
    await workspace.load("task-1");
    const socket = CapturingWebSocket.latest!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ action: "subscribed", taskId: "task-1", afterSequence: 0 }) });

    socket.onmessage?.({ data: JSON.stringify({ action: "event", event: completionEvent() }) });
    for (let attempt = 0; attempt < 20 && consumed.length === 0; attempt += 1) await Bun.sleep(0);

    expect(runReads).toBe(2);
    expect(workspace.runs).toEqual([completedRun]);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ event: completionEvent(), role: "developer", taskTitle: task().title });
    expect((consumed[0] as PersistedRunEvent & { pageOpenedAt?: number }).pageOpenedAt).toBeInteger();
    workspace.dispose();
  });

  test("stays silent when a completed Run remains unknown after refresh", async () => {
    let runReads = 0;
    stubWorkspaceLoad(async () => { runReads += 1; return []; });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: CapturingWebSocket });
    let notifications = 0;
    browserNotificationController.consumePersistedEvent = (() => {
      notifications += 1;
      return true;
    }) as typeof browserNotificationController.consumePersistedEvent;
    const workspace = useTaskWorkspaceStore(createPinia());
    await workspace.load("task-1");
    const socket = CapturingWebSocket.latest!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ action: "subscribed", taskId: "task-1", afterSequence: 0 }) });

    socket.onmessage?.({ data: JSON.stringify({ action: "event", event: completionEvent("missing-run") }) });
    for (let attempt = 0; attempt < 20 && runReads < 2; attempt += 1) await Bun.sleep(0);

    expect(runReads).toBe(2);
    expect(notifications).toBe(0);
    workspace.dispose();
  });
});
