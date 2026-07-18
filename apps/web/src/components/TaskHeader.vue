<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AgentRun, Task } from "@local-pair-review/shared";

const props = defineProps<{ task: Task; runs: AgentRun[]; busy?: boolean; codexReady?: boolean; claudeReady?: boolean; diffFileCount?: number }>();
const emit = defineEmits<{ develop: [prompt?: string]; review: []; cancel: [runId: string]; complete: []; "open-diff": [] }>();
const continuationPrompt = ref("");
const continuationPending = ref(false);
const activeRun = computed(() => props.runs.find((run) => run.status === "queued" || run.status === "running") ?? null);
const statusClass = computed(() => props.task.status === "ready_for_review" || props.task.status === "completed" ? "ready"
  : props.task.status === "developing" || props.task.status === "fixing" ? "running"
    : props.task.status === "reviewing" ? "reviewing"
      : props.task.status === "waiting_for_human" ? "waiting" : "");

function continueCodex(): void {
  const prompt = continuationPrompt.value.trim();
  if (!prompt || props.task.status !== "ready_for_review" || props.busy || !props.task.developerSessionId || !props.codexReady) return;
  continuationPending.value = true;
  emit("develop", prompt);
}

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
</script>

<template>
  <header class="task-header">
    <div>
      <div class="task-heading-row"><span :class="['badge', statusClass]">{{ task.status.replaceAll('_', ' ') }}</span><span class="mono task-id">{{ task.id.slice(0, 8) }}</span><button type="button" class="diff-chip" @click="emit('open-diff')"><span class="diff-chip-glyph">⑂</span>Git Diff<span class="diff-chip-count">{{ diffFileCount ?? 0 }}</span></button></div>
      <h1>{{ task.title }}</h1>
      <p class="subtitle">{{ task.originalPrompt }}</p>
    </div>
    <div class="task-action-stack">
      <div v-if="task.status === 'ready_for_review'" class="continuation-composer">
        <input v-model="continuationPrompt" class="input" aria-label="Codex continuation message" placeholder="Tell Codex what to do next…" @keyup.enter.prevent="continueCodex">
        <button class="button" :disabled="busy || !task.developerSessionId || !codexReady || !continuationPrompt.trim()" @click="continueCodex">Continue Codex</button>
      </div>
      <div class="button-row task-actions">
      <button v-if="task.status === 'draft'" class="button primary" :disabled="busy || !codexReady" @click="emit('develop')">Start Codex development</button>
      <button v-if="task.status === 'ready_for_review' || task.status === 'waiting_for_human'" class="button primary" :disabled="busy || !claudeReady" @click="emit('review')">Start Claude review</button>
      <button v-if="task.status === 'waiting_for_human'" class="button" :disabled="busy" @click="emit('complete')">Mark complete</button>
      <button v-if="activeRun" class="button danger" :disabled="busy" @click="emit('cancel', activeRun.id)">Cancel {{ activeRun.provider }}</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.task-header{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;margin-bottom:22px}.task-header>div:first-child{max-width:760px}.task-heading-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.task-id{color:var(--faint);font-size:9px}
.diff-chip{display:inline-flex;align-items:center;gap:6px;min-height:21px;padding:0 8px;border:1px solid var(--border-bright);border-radius:99px;color:var(--muted);background:#141821;cursor:pointer;font-size:10px;font-weight:700;letter-spacing:.02em;transition:.15s ease}.diff-chip:hover{color:var(--text);border-color:#515b6d;background:#1c222c}.diff-chip-glyph{color:var(--accent);font-size:11px;transform:rotate(90deg)}.diff-chip-count{display:inline-flex;align-items:center;min-width:16px;height:15px;justify-content:center;padding:0 4px;border-radius:99px;color:#c7cfdb;background:#272d38;font-size:9px}.task-header h1{font-size:23px;margin-bottom:7px}.task-action-stack{display:grid;justify-items:end;gap:8px;min-width:360px}.continuation-composer{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:7px;width:100%}.task-actions{justify-content:flex-end;padding-top:3px}
</style>
