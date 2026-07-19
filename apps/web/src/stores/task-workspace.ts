import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  AgentEvent,
  AgentRun,
  ApprovalDecisionRequest,
  ApprovalRequest,
  CreateTaskMessageRequest,
  FindingSelectionMode,
  GitFileDiffResponse,
  GitFileStatus,
  ReviewFinding,
  Task,
  TaskAttachmentMetadata,
  TaskMessage,
  UpdateFindingRequest,
} from "@local-pair-review/shared";
import { ApiClientError } from "../api/client";
import { apiEndpoints } from "../api/endpoints";
import { TaskEventController } from "../realtime/task-events";
import { browserNotificationController } from "../realtime/browser-notification-runtime";
import { shouldApplyRunUpdate, WorkspaceRefreshGuard } from "./workspace-refresh-guard";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected local server error.";
}

function webSocketUrl(): string {
  const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${globalThis.location?.host ?? "127.0.0.1:3000"}/ws`;
}

// Long-running tasks replay their full persisted history on load; keep only the most
// recent window in memory so the tab cannot grow unbounded.
const MAX_TASK_EVENTS = 5000;
const FEEDBACK_DRAFT_SAVE_DELAY_MS = 250;

export function latestFeedbackReviewRun(runs: AgentRun[], _findings: ReviewFinding[]): AgentRun | null {
  return runs.filter((run) => (
    run.runType === "reviewer"
    && run.status === "completed"
    && run.reviewParseStatus === "succeeded"
  )).at(-1) ?? null;
}

export const useTaskWorkspaceStore = defineStore("task-workspace", () => {
  const task = ref<Task | null>(null);
  const runs = ref<AgentRun[]>([]);
  const findings = ref<ReviewFinding[]>([]);
  const messages = ref<TaskMessage[]>([]);
  const attachments = ref<TaskAttachmentMetadata[]>([]);
  const approvals = ref<ApprovalRequest[]>([]);
  const approvalErrors = ref<Record<string, string>>({});
  const files = ref<GitFileStatus[]>([]);
  const selectedPath = ref<string | null>(null);
  const selectedDiff = ref<GitFileDiffResponse | null>(null);
  const events = ref<AgentEvent[]>([]);
  const feedbackText = ref("");
  const feedbackDraftRunId = ref<string | null>(null);
  const loading = ref(false);
  const repositoryLoading = ref(false);
  const busy = ref(false);
  const sendingMessage = ref(false);
  const connected = ref(false);
  const error = ref<string | null>(null);
  const repositoryError = ref<string | null>(null);
  const diffError = ref<string | null>(null);
  const staleFeedback = ref(false);
  const reviewSnapshotStale = ref(false);
  let controller: TaskEventController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let feedbackDraftTimer: ReturnType<typeof setTimeout> | null = null;
  let feedbackDraftQueue: Promise<void> = Promise.resolve();
  let notificationQueue: Promise<void> = Promise.resolve();
  let messageSendInFlight: {
    context: ActionContext;
    operation: Promise<TaskMessage | undefined>;
  } | null = null;
  let generation = 0;
  let repositoryRequest = 0;
  const refreshGuard = new WorkspaceRefreshGuard();

  const activeRun = computed(() => runs.value.find((run) => run.status === "queued" || run.status === "running") ?? null);
  const feedbackReviewRun = computed(() => latestFeedbackReviewRun(runs.value, findings.value));
  const selectedFindings = computed(() => {
    const runId = feedbackReviewRun.value?.id;
    return runId
      ? findings.value.filter((finding) => finding.runId === runId && finding.selected && !finding.dismissed)
      : [];
  });

  interface ActionContext {
    generation: number;
    taskId: string;
  }

  function captureAction(): ActionContext | null {
    return task.value ? { generation, taskId: task.value.id } : null;
  }

  function isCurrent(context: ActionContext): boolean {
    return context.generation === generation && task.value?.id === context.taskId;
  }

  function clearFeedbackDraftTimer(): void {
    if (feedbackDraftTimer) clearTimeout(feedbackDraftTimer);
    feedbackDraftTimer = null;
  }

  function queueFeedbackDraftSave(context: ActionContext, reviewRunId: string, finalText: string): Promise<void> {
    const save = feedbackDraftQueue.then(async () => {
      try {
        await apiEndpoints.saveFeedbackDraft(context.taskId, reviewRunId, { finalText });
      } catch (problem) {
        if (isCurrent(context) && feedbackReviewRun.value?.id === reviewRunId) error.value = message(problem);
      }
    });
    feedbackDraftQueue = save.catch(() => undefined);
    return save;
  }

  function flushFeedbackDraft(): Promise<void> {
    if (!feedbackDraftTimer) return feedbackDraftQueue;
    clearFeedbackDraftTimer();
    const context = captureAction();
    const reviewRunId = feedbackDraftRunId.value;
    if (!context || !reviewRunId) return feedbackDraftQueue;
    return queueFeedbackDraftSave(context, reviewRunId, feedbackText.value);
  }

  function updateFeedbackText(finalText: string): void {
    feedbackText.value = finalText;
    const context = captureAction();
    const reviewRunId = feedbackReviewRun.value?.id;
    feedbackDraftRunId.value = reviewRunId ?? null;
    clearFeedbackDraftTimer();
    if (!context || !reviewRunId) return;
    feedbackDraftTimer = setTimeout(() => {
      feedbackDraftTimer = null;
      void queueFeedbackDraftSave(context, reviewRunId, finalText);
    }, FEEDBACK_DRAFT_SAVE_DELAY_MS);
  }

  function mergeRun(run: AgentRun): boolean {
    const index = runs.value.findIndex((candidate) => candidate.id === run.id);
    if (!shouldApplyRunUpdate(index === -1 ? undefined : runs.value[index], run)) return false;
    if (index === -1) runs.value.push(run); else runs.value[index] = run;
    refreshGuard.mutate();
    return true;
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh(); }, 80);
  }

  function canApplyRefresh(token: ReturnType<WorkspaceRefreshGuard["begin"]>, refreshGeneration: number, taskId: string): boolean {
    return refreshGeneration === generation && task.value?.id === taskId
      && refreshGuard.shouldApply(token, scheduleRefresh);
  }

  async function consumeNotificationEvent(event: AgentEvent, context: ActionContext): Promise<void> {
    if (!isCurrent(context)) return;
    let run = runs.value.find((candidate) => candidate.id === event.runId) ?? null;
    if (!run && event.type === "run_completed") {
      let loadedRuns: AgentRun[];
      try {
        loadedRuns = await apiEndpoints.listRuns(context.taskId);
      } catch {
        return;
      }
      if (!isCurrent(context)) return;
      for (const loadedRun of loadedRuns) mergeRun(loadedRun);
      run = runs.value.find((candidate) => candidate.id === event.runId) ?? null;
    }
    if (!run || !isCurrent(context)) return;
    const role = run.runType.startsWith("reviewer") ? "reviewer" : "developer";
    browserNotificationController.consumePersistedEvent({ event, role, taskTitle: task.value!.title });
  }

  function queueNotificationEvent(event: AgentEvent, context: ActionContext): void {
    notificationQueue = notificationQueue
      .catch(() => undefined)
      .then(() => consumeNotificationEvent(event, context));
  }

  function connect(taskId: string, connectionGeneration: number): void {
    controller?.stop();
    connected.value = false;
    controller = new TaskEventController({
      url: webSocketUrl(),
      onEvent(event) {
        if (connectionGeneration !== generation || task.value?.id !== taskId) return;
        // TaskEventController delivers events deduplicated and in ascending sequence
        // order, so an ordered O(1) append replaces the previous per-event scan + sort.
        const last = events.value.at(-1);
        if (last && event.sequence <= last.sequence) return;
        events.value.push(event);
        if (events.value.length > MAX_TASK_EVENTS) events.value.splice(0, events.value.length - MAX_TASK_EVENTS);
        queueNotificationEvent(event, { generation: connectionGeneration, taskId });
        if ([
          "run_completed", "run_failed", "run_cancelled", "run_interrupted", "review_parsed", "review_parse_failed",
          "message_queued", "message_delivered", "message_failed", "approval_requested", "approval_resolved",
        ].includes(event.type)) scheduleRefresh();
      },
      onTerminalEvent() {
        if (connectionGeneration === generation && task.value?.id === taskId) scheduleRefresh();
      },
      onConnectionChange(isConnected) {
        if (connectionGeneration === generation && task.value?.id === taskId) connected.value = isConnected;
      },
      onError(problem) {
        if (connectionGeneration !== generation || task.value?.id !== taskId) return;
        connected.value = false;
        error.value = `Activity stream: ${message(problem)}`;
      },
    });
    controller.start(taskId, 0);
  }

  interface RepositoryLoadContext extends ActionContext {
    request: number;
  }

  function beginRepositoryLoad(taskId: string): RepositoryLoadContext {
    repositoryLoading.value = true;
    repositoryError.value = null;
    diffError.value = null;
    return { generation, taskId, request: ++repositoryRequest };
  }

  function isCurrentRepository(context: RepositoryLoadContext): boolean {
    return isCurrent(context) && context.request === repositoryRequest;
  }

  function applyRepositoryStatus(
    context: RepositoryLoadContext,
    loadedTask: Task,
    loadedRuns: AgentRun[],
    gitStatus: Awaited<ReturnType<typeof apiEndpoints.getGitStatus>>,
    preferredPath: string | null,
  ): string | null {
    if (!isCurrentRepository(context)) return null;
    files.value = gitStatus.files;
    reviewSnapshotStale.value = loadedRuns.some((run) => run.runType === "reviewer")
      && Boolean(loadedTask.latestSnapshotHash && gitStatus.snapshotHash && loadedTask.latestSnapshotHash !== gitStatus.snapshotHash);
    const path = preferredPath && gitStatus.files.some((file) => file.path === preferredPath)
      ? preferredPath
      : gitStatus.files[0]?.path ?? null;
    selectedPath.value = path;
    selectedDiff.value = null;
    return path;
  }

  async function loadRepository(loadedTask: Task, loadedRuns: AgentRun[], preferredPath: string | null): Promise<void> {
    const context = beginRepositoryLoad(loadedTask.id);
    let path = preferredPath;
    try {
      let gitStatus;
      try {
        gitStatus = await apiEndpoints.getGitStatus(loadedTask.id);
      } catch (problem) {
        if (isCurrentRepository(context)) {
          files.value = [];
          selectedPath.value = null;
          selectedDiff.value = null;
          reviewSnapshotStale.value = false;
          repositoryError.value = message(problem);
        }
        return;
      }
      path = applyRepositoryStatus(context, loadedTask, loadedRuns, gitStatus, path);
      if (!path || !isCurrentRepository(context)) return;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const diff = await apiEndpoints.getGitFileDiff(loadedTask.id, path);
          if (isCurrentRepository(context) && selectedPath.value === path) selectedDiff.value = diff;
          return;
        } catch (problem) {
          if (attempt === 1) {
            if (isCurrentRepository(context)) {
              selectedDiff.value = null;
              diffError.value = message(problem);
            }
            return;
          }
          try {
            gitStatus = await apiEndpoints.getGitStatus(loadedTask.id);
          } catch (statusProblem) {
            if (isCurrentRepository(context)) {
              files.value = [];
              selectedPath.value = null;
              selectedDiff.value = null;
              reviewSnapshotStale.value = false;
              repositoryError.value = message(statusProblem);
            }
            return;
          }
          path = applyRepositoryStatus(context, loadedTask, loadedRuns, gitStatus, path);
          if (!path || !isCurrentRepository(context)) return;
        }
      }
    } finally {
      if (isCurrentRepository(context)) repositoryLoading.value = false;
    }
  }

  async function load(taskId: string): Promise<void> {
    void flushFeedbackDraft();
    const loadGeneration = ++generation;
    controller?.stop();
    controller = null;
    connected.value = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    loading.value = true;
    repositoryLoading.value = false;
    busy.value = false;
    sendingMessage.value = false;
    messageSendInFlight = null;
    notificationQueue = Promise.resolve();
    error.value = null;
    repositoryError.value = null;
    diffError.value = null;
    staleFeedback.value = false;
    reviewSnapshotStale.value = false;
    feedbackText.value = "";
    feedbackDraftRunId.value = null;
    events.value = [];
    task.value = null;
    runs.value = [];
    findings.value = [];
    messages.value = [];
    attachments.value = [];
    approvals.value = [];
    approvalErrors.value = {};
    files.value = [];
    selectedPath.value = null;
    selectedDiff.value = null;
    try {
      const [loadedTask, loadedRuns, loadedFindings, loadedMessages, loadedAttachments, loadedApprovals] = await Promise.all([
        apiEndpoints.getTask(taskId), apiEndpoints.listRuns(taskId), apiEndpoints.listFindings(taskId),
        (apiEndpoints.listMessages?.(taskId) ?? Promise.resolve([])).catch(() => []),
        (apiEndpoints.listAttachments?.(taskId) ?? Promise.resolve([])).catch(() => []),
        (apiEndpoints.listApprovals?.(taskId) ?? Promise.resolve([])).catch(() => []),
      ]);
      if (loadGeneration !== generation) return;
      const reviewRun = latestFeedbackReviewRun(loadedRuns, loadedFindings);
      task.value = loadedTask;
      runs.value = loadedRuns;
      findings.value = loadedFindings;
      messages.value = loadedMessages;
      attachments.value = loadedAttachments;
      approvals.value = loadedApprovals;
      feedbackDraftRunId.value = reviewRun?.id ?? null;
      connect(taskId, loadGeneration);
      loading.value = false;

      const repository = loadRepository(loadedTask, loadedRuns, null);
      try {
        const draftResponse = reviewRun
          ? await apiEndpoints.getFeedbackDraft(taskId, reviewRun.id)
          : { draft: null };
        if (loadGeneration === generation) feedbackText.value = draftResponse.draft?.finalText ?? "";
      } catch (problem) {
        if (loadGeneration === generation) error.value = message(problem);
      }
      await repository;
    } catch (problem) {
      if (loadGeneration === generation) error.value = message(problem);
    } finally {
      if (loadGeneration === generation) loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (!task.value) return;
    const refreshToken = refreshGuard.begin();
    const refreshGeneration = generation;
    const taskId = task.value.id;
    try {
      const [loadedTask, loadedRuns, loadedFindings, loadedMessages, loadedAttachments, loadedApprovals] = await Promise.all([
        apiEndpoints.getTask(taskId), apiEndpoints.listRuns(taskId), apiEndpoints.listFindings(taskId),
        (apiEndpoints.listMessages?.(taskId) ?? Promise.resolve([])).catch(() => []),
        (apiEndpoints.listAttachments?.(taskId) ?? Promise.resolve([])).catch(() => []),
        (apiEndpoints.listApprovals?.(taskId) ?? Promise.resolve([])).catch(() => []),
      ]);
      const reviewRun = latestFeedbackReviewRun(loadedRuns, loadedFindings);
      const draftChanged = reviewRun?.id !== feedbackDraftRunId.value;
      if (draftChanged) await flushFeedbackDraft();
      const draftResponse = draftChanged && reviewRun
        ? await apiEndpoints.getFeedbackDraft(taskId, reviewRun.id)
        : null;
      if (!canApplyRefresh(refreshToken, refreshGeneration, taskId)) return;
      task.value = loadedTask;
      runs.value = loadedRuns;
      findings.value = loadedFindings;
      messages.value = loadedMessages;
      attachments.value = loadedAttachments;
      approvals.value = loadedApprovals;
      if (draftChanged) {
        clearFeedbackDraftTimer();
        feedbackDraftRunId.value = reviewRun?.id ?? null;
        feedbackText.value = draftResponse?.draft?.finalText ?? "";
      }
      await loadRepository(loadedTask, loadedRuns, selectedPath.value);
    } catch (problem) {
      if (canApplyRefresh(refreshToken, refreshGeneration, taskId)) error.value = message(problem);
    }
  }

  async function action<T>(context: ActionContext, operation: () => Promise<T>): Promise<T | undefined> {
    busy.value = true;
    error.value = null;
    try {
      const result = await operation();
      return isCurrent(context) ? result : undefined;
    } catch (problem) {
      if (isCurrent(context)) error.value = message(problem);
      return undefined;
    } finally {
      if (isCurrent(context)) busy.value = false;
    }
  }

  async function develop(prompt?: string): Promise<void> {
    const context = captureAction();
    if (!context) return;
    await flushFeedbackDraft();
    const response = await action(context, () => apiEndpoints.developTask(context.taskId, prompt ? { prompt } : {}));
    if (response && isCurrent(context) && mergeRun(response.run)) task.value = response.task;
  }

  async function review(): Promise<void> {
    const context = captureAction();
    if (!context) return;
    await flushFeedbackDraft();
    const response = await action(context, () => apiEndpoints.reviewTask(context.taskId));
    if (response && isCurrent(context) && mergeRun(response.run)) task.value = response.task;
  }

  async function cancel(runId: string): Promise<void> {
    const context = captureAction();
    if (!context) return;
    const run = await action(context, () => apiEndpoints.cancelRun(runId));
    if (run && isCurrent(context)) { mergeRun(run); await refresh(); }
  }

  async function complete(): Promise<void> {
    const context = captureAction();
    if (!context) return;
    await flushFeedbackDraft();
    const completed = await action(context, () => apiEndpoints.completeTask(context.taskId));
    if (completed && isCurrent(context)) {
      task.value = completed;
      refreshGuard.mutate();
    }
  }

  async function updateFinding(id: string, changes: UpdateFindingRequest, regeneratePreview = false): Promise<void> {
    const context = captureAction();
    if (!context) return;
    const feedbackBeforeUpdate = feedbackText.value;
    const updated = await action(context, () => apiEndpoints.updateFinding(id, changes));
    if (updated && isCurrent(context)) {
      const index = findings.value.findIndex((finding) => finding.id === id);
      if (index !== -1) {
        findings.value[index] = updated;
        refreshGuard.mutate();
      }
      if (regeneratePreview && feedbackText.value === feedbackBeforeUpdate) {
        const reviewRun = feedbackReviewRun.value;
        if (!reviewRun) return;
        await flushFeedbackDraft();
        const selectedFindingIds = selectedFindings.value.map((finding) => finding.id);
        const preview = await action(context, () => apiEndpoints.previewFeedback(context.taskId, {
          sourceReviewRunId: reviewRun.id,
          selectedFindingIds,
        }));
        if (preview && isCurrent(context) && feedbackText.value === feedbackBeforeUpdate) {
          feedbackDraftRunId.value = reviewRun.id;
          feedbackText.value = preview.finalText;
        }
      }
    }
  }

  async function selectMode(mode: FindingSelectionMode): Promise<void> {
    const context = captureAction();
    const reviewRun = feedbackReviewRun.value;
    if (!context || !reviewRun) return;
    const selected = await action(context, () => apiEndpoints.selectFindings(context.taskId, {
      sourceReviewRunId: reviewRun.id,
      mode,
    }));
    if (selected && isCurrent(context)) {
      const selectedById = new Map(selected.map((finding) => [finding.id, finding]));
      findings.value = findings.value.map((finding) => selectedById.get(finding.id) ?? finding);
      refreshGuard.mutate();
    }
  }

  async function previewFeedback(): Promise<void> {
    const context = captureAction();
    const reviewRun = feedbackReviewRun.value;
    if (!context || !reviewRun) return;
    await flushFeedbackDraft();
    const selectedFindingIds = selectedFindings.value.map((finding) => finding.id);
    const preview = await action(context, () => apiEndpoints.previewFeedback(context.taskId, {
      sourceReviewRunId: reviewRun.id,
      selectedFindingIds,
    }));
    if (preview && isCurrent(context)) {
      feedbackDraftRunId.value = reviewRun.id;
      feedbackText.value = preview.finalText;
    }
  }

  async function sendFeedback(confirmStaleSnapshot = false): Promise<void> {
    const context = captureAction();
    const reviewRun = feedbackReviewRun.value;
    if (!context || !reviewRun) return;
    await flushFeedbackDraft();
    const selectedFindingIds = selectedFindings.value.map((finding) => finding.id);
    const finalText = feedbackText.value;
    busy.value = true;
    error.value = null;
    try {
      const response = await apiEndpoints.sendFeedback(context.taskId, {
        sourceReviewRunId: reviewRun.id,
        selectedFindingIds,
        finalText,
        confirmStaleSnapshot,
      });
      if (!isCurrent(context)) return;
      staleFeedback.value = false;
      if (mergeRun(response.run)) task.value = response.task;
    } catch (problem) {
      if (!isCurrent(context)) return;
      if (problem instanceof ApiClientError && problem.status === 409
        && (problem.details as { reason?: unknown } | undefined)?.reason === "STALE_SNAPSHOT") {
        staleFeedback.value = true;
        reviewSnapshotStale.value = true;
      } else {
        error.value = message(problem);
      }
    } finally {
      if (isCurrent(context)) busy.value = false;
    }
  }

  function sendMessage(input: CreateTaskMessageRequest): Promise<TaskMessage | undefined> {
    const context = captureAction();
    if (!context) return Promise.resolve(undefined);
    const current = messageSendInFlight;
    if (current && current.context.generation === context.generation && current.context.taskId === context.taskId) {
      return current.operation;
    }
    sendingMessage.value = true;
    error.value = null;
    let operation!: Promise<TaskMessage | undefined>;
    operation = (async () => {
      try {
        const sent = await apiEndpoints.sendMessage(context.taskId, input);
        if (!isCurrent(context)) return undefined;
        const index = messages.value.findIndex((candidate) => candidate.id === sent.id);
        if (index === -1) messages.value.push(sent); else messages.value[index] = sent;
        return sent;
      } catch (problem) {
        if (isCurrent(context)) error.value = message(problem);
        return undefined;
      } finally {
        if (messageSendInFlight?.operation === operation) {
          messageSendInFlight = null;
          if (isCurrent(context)) sendingMessage.value = false;
        }
      }
    })();
    messageSendInFlight = { context, operation };
    return operation;
  }

  async function decideApproval(approvalId: string, input: ApprovalDecisionRequest): Promise<void> {
    const context = captureAction();
    if (!context) return;
    const nextErrors = { ...approvalErrors.value };
    delete nextErrors[approvalId];
    approvalErrors.value = nextErrors;
    try {
      const decided = await apiEndpoints.decideApproval(approvalId, input);
      if (!isCurrent(context)) return;
      const index = approvals.value.findIndex((approval) => approval.id === approvalId);
      if (index === -1) approvals.value.push(decided); else approvals.value[index] = decided;
    } catch (problem) {
      if (isCurrent(context)) {
        try { approvals.value = await apiEndpoints.listApprovals(context.taskId); } catch { /* retain the last durable snapshot */ }
        approvalErrors.value = { ...approvalErrors.value, [approvalId]: message(problem) };
      }
    }
  }

  async function selectFile(path: string): Promise<void> {
    const currentTask = task.value;
    if (!currentTask) return;
    selectedPath.value = path;
    selectedDiff.value = null;
    await loadRepository(currentTask, runs.value, path);
  }

  function dispose(): void {
    void flushFeedbackDraft();
    generation += 1;
    controller?.stop(); controller = null; connected.value = false;
    repositoryRequest += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    task.value = null;
    attachments.value = [];
    loading.value = false;
    repositoryLoading.value = false;
    sendingMessage.value = false;
    messageSendInFlight = null;
    notificationQueue = Promise.resolve();
  }

  return {
    task, runs, findings, messages, attachments, approvals, approvalErrors, files, selectedPath, selectedDiff, events, feedbackText, loading, repositoryLoading, busy, sendingMessage, connected,
    error, repositoryError, diffError, staleFeedback, reviewSnapshotStale,
    activeRun, feedbackReviewRun, selectedFindings,
    load, refresh, develop, review, cancel, complete, updateFinding, selectMode, previewFeedback, updateFeedbackText, sendFeedback,
    sendMessage, decideApproval, selectFile, dispose,
  };
});
