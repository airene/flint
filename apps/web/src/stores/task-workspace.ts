import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  AgentEvent,
  AgentRun,
  FindingSelectionMode,
  GitFileDiffResponse,
  GitFileStatus,
  ReviewFinding,
  Task,
  UpdateFindingRequest,
} from "@local-pair-review/shared";
import { ApiClientError } from "../api/client";
import { apiEndpoints } from "../api/endpoints";
import { TaskEventController } from "../realtime/task-events";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected local server error.";
}

function webSocketUrl(): string {
  const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${globalThis.location?.host ?? "127.0.0.1:3000"}/ws`;
}

export function latestFeedbackReviewRun(runs: AgentRun[], findings: ReviewFinding[]): AgentRun | null {
  return runs.filter((run) => (
    run.runType === "reviewer"
    && run.status === "completed"
    && run.reviewParseStatus === "succeeded"
    && (findings.length === 0 || findings.every((finding) => finding.runId === run.id))
  )).at(-1) ?? null;
}

export const useTaskWorkspaceStore = defineStore("task-workspace", () => {
  const task = ref<Task | null>(null);
  const runs = ref<AgentRun[]>([]);
  const findings = ref<ReviewFinding[]>([]);
  const files = ref<GitFileStatus[]>([]);
  const selectedPath = ref<string | null>(null);
  const selectedDiff = ref<GitFileDiffResponse | null>(null);
  const events = ref<AgentEvent[]>([]);
  const feedbackText = ref("");
  const loading = ref(false);
  const busy = ref(false);
  const connected = ref(false);
  const error = ref<string | null>(null);
  const staleFeedback = ref(false);
  const reviewSnapshotStale = ref(false);
  let controller: TaskEventController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const activeRun = computed(() => runs.value.find((run) => run.status === "queued" || run.status === "running") ?? null);
  const latestReviewRun = computed(() => runs.value.filter((run) => run.runType === "reviewer").at(-1) ?? null);
  const feedbackReviewRun = computed(() => latestFeedbackReviewRun(runs.value, findings.value));
  const selectedFindings = computed(() => findings.value.filter((finding) => finding.selected && !finding.dismissed));

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

  function mergeRun(run: AgentRun): void {
    const index = runs.value.findIndex((candidate) => candidate.id === run.id);
    if (index === -1) runs.value.push(run); else runs.value[index] = run;
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh(); }, 80);
  }

  function connect(taskId: string, connectionGeneration: number): void {
    controller?.stop();
    connected.value = false;
    controller = new TaskEventController({
      url: webSocketUrl(),
      onEvent(event) {
        if (connectionGeneration !== generation || task.value?.id !== taskId) return;
        if (events.value.some((candidate) => candidate.taskId === event.taskId && candidate.sequence === event.sequence)) return;
        events.value.push(event);
        events.value.sort((left, right) => left.sequence - right.sequence);
        if (["run_completed", "run_failed", "run_cancelled", "run_interrupted", "review_parsed", "review_parse_failed"].includes(event.type)) scheduleRefresh();
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

  async function load(taskId: string): Promise<void> {
    const loadGeneration = ++generation;
    controller?.stop();
    controller = null;
    connected.value = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    loading.value = true;
    busy.value = false;
    error.value = null;
    staleFeedback.value = false;
    reviewSnapshotStale.value = false;
    feedbackText.value = "";
    events.value = [];
    task.value = null;
    runs.value = [];
    findings.value = [];
    files.value = [];
    selectedPath.value = null;
    selectedDiff.value = null;
    try {
      const [loadedTask, loadedRuns, loadedFindings, gitStatus] = await Promise.all([
        apiEndpoints.getTask(taskId), apiEndpoints.listRuns(taskId), apiEndpoints.listFindings(taskId), apiEndpoints.getGitStatus(taskId),
      ]);
      const preferred = gitStatus.files[0]?.path ?? null;
      const diff = preferred ? await apiEndpoints.getGitFileDiff(taskId, preferred) : null;
      if (loadGeneration !== generation) return;
      task.value = loadedTask;
      runs.value = loadedRuns;
      findings.value = loadedFindings;
      files.value = gitStatus.files;
      reviewSnapshotStale.value = loadedRuns.some((run) => run.runType === "reviewer")
        && Boolean(loadedTask.latestSnapshotHash && gitStatus.snapshotHash && loadedTask.latestSnapshotHash !== gitStatus.snapshotHash);
      selectedPath.value = preferred;
      selectedDiff.value = diff;
      connect(taskId, loadGeneration);
    } catch (problem) {
      if (loadGeneration === generation) error.value = message(problem);
    } finally {
      if (loadGeneration === generation) loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (!task.value) return;
    const refreshGeneration = generation;
    const taskId = task.value.id;
    try {
      const [loadedTask, loadedRuns, loadedFindings, gitStatus] = await Promise.all([
        apiEndpoints.getTask(taskId), apiEndpoints.listRuns(taskId), apiEndpoints.listFindings(taskId), apiEndpoints.getGitStatus(taskId),
      ]);
      if (refreshGeneration !== generation || task.value?.id !== taskId) return;
      task.value = loadedTask;
      runs.value = loadedRuns;
      findings.value = loadedFindings;
      files.value = gitStatus.files;
      reviewSnapshotStale.value = loadedRuns.some((run) => run.runType === "reviewer")
        && Boolean(loadedTask.latestSnapshotHash && gitStatus.snapshotHash && loadedTask.latestSnapshotHash !== gitStatus.snapshotHash);
      if (selectedPath.value && !files.value.some((file) => file.path === selectedPath.value)) selectedPath.value = files.value[0]?.path ?? null;
      const path = selectedPath.value;
      const diff = path ? await apiEndpoints.getGitFileDiff(taskId, path) : null;
      if (refreshGeneration === generation && task.value?.id === taskId) selectedDiff.value = diff;
    } catch (problem) {
      if (refreshGeneration === generation && task.value?.id === taskId) error.value = message(problem);
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
    const response = await action(context, () => apiEndpoints.developTask(context.taskId, prompt ? { prompt } : {}));
    if (response && isCurrent(context)) { task.value = response.task; mergeRun(response.run); }
  }

  async function review(): Promise<void> {
    const context = captureAction();
    if (!context) return;
    const response = await action(context, () => apiEndpoints.reviewTask(context.taskId));
    if (response && isCurrent(context)) { task.value = response.task; mergeRun(response.run); }
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
    const completed = await action(context, () => apiEndpoints.completeTask(context.taskId));
    if (completed && isCurrent(context)) task.value = completed;
  }

  async function updateFinding(id: string, changes: UpdateFindingRequest, regeneratePreview = false): Promise<void> {
    const context = captureAction();
    if (!context) return;
    const feedbackBeforeUpdate = feedbackText.value;
    const updated = await action(context, () => apiEndpoints.updateFinding(id, changes));
    if (updated && isCurrent(context)) {
      const index = findings.value.findIndex((finding) => finding.id === id);
      if (index !== -1) findings.value[index] = updated;
      if (regeneratePreview && feedbackText.value === feedbackBeforeUpdate) {
        const reviewRun = feedbackReviewRun.value;
        if (!reviewRun) return;
        const selectedFindingIds = selectedFindings.value.map((finding) => finding.id);
        const preview = await action(context, () => apiEndpoints.previewFeedback(context.taskId, {
          sourceReviewRunId: reviewRun.id,
          selectedFindingIds,
        }));
        if (preview && isCurrent(context) && feedbackText.value === feedbackBeforeUpdate) feedbackText.value = preview.finalText;
      }
    }
  }

  async function selectMode(mode: FindingSelectionMode): Promise<void> {
    const context = captureAction();
    if (!context) return;
    const selected = await action(context, () => apiEndpoints.selectFindings(context.taskId, { mode }));
    if (selected && isCurrent(context)) findings.value = selected;
  }

  async function previewFeedback(): Promise<void> {
    const context = captureAction();
    const reviewRun = feedbackReviewRun.value;
    if (!context || !reviewRun) return;
    const selectedFindingIds = selectedFindings.value.map((finding) => finding.id);
    const preview = await action(context, () => apiEndpoints.previewFeedback(context.taskId, {
      sourceReviewRunId: reviewRun.id,
      selectedFindingIds,
    }));
    if (preview && isCurrent(context)) feedbackText.value = preview.finalText;
  }

  async function sendFeedback(confirmStaleSnapshot = false): Promise<void> {
    const context = captureAction();
    const reviewRun = feedbackReviewRun.value;
    if (!context || !reviewRun) return;
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
      task.value = response.task; mergeRun(response.run);
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

  async function selectFile(path: string): Promise<void> {
    const context = captureAction();
    if (!context) return;
    selectedPath.value = path;
    try {
      const diff = await apiEndpoints.getGitFileDiff(context.taskId, path);
      if (isCurrent(context) && selectedPath.value === path) selectedDiff.value = diff;
    } catch (problem) {
      if (isCurrent(context)) error.value = message(problem);
    }
  }

  function dispose(): void {
    generation += 1;
    controller?.stop(); controller = null; connected.value = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    task.value = null;
    loading.value = false;
  }

  return {
    task, runs, findings, files, selectedPath, selectedDiff, events, feedbackText, loading, busy, connected, error, staleFeedback, reviewSnapshotStale,
    activeRun, latestReviewRun, feedbackReviewRun, selectedFindings,
    load, refresh, develop, review, cancel, complete, updateFinding, selectMode, previewFeedback, sendFeedback, selectFile, dispose,
  };
});
