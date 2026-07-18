<script setup lang="ts">
import { computed } from "vue";
import type { ReviewFinding } from "@local-pair-review/shared";

const props = defineProps<{
  findings: ReviewFinding[];
  text: string;
  developerLabel: string;
  busy?: boolean;
  stale?: boolean;
}>();
const emit = defineEmits<{ preview: []; updateText: [text: string]; send: []; confirmStale: [] }>();
const selected = computed(() => props.findings.filter((finding) => finding.selected && !finding.dismissed));
</script>

<template>
  <section class="panel feedback-panel">
    <header class="panel-header">
      <h2 class="panel-title">Feedback to {{ developerLabel }} <span class="badge">{{ selected.length }} selected</span></h2>
      <button class="button ghost" type="button" :disabled="busy || !selected.length" @click="emit('preview')">Regenerate preview</button>
    </header>
    <div class="panel-body feedback-body">
      <p class="help">Nothing is sent automatically. Review the selected findings and edit this message before resuming the exact {{ developerLabel }} session.</p>
      <textarea class="textarea feedback-text" :value="text" :disabled="busy" placeholder="Select review findings, then generate a feedback preview…" @input="emit('updateText', ($event.target as HTMLTextAreaElement).value)" />
      <div v-if="stale" class="stale-notice"><strong>Snapshot changed.</strong> Confirm that you want to send feedback against a stale review.</div>
      <div class="feedback-actions">
        <span class="help mono">{{ selected.map((finding) => finding.severity).join(' · ') || 'No findings selected' }}</span>
        <button v-if="stale" class="button danger" :disabled="busy" @click="emit('confirmStale')">Confirm & send</button>
        <button v-else class="button primary" :disabled="busy || !text.trim()" @click="emit('send')">Resume {{ developerLabel }} session →</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.feedback-body{display:grid;gap:11px}.feedback-text{min-height:210px;font-family:"SFMono-Regular",Consolas,monospace;font-size:10px}.feedback-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.stale-notice{padding:9px 10px;border:1px solid rgba(243,201,105,.3);border-radius:6px;color:var(--yellow-ink);background:rgba(243,201,105,.07);font-size:10px}.stale-notice strong{margin-right:4px}
</style>
