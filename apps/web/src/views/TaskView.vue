<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import type { ReviewFinding, UpdateFindingRequest } from "@local-pair-review/shared";
import ActivityPanel from "../components/ActivityPanel.vue";
import AgentPanel from "../components/AgentPanel.vue";
import DiffPanel from "../components/DiffPanel.vue";
import ErrorBanner from "../components/ErrorBanner.vue";
import FeedbackEditor from "../components/FeedbackEditor.vue";
import ReviewPanel from "../components/ReviewPanel.vue";
import TaskHeader from "../components/TaskHeader.vue";
import { useSystemStore } from "../stores/system";
import { useTaskWorkspaceStore } from "../stores/task-workspace";

const route = useRoute();
const workspace = useTaskWorkspaceStore();
const system = useSystemStore();
const codexRuns = computed(() => workspace.runs.filter((run) => run.provider === "codex"));
const claudeRuns = computed(() => workspace.runs.filter((run) => run.provider === "claude"));
const latestReviewStale = computed(() => {
  if (workspace.reviewSnapshotStale) return true;
  const runId = workspace.latestReviewRun?.id;
  if (!runId) return false;
  const event = workspace.events.filter((candidate) => candidate.runId === runId
    && (candidate.type === "review_parsed" || candidate.type === "review_parse_failed")).at(-1);
  return Boolean((event?.payload as { stale?: unknown } | undefined)?.stale);
});
const runtimeWarnings = computed(() => {
  const status = system.cliStatus;
  if (!status) return [];
  return ([
    ["Codex", status.codex],
    ["Claude", status.claude],
    ["Git", status.git],
  ] as const).filter(([, value]) => !value.installed || value.authentication === "unauthenticated")
    .map(([name, value]) => `${name}: ${value.message ?? (!value.installed ? "executable not found" : "subscription login required")}`);
});

function load(): void { void workspace.load(String(route.params.taskId)); }
onMounted(() => {
  load();
  if (!system.cliStatus) void system.loadCliStatus().catch(() => undefined);
});
watch(() => route.params.taskId, load);
onBeforeUnmount(() => workspace.dispose());

async function updateFinding(id: string, changes: UpdateFindingRequest): Promise<void> {
  await workspace.updateFinding(id, changes, Boolean(workspace.feedbackText));
}

async function jumpToFinding(finding: ReviewFinding): Promise<void> {
  if (finding.file) await workspace.selectFile(finding.file);
}
</script>

<template>
  <div class="page task-page">
    <div v-if="workspace.loading && !workspace.task" class="panel empty-state loading-task"><strong>Loading task workspace…</strong><span>Restoring runs, findings, Git state and persisted events.</span></div>
    <template v-else-if="workspace.task">
      <TaskHeader
        :task="workspace.task" :runs="workspace.runs" :busy="workspace.busy"
        :codex-ready="system.codexReady" :claude-ready="system.claudeReady"
        @develop="workspace.develop" @review="workspace.review()" @cancel="workspace.cancel" @complete="workspace.complete"
      />
      <ErrorBanner :message="workspace.error" @dismiss="workspace.error = null" />
      <ErrorBanner :message="system.error?.message ?? null" @dismiss="system.clearError" />
      <div v-if="runtimeWarnings.length" class="panel runtime-warning">
        <div><strong>Local CLI action required</strong><span v-for="warning in runtimeWarnings" :key="warning">{{ warning }}</span></div>
        <RouterLink class="button" to="/settings">Open CLI Settings</RouterLink>
      </div>

      <div class="context-strip panel">
        <div><span>Repository</span><code>{{ workspace.task.workingDirectory }}</code></div>
        <div><span>Base commit</span><code>{{ workspace.task.baseCommit.slice(0, 12) }}</code></div>
        <div><span>Codex session</span><code>{{ workspace.task.developerSessionId?.slice(0, 20) ?? "not established" }}</code></div>
        <div><span>Events</span><code>{{ workspace.events.length }} · {{ workspace.connected ? 'live' : 'reconnecting' }}</code></div>
      </div>

      <div class="grid-workspace workspace-grid">
        <div class="stack">
          <DiffPanel
            :files="workspace.files" :selected-path="workspace.selectedPath" :diff="workspace.selectedDiff"
            :findings="workspace.findings" :loading="workspace.loading"
            @select="workspace.selectFile" @refresh="workspace.refresh"
          />
          <div class="grid-2 agent-grid">
            <AgentPanel title="Codex Developer" provider="codex" :runs="codexRuns" :events="workspace.events" />
            <AgentPanel title="Claude Reviewer" provider="claude" :runs="claudeRuns" :events="workspace.events" />
          </div>
        </div>
        <div class="stack">
          <ReviewPanel
            :run="workspace.latestReviewRun" :findings="workspace.findings" :busy="workspace.busy"
            :read-only="workspace.task.status === 'completed'"
            :stale="latestReviewStale"
            @update-finding="updateFinding" @select-mode="workspace.selectMode" @jump-to-finding="jumpToFinding"
          />
          <FeedbackEditor
            v-if="workspace.task.status === 'waiting_for_human'"
            :findings="workspace.findings" :text="workspace.feedbackText" :busy="workspace.busy" :stale="workspace.staleFeedback"
            @preview="workspace.previewFeedback" @update-text="workspace.feedbackText = $event"
            @send="workspace.sendFeedback(false)" @confirm-stale="workspace.sendFeedback(true)"
          />
          <ActivityPanel :events="workspace.events" :connected="workspace.connected" />
        </div>
      </div>
    </template>
    <div v-else class="panel empty-state"><strong>Task unavailable</strong><span>{{ workspace.error ?? 'The task could not be loaded.' }}</span></div>
  </div>
</template>

<style scoped>
.task-page{max-width:1580px}.loading-task{margin-top:10vh}.context-strip{display:grid;grid-template-columns:1.5fr .7fr 1fr .55fr;margin-bottom:14px;padding:10px 13px}.context-strip>div{min-width:0;padding:0 13px;border-right:1px solid var(--border)}.context-strip>div:first-child{padding-left:0}.context-strip>div:last-child{border:0}.context-strip span,.context-strip code{display:block}.context-strip span{margin-bottom:4px;color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.context-strip code{color:#adb6c4;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-grid{grid-template-columns:minmax(620px,1.55fr) minmax(360px,.85fr)}.agent-grid{align-items:start}
.runtime-warning{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;padding:11px 13px;border-color:rgba(243,201,105,.3);background:rgba(243,201,105,.06)}.runtime-warning strong,.runtime-warning span{display:block}.runtime-warning strong{margin-bottom:4px;color:#e9cf8b;font-size:11px}.runtime-warning span{color:#c7b47e;font-size:9px;line-height:1.5}
@media(max-width:1250px){.workspace-grid{grid-template-columns:1fr}.context-strip{grid-template-columns:repeat(2,1fr);gap:10px}.context-strip>div{border:0;padding:0}.agent-grid{grid-template-columns:1fr}}
</style>
