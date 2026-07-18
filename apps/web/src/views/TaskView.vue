<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

const diffOpen = ref(false);
function onKeydown(event: KeyboardEvent): void { if (event.key === "Escape") diffOpen.value = false; }
watch(diffOpen, (open) => {
  document.body.style.overflow = open ? "hidden" : "";
  if (open) window.addEventListener("keydown", onKeydown);
  else window.removeEventListener("keydown", onKeydown);
});
watch(() => route.params.taskId, () => { diffOpen.value = false; });

function load(): void { void workspace.load(String(route.params.taskId)); }
onMounted(() => {
  load();
  if (!system.cliStatus) void system.loadCliStatus().catch(() => undefined);
});
watch(() => route.params.taskId, load);
onBeforeUnmount(() => {
  workspace.dispose();
  window.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});

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
        :diff-file-count="workspace.files.length"
        @develop="workspace.develop" @review="workspace.review()" @cancel="workspace.cancel" @complete="workspace.complete"
        @open-diff="diffOpen = true"
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

    <Teleport to="body">
      <div v-if="workspace.task" class="diff-drawer-root" :class="{ open: diffOpen }" :aria-hidden="!diffOpen">
        <div class="diff-drawer-backdrop" @click="diffOpen = false" />
        <aside class="diff-drawer-panel" role="dialog" aria-label="Git diff">
          <div class="diff-drawer-topbar">
            <span class="diff-drawer-title">Working tree diff</span>
            <button type="button" class="button ghost" @click="diffOpen = false">✕ Close</button>
          </div>
          <div class="diff-drawer-body">
            <DiffPanel
              :files="workspace.files" :selected-path="workspace.selectedPath" :diff="workspace.selectedDiff"
              :findings="workspace.findings" :loading="workspace.loading"
              @select="workspace.selectFile" @refresh="workspace.refresh"
            />
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.task-page{max-width:1580px}.loading-task{margin-top:10vh}.context-strip{display:grid;grid-template-columns:1.5fr .7fr 1fr .55fr;margin-bottom:14px;padding:10px 13px}.context-strip>div{min-width:0;padding:0 13px;border-right:1px solid var(--border)}.context-strip>div:first-child{padding-left:0}.context-strip>div:last-child{border:0}.context-strip span,.context-strip code{display:block}.context-strip span{margin-bottom:4px;color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.context-strip code{color:#adb6c4;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-grid{grid-template-columns:minmax(620px,1.55fr) minmax(360px,.85fr)}.agent-grid{align-items:start}
.runtime-warning{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;padding:11px 13px;border-color:rgba(243,201,105,.3);background:rgba(243,201,105,.06)}.runtime-warning strong,.runtime-warning span{display:block}.runtime-warning strong{margin-bottom:4px;color:#e9cf8b;font-size:11px}.runtime-warning span{color:#c7b47e;font-size:9px;line-height:1.5}
@media(max-width:1250px){.workspace-grid{grid-template-columns:1fr}.context-strip{grid-template-columns:repeat(2,1fr);gap:10px}.context-strip>div{border:0;padding:0}.agent-grid{grid-template-columns:1fr}}

.diff-drawer-root{position:fixed;inset:0;z-index:60;visibility:hidden;pointer-events:none;transition:visibility 0s .26s}
.diff-drawer-root.open{visibility:visible;pointer-events:auto;transition:visibility 0s 0s}
.diff-drawer-backdrop{position:absolute;inset:0;background:rgba(6,8,11,.62);backdrop-filter:blur(1.5px);opacity:0;transition:opacity .22s ease}
.diff-drawer-root.open .diff-drawer-backdrop{opacity:1}
.diff-drawer-panel{position:absolute;top:0;right:0;height:100vh;width:50vw;min-width:520px;display:flex;flex-direction:column;border-left:1px solid var(--border-bright);background:var(--bg);box-shadow:-24px 0 60px rgba(0,0,0,.4);transform:translateX(100%);transition:transform .26s cubic-bezier(.32,.72,0,1)}
.diff-drawer-root.open .diff-drawer-panel{transform:translateX(0)}
.diff-drawer-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--border)}
.diff-drawer-title{color:var(--text);font-size:12px;font-weight:750;letter-spacing:.01em}
.diff-drawer-body{flex:1;min-height:0;display:flex;padding:16px}
.diff-drawer-body>*{flex:1;min-height:0}
@media(max-width:900px){.diff-drawer-panel{width:100vw;min-width:0}}
</style>
