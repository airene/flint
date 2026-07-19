<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { MessageDeliveryMode, ReviewFinding, UpdateFindingRequest } from "@local-pair-review/shared";
import ActivityPanel from "../components/ActivityPanel.vue";
import AgentPanel from "../components/AgentPanel.vue";
import ErrorBanner from "../components/ErrorBanner.vue";
import FeedbackEditor from "../components/FeedbackEditor.vue";
import ReviewPanel from "../components/ReviewPanel.vue";
import RunHistory from "../components/RunHistory.vue";
import TaskHeader from "../components/TaskHeader.vue";
import TaskComposer, { type ComposerSubmission } from "../components/TaskComposer.vue";
import { uploadAttachmentDraft } from "../api/endpoints";
import { buildRunHistory, selectRunAfterUpdate } from "../components/run-history";
import { useSystemStore } from "../stores/system";
import { useTaskWorkspaceStore } from "../stores/task-workspace";

const DiffPanel = defineAsyncComponent(() => import("../components/DiffPanel.vue"));

const route = useRoute();
const router = useRouter();
const workspace = useTaskWorkspaceStore();
const system = useSystemStore();
const developerLabel = computed(() => system.providerLabel(workspace.task?.developerProvider));
const reviewerLabel = computed(() => system.providerLabel(workspace.task?.reviewerProvider));
const developerReady = computed(() => system.providerReady(workspace.task?.developerProvider));
const reviewerReady = computed(() => system.providerReady(workspace.task?.reviewerProvider));
const selectedRunId = ref<string | null>(null);
const historyEntries = computed(() => buildRunHistory(workspace.runs, system.providerLabel));
const selectedRun = computed(() => workspace.runs.find((run) => run.id === selectedRunId.value) ?? null);
const selectedHistoryEntry = computed(() => historyEntries.value.find((entry) => entry.runId === selectedRunId.value) ?? null);
const selectedRunEvents = computed(() => workspace.events.filter((event) => event.runId === selectedRunId.value));
const selectedRunApprovals = computed(() => workspace.approvals.filter((approval) => approval.runId === selectedRunId.value));
const selectedIsReviewer = computed(() => selectedRun.value?.runType === "reviewer");
const selectedReviewFindings = computed(() => selectedRun.value?.runType === "reviewer"
  ? workspace.findings.filter((finding) => finding.runId === selectedRun.value?.id)
  : []);
const selectedIsFeedbackReview = computed(() => Boolean(
  selectedRun.value && selectedRun.value.id === workspace.feedbackReviewRun?.id,
));
const selectedRunTitle = computed(() => {
  const run = selectedRun.value;
  if (!run) return "Run detail";
  const role = selectedHistoryEntry.value?.roleLabel ?? (run.runType === "reviewer" ? "Reviewer" : "Developer");
  const ordinal = selectedHistoryEntry.value?.roleOrdinal;
  return `${system.providerLabel(run.provider)} ${role}${ordinal ? ` #${ordinal}` : ""}`;
});
const selectedReviewStale = computed(() => {
  if (!selectedIsFeedbackReview.value) return false;
  if (workspace.reviewSnapshotStale) return true;
  const runId = selectedRun.value?.id;
  if (!runId) return false;
  const event = workspace.events.filter((candidate) => candidate.runId === runId
    && (candidate.type === "review_parsed" || candidate.type === "review_parse_failed")).at(-1);
  return Boolean((event?.payload as { stale?: unknown } | undefined)?.stale);
});
const composerText = ref("");
const deliveryMode = ref<MessageDeliveryMode>("queue");
const composerGeneration = ref(0);
const selectedFormalReview = computed(() => {
  const run = selectedRun.value;
  return run?.runType === "reviewer" && run.status === "completed" && run.externalSessionId ? run : null;
});
const composerTargetRole = computed(() => selectedFormalReview.value ? "reviewer" as const : "developer" as const);
const composerProvider = computed(() => composerTargetRole.value === "reviewer"
  ? workspace.task?.reviewerProvider
  : workspace.task?.developerProvider);
const composerImagesEnabled = computed(() => {
  const descriptor = system.providerById(composerProvider.value);
  return Boolean(descriptor?.capabilities[composerTargetRole.value === "reviewer" ? "reviewerResumeImage" : "developerResumeImage"]);
});
const composerDisabledReason = computed(() => {
  if (workspace.task?.status === "completed") return "Completed tasks are read-only.";
  if (composerTargetRole.value === "developer" && !workspace.task?.developerSessionId) return "Start Developer once to establish an exact session.";
  if (!composerProvider.value || !system.providerReady(composerProvider.value)) return "The selected provider is unavailable.";
  return null;
});
const composerKey = computed(() => `${composerTargetRole.value}:${selectedFormalReview.value?.id ?? "developer"}:${composerGeneration.value}`);

async function sendMessage(submission: ComposerSubmission): Promise<void> {
  const sent = await workspace.sendMessage({
    targetRole: composerTargetRole.value,
    sourceReviewRunId: selectedFormalReview.value?.id ?? null,
    text: submission.text,
    deliveryMode: deliveryMode.value,
    attachmentIds: submission.attachmentIds,
  });
  if (sent) {
    composerText.value = "";
    composerGeneration.value += 1;
  }
}
const runtimeWarnings = computed(() => {
  const status = system.cliStatus;
  const task = workspace.task;
  if (!status || !task) return [];
  const warnings = ([
    ["Developer", task.developerProvider],
    ["Reviewer", task.reviewerProvider],
  ] as const).flatMap(([role, provider]) => {
    const descriptor = system.providerById(provider);
    const availability = descriptor?.availability;
    if (availability?.installed && availability.authentication !== "unauthenticated") return [];
    const detail = availability?.message ?? (!availability?.installed ? "executable not found" : "subscription login required");
    return [`${role} · ${descriptor?.label ?? provider}: ${detail}`];
  });
  if (!system.gitReady) warnings.push(`Git: ${status.git.message ?? (!status.git.installed ? "executable not found" : "unavailable")}`);
  return warnings;
});

const diffOpen = ref(false);
const diffLoaded = ref(false);
function onKeydown(event: KeyboardEvent): void { if (event.key === "Escape") diffOpen.value = false; }
watch(diffOpen, (open) => {
  if (open) diffLoaded.value = true;
  document.body.style.overflow = open ? "hidden" : "";
  if (open) window.addEventListener("keydown", onKeydown);
  else window.removeEventListener("keydown", onKeydown);
});
watch(() => workspace.runs.map((run) => run.id), (_runIds, previousIds) => {
  selectedRunId.value = selectRunAfterUpdate(selectedRunId.value, previousIds ?? [], workspace.runs);
}, { immediate: true });
watch(() => route.params.taskId, () => {
  diffOpen.value = false;
  diffLoaded.value = false;
  selectedRunId.value = null;
});

function load(): void { void workspace.load(String(route.params.taskId)); }

// Freshly created tasks arrive with ?start=1 so development kicks off immediately,
// without the user having to open the detail page and press Start.
async function maybeAutoStart(): Promise<void> {
  if (route.query.start !== "1") return;
  const query = { ...route.query };
  delete query.start;
  void router.replace({ query }); // consume the flag so refresh/back never re-triggers
  if (workspace.task?.id !== String(route.params.taskId) || workspace.task.status !== "draft") return;
  if (workspace.busy || !developerReady.value) return; // respect the same gating as the Start button
  await workspace.develop();
}

onMounted(async () => {
  const cliStatusReady = system.cliStatus ? Promise.resolve() : system.loadCliStatus().catch(() => undefined);
  await workspace.load(String(route.params.taskId));
  await cliStatusReady;
  await maybeAutoStart();
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
    <div v-if="workspace.loading && !workspace.task" class="panel empty-state loading-task"><strong>Loading task workspace…</strong><span>Restoring persisted runs, findings and events.</span></div>
    <template v-else-if="workspace.task">
      <TaskHeader
        :task="workspace.task" :runs="workspace.runs" :busy="workspace.busy"
        :developer-ready="developerReady" :reviewer-ready="reviewerReady"
        :developer-label="developerLabel" :reviewer-label="reviewerLabel"
        :diff-file-count="workspace.files.length"
        @develop="workspace.develop" @review="workspace.review()" @cancel="workspace.cancel" @complete="workspace.complete"
        @open-diff="diffOpen = true"
      />
      <ErrorBanner :message="workspace.error" @dismiss="workspace.error = null" />
      <ErrorBanner :message="system.error?.message ?? null" @dismiss="system.clearError" />
      <div v-if="workspace.repositoryError" class="panel repository-warning">
        <strong>Repository unavailable</strong>
        <span>Task history remains available. {{ workspace.repositoryError }}</span>
      </div>
      <div v-if="runtimeWarnings.length" class="panel runtime-warning">
        <div><strong>Local CLI action required</strong><span v-for="warning in runtimeWarnings" :key="warning">{{ warning }}</span></div>
        <RouterLink class="button" to="/settings">Open CLI Settings</RouterLink>
      </div>

      <div class="context-strip panel">
        <div><span>Repository</span><code>{{ workspace.task.workingDirectory }}</code></div>
        <div><span>Base commit</span><code>{{ workspace.task.baseCommit.slice(0, 12) }}</code></div>
        <div><span>{{ developerLabel }} session</span><code>{{ workspace.task.developerSessionId?.slice(0, 20) ?? "not established" }}</code></div>
        <div><span>Events</span><code>{{ workspace.events.length }} · {{ workspace.connected ? 'live' : 'reconnecting' }}</code></div>
      </div>

      <div class="run-workspace">
        <RunHistory :entries="historyEntries" :selected-run-id="selectedRunId" @select="selectedRunId = $event" />
        <div v-if="selectedRun" class="stack run-detail">
          <AgentPanel :title="selectedRunTitle" :run="selectedRun" :events="selectedRunEvents" />
          <ReviewPanel
            v-if="selectedIsReviewer"
            :run="selectedRun" :findings="selectedReviewFindings" :reviewer-label="reviewerLabel" :busy="workspace.busy"
            :read-only="workspace.task.status !== 'waiting_for_human' || !selectedIsFeedbackReview"
            :stale="selectedReviewStale"
            @update-finding="updateFinding" @select-mode="workspace.selectMode" @jump-to-finding="jumpToFinding"
          />
          <FeedbackEditor
            v-if="workspace.task.status === 'waiting_for_human' && selectedIsFeedbackReview"
            :findings="selectedReviewFindings" :text="workspace.feedbackText" :developer-label="developerLabel" :busy="workspace.busy" :stale="workspace.staleFeedback"
            @preview="workspace.previewFeedback" @update-text="workspace.updateFeedbackText"
            @send="workspace.sendFeedback(false)" @confirm-stale="workspace.sendFeedback(true)"
          />
          <ActivityPanel
            :events="selectedRunEvents" :connected="workspace.connected" :approvals="selectedRunApprovals"
            :approval-errors="workspace.approvalErrors"
            @decide-approval="(approvalId, decision) => workspace.decideApproval(approvalId, decision)"
          />
        </div>
        <div v-else class="panel empty-state run-detail-empty"><strong>No run selected</strong><span>Start an action to create the first run.</span></div>
      </div>
      <section class="panel conversation-panel">
        <header class="panel-header">
          <div>
            <h2 class="panel-title">Message {{ composerTargetRole === 'reviewer' ? `${reviewerLabel} Reviewer` : `${developerLabel} Developer` }}</h2>
            <small v-if="selectedFormalReview">Exact Review session · {{ selectedFormalReview.externalSessionId }}</small>
            <small v-else>Exact Developer session · {{ workspace.task.developerSessionId ?? 'not established' }}</small>
          </div>
          <label class="delivery-mode">Delivery
            <select v-model="deliveryMode" :disabled="Boolean(composerDisabledReason) || workspace.sendingMessage">
              <option value="queue">Queue next turn</option>
              <option value="interrupt">Interrupt same role</option>
            </select>
          </label>
        </header>
        <div v-if="workspace.messages.length" class="message-list">
          <article v-for="message in workspace.messages" :key="message.id" :class="['task-message', message.status]">
            <div><strong>{{ message.targetRole === 'reviewer' ? 'Reviewer' : 'Developer' }}</strong><span>{{ message.status }}</span></div>
            <p>{{ message.text }}</p>
            <small v-if="message.errorMessage">{{ message.errorMessage }}</small>
          </article>
        </div>
        <p v-if="composerDisabledReason" class="composer-note">{{ composerDisabledReason }}</p>
        <TaskComposer
          :key="composerKey" v-model="composerText" :project-id="workspace.task.projectId"
          :upload-image="uploadAttachmentDraft" :disabled="Boolean(composerDisabledReason)"
          :submitting="workspace.sendingMessage"
          :aria-label="`${composerTargetRole === 'reviewer' ? reviewerLabel : developerLabel} ${composerTargetRole} follow-up message`"
          :images-enabled="composerImagesEnabled"
          :image-disabled-reason="`${composerProvider ?? 'Provider'} cannot receive images in this resumed session.`"
          placeholder="Send a persisted follow-up…" @submit="sendMessage"
        />
      </section>
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
              v-if="diffLoaded"
              :files="workspace.files" :selected-path="workspace.selectedPath" :diff="workspace.selectedDiff"
              :findings="selectedReviewFindings" :loading="workspace.repositoryLoading"
              :repository-error="workspace.repositoryError" :diff-error="workspace.diffError"
              @select="workspace.selectFile" @refresh="workspace.refresh"
            />
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.task-page{max-width:none;padding-bottom:calc(48px + var(--task-action-bar-h, 0px))}.loading-task{margin-top:10vh}.context-strip{display:grid;grid-template-columns:1.5fr .7fr 1fr .55fr;margin-bottom:14px;padding:10px 13px}.context-strip>div{min-width:0;padding:0 13px;border-right:1px solid var(--border)}.context-strip>div:first-child{padding-left:0}.context-strip>div:last-child{border:0}.context-strip span,.context-strip code{display:block}.context-strip span{margin-bottom:4px;color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.context-strip code{color:var(--text-body);font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-workspace{display:grid;grid-template-columns:230px minmax(0,1fr);gap:14px;align-items:start}.run-detail{min-width:0}.run-detail-empty{min-height:180px}
.runtime-warning{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;padding:11px 13px;border-color:rgba(243,201,105,.3);background:rgba(243,201,105,.06)}.runtime-warning strong,.runtime-warning span{display:block}.runtime-warning strong{margin-bottom:4px;color:var(--yellow-ink);font-size:11px}.runtime-warning span{color:var(--yellow-ink);font-size:9px;line-height:1.5}
.repository-warning{display:grid;gap:4px;margin-bottom:14px;padding:11px 13px;border-color:rgba(243,201,105,.3);background:rgba(243,201,105,.06)}.repository-warning strong{color:var(--yellow-ink);font-size:11px}.repository-warning span{color:var(--yellow-ink);font-size:9px;line-height:1.5}
.conversation-panel{margin-top:14px;padding-bottom:14px}.conversation-panel>.panel-header{align-items:flex-start}.conversation-panel small{display:block;margin-top:4px;color:var(--faint);font-size:9px}.delivery-mode{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:9px}.delivery-mode select{padding:5px 7px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text)}.message-list{display:grid;gap:6px;max-height:210px;overflow:auto;padding:10px 14px;border-bottom:1px solid var(--border)}.task-message{padding:8px 10px;border:1px solid var(--border-soft);border-radius:5px;background:var(--block-bg)}.task-message>div{display:flex;justify-content:space-between;gap:8px}.task-message strong{font-size:10px}.task-message span{color:var(--faint);font-size:9px;text-transform:capitalize}.task-message p{margin:5px 0 0;color:var(--text-body);font-size:10px;white-space:pre-wrap}.task-message small{color:var(--red-ink)}.task-message.failed{border-color:rgba(255,100,100,.35)}.composer-note{margin:10px 14px 0;color:var(--yellow-ink);font-size:10px}.conversation-panel>.task-composer{padding:12px 14px 0}
@media(max-width:900px){.run-workspace{grid-template-columns:1fr}.context-strip{grid-template-columns:repeat(2,1fr);gap:10px}.context-strip>div{border:0;padding:0}}

.diff-drawer-root{position:fixed;inset:0;z-index:60;visibility:hidden;pointer-events:none;transition:visibility 0s .26s}
.diff-drawer-root.open{visibility:visible;pointer-events:auto;transition:visibility 0s 0s}
.diff-drawer-backdrop{position:absolute;inset:0;background:var(--overlay);backdrop-filter:blur(1.5px);opacity:0;transition:opacity .22s ease}
.diff-drawer-root.open .diff-drawer-backdrop{opacity:1}
.diff-drawer-panel{position:absolute;top:0;right:0;height:100vh;width:65vw;min-width:520px;display:flex;flex-direction:column;border-left:1px solid var(--border-bright);background:var(--bg);box-shadow:var(--shadow-drawer);transform:translateX(100%);transition:transform .26s cubic-bezier(.32,.72,0,1)}
.diff-drawer-root.open .diff-drawer-panel{transform:translateX(0)}
.diff-drawer-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--border)}
.diff-drawer-title{color:var(--text);font-size:12px;font-weight:750;letter-spacing:.01em}
.diff-drawer-body{flex:1;min-height:0;display:flex;padding:16px}
.diff-drawer-body>*{flex:1;min-height:0}
@media(max-width:900px){.diff-drawer-panel{width:100vw;min-width:0}}
</style>
