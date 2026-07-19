<script setup lang="ts">
import { computed } from "vue";
import type { ReviewFinding } from "@local-pair-review/shared";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  findings: ReviewFinding[];
  text: string;
  developerLabel: string;
  busy?: boolean;
  stale?: boolean;
}>();
const emit = defineEmits<{ preview: []; updateText: [text: string]; send: []; confirmStale: [] }>();
const selected = computed(() => props.findings.filter((finding) => finding.selected && !finding.dismissed));
const { t } = useI18n();
</script>

<template>
  <section class="panel feedback-panel">
    <header class="panel-header">
      <h2 class="panel-title">{{ t("feedback.heading", { developer: developerLabel }) }} <span class="badge">{{ t("feedback.selected", { count: selected.length }) }}</span></h2>
      <button class="button ghost" type="button" :disabled="busy || !selected.length" @click="emit('preview')">{{ t("feedback.regenerate") }}</button>
    </header>
    <div class="panel-body feedback-body">
      <p class="help">{{ t("feedback.body", { developer: developerLabel }) }}</p>
      <textarea class="textarea feedback-text" :value="text" :disabled="busy" :placeholder="t('feedback.placeholder')" @input="emit('updateText', ($event.target as HTMLTextAreaElement).value)" />
      <div v-if="stale" class="stale-notice"><strong>{{ t("feedback.snapshotChanged") }}</strong> {{ t("feedback.snapshotChangedBody") }}</div>
      <div class="feedback-actions">
        <span class="help mono">{{ selected.map((finding) => finding.severity).join(' · ') || t("feedback.noFindings") }}</span>
        <button v-if="stale" class="button danger" :disabled="busy" @click="emit('confirmStale')">{{ t("feedback.confirmAndSend") }}</button>
        <button v-else class="button primary" :disabled="busy || !text.trim()" @click="emit('send')">{{ t("feedback.resumeSession", { developer: developerLabel }) }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.feedback-body{display:grid;gap:11px}.feedback-text{min-height:210px;font-family:"SFMono-Regular",Consolas,monospace;font-size:10px}.feedback-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.stale-notice{padding:9px 10px;border:1px solid rgba(243,201,105,.3);border-radius:6px;color:var(--yellow-ink);background:rgba(243,201,105,.07);font-size:10px}.stale-notice strong{margin-right:4px}
</style>
