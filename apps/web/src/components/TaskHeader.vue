<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { AgentRun, Task } from "@local-pair-review/shared";

const props = defineProps<{
  task: Task;
  runs: AgentRun[];
  busy?: boolean;
  developerReady?: boolean;
  reviewerReady?: boolean;
  developerLabel: string;
  reviewerLabel: string;
  diffFileCount?: number;
}>();
const emit = defineEmits<{ develop: [prompt?: string]; review: []; cancel: [runId: string]; complete: []; "open-diff": [] }>();
const continuationPrompt = ref("");
const continuationPending = ref(false);
const barEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const activeRun = computed(() => props.runs.find((run) => run.status === "queued" || run.status === "running") ?? null);
const activeRunLabel = computed(() => activeRun.value?.runType === "reviewer" ? props.reviewerLabel : props.developerLabel);
const statusClass = computed(() => props.task.status === "ready_for_review" || props.task.status === "completed" ? "ready"
  : props.task.status === "developing" || props.task.status === "fixing" ? "running"
    : props.task.status === "reviewing" ? "reviewing"
      : props.task.status === "waiting_for_human" ? "waiting" : "");
const statusLabel = computed(() => props.task.status === "fixing" ? "running" : props.task.status.replaceAll("_", " "));
const showComposer = computed(() => props.task.status === "ready_for_review");
const hasActions = computed(() => showComposer.value
  || props.task.status === "draft"
  || props.task.status === "waiting_for_human"
  || !!activeRun.value);

function continueDeveloper(): void {
  const prompt = continuationPrompt.value.trim();
  if (!prompt || props.task.status !== "ready_for_review" || props.busy || !props.task.developerSessionId || !props.developerReady) return;
  continuationPending.value = true;
  emit("develop", prompt);
}

function autoResize(): void {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

watch(continuationPrompt, () => { void nextTick(autoResize); });

watch(() => [props.task.id, props.task.status] as const, ([taskId, status], [previousTaskId]) => {
  if (taskId !== previousTaskId) {
    continuationPrompt.value = "";
    continuationPending.value = false;
  } else if (continuationPending.value && status !== "ready_for_review") {
    continuationPrompt.value = "";
    continuationPending.value = false;
  }
});

watch(() => props.busy, (busy, wasBusy) => {
  if (continuationPending.value && wasBusy && !busy && props.task.status === "ready_for_review") continuationPending.value = false;
});

// Keep the scrollable page clear of the fixed bottom bar by publishing its height.
let resizeObserver: ResizeObserver | null = null;
function setBarHeight(px: number): void {
  document.documentElement.style.setProperty("--task-action-bar-h", `${px}px`);
}
watch(barEl, (el) => {
  resizeObserver?.disconnect();
  if (!el) { setBarHeight(0); return; }
  resizeObserver = new ResizeObserver(() => setBarHeight(el.offsetHeight));
  resizeObserver.observe(el);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  setBarHeight(0);
});
</script>

<template>
  <header class="task-header">
    <div>
      <div class="task-heading-row"><span :class="['badge', statusClass]">{{ statusLabel }}</span><span class="mono task-id">{{ task.id.slice(0, 8) }}</span><button type="button" class="diff-chip" @click="emit('open-diff')"><span class="diff-chip-glyph">⑂</span>Git Diff<span class="diff-chip-count">{{ diffFileCount ?? 0 }}</span></button></div>
      <h1>{{ task.title }}</h1>
      <p class="subtitle">{{ task.originalPrompt }}</p>
    </div>
  </header>
  <Teleport to="body">
    <div v-if="hasActions" ref="barEl" class="task-action-bar">
      <div v-if="showComposer" class="continuation-composer">
        <textarea
          ref="textareaEl" v-model="continuationPrompt" rows="1" class="input continuation-input"
          :aria-label="`${developerLabel} continuation message`" :placeholder="`Tell ${developerLabel} what to do next…`"
          @input="autoResize" @keydown.enter.exact.prevent="continueDeveloper"
        />
        <button class="button" :disabled="busy || !task.developerSessionId || !developerReady || !continuationPrompt.trim()" @click="continueDeveloper">Continue {{ developerLabel }}</button>
      </div>
      <div class="button-row task-actions">
        <button v-if="task.status === 'draft'" class="button primary" :disabled="busy || !developerReady" @click="emit('develop')">Start {{ developerLabel }} development</button>
        <button v-if="task.status === 'ready_for_review' || task.status === 'waiting_for_human'" class="button primary" :disabled="busy || !reviewerReady" @click="emit('review')">Start {{ reviewerLabel }} review</button>
        <button v-if="task.status === 'waiting_for_human'" class="button" :disabled="busy" @click="emit('complete')">Mark complete</button>
        <button v-if="activeRun" class="button danger" :disabled="busy" @click="emit('cancel', activeRun.id)">Cancel {{ activeRunLabel }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.task-header{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;margin-bottom:22px}.task-header>div:first-child{max-width:760px}.task-heading-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.task-id{color:var(--faint);font-size:9px}
.diff-chip{display:inline-flex;align-items:center;gap:6px;min-height:21px;padding:0 8px;border:1px solid var(--border-bright);border-radius:99px;color:var(--muted);background:var(--block-bg);cursor:pointer;font-size:10px;font-weight:700;letter-spacing:.02em;transition:.15s ease}.diff-chip:hover{color:var(--text);border-color:var(--border-bright);background:var(--surface-active)}.diff-chip-glyph{color:var(--accent);font-size:11px;transform:rotate(90deg)}.diff-chip-count{display:inline-flex;align-items:center;min-width:16px;height:15px;justify-content:center;padding:0 4px;border-radius:99px;color:var(--text-body);background:var(--border);font-size:9px}.task-header h1{font-size:23px;margin-bottom:7px}
.task-action-bar{position:fixed;left:248px;right:0;bottom:0;z-index:50;display:flex;align-items:flex-end;gap:12px;margin:0 24px 16px;padding:12px 14px;border:1px solid var(--border-bright);border-radius:var(--radius);background:var(--panel);box-shadow:0 6px 18px rgba(0,0,0,.14)}
.continuation-composer{flex:1;min-width:0;display:flex;align-items:flex-end;gap:8px}
.continuation-input{flex:1;min-width:0;min-height:36px;max-height:200px;line-height:1.5;resize:none;overflow-y:auto}
.task-actions{flex:none;justify-content:flex-end}
@media(max-width:900px){.task-action-bar{left:0}}
</style>
