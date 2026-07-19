<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { RunHistoryEntry } from "./run-history";

const props = defineProps<{ entries: RunHistoryEntry[]; selectedRunId: string | null }>();
const emit = defineEmits<{ select: [runId: string] }>();
const { locale, t } = useI18n();

function timestampLabel(timestamp: string): string {
  return timestamp ? new Date(timestamp).toLocaleString(locale.value) : t("runHistory.timePending");
}
</script>

<template>
  <section class="panel run-history" :aria-label="t('runHistory.label')">
    <header class="panel-header">
      <h2 class="panel-title">{{ t("runHistory.label") }} <span class="badge">{{ t("runHistory.runs", { count: entries.length }) }}</span></h2>
    </header>
    <ol v-if="entries.length" class="run-history-list">
      <li v-for="entry in entries" :key="entry.runId">
        <button
          type="button"
          class="run-history-item"
          :class="{ selected: entry.runId === selectedRunId }"
          :aria-pressed="entry.runId === selectedRunId"
          :aria-label="t('runHistory.select', { role: entry.roleLabel, ordinal: entry.roleOrdinal })"
          @click="emit('select', entry.runId)"
        >
          <span class="run-history-main">
            <span class="run-history-heading">
              <span class="run-history-role">{{ entry.roleLabel }} #{{ entry.roleOrdinal }}</span>
              <span :class="['badge', entry.status]">{{ t(`statuses.${entry.status}`) }}</span>
            </span>
            <span class="run-history-prompt">{{ entry.promptSummary || t("runHistory.noPrompt") }}</span>
          </span>
          <span class="run-history-meta">
            <span>{{ entry.providerLabel }}</span>
            <span>{{ timestampLabel(entry.timestamp) }}</span>
          </span>
        </button>
      </li>
    </ol>
    <div v-else class="empty-state"><strong>{{ t("runHistory.emptyTitle") }}</strong><span>{{ t("runHistory.emptyBody") }}</span></div>
  </section>
</template>

<style scoped>
.run-history { min-width: 0; overflow: hidden; }
.run-history-list { display: grid; margin: 0; padding: 0; list-style: none; }
.run-history-item { width: 100%; display: grid; gap: 7px; padding: 11px 12px; border: 0; border-bottom: 1px solid var(--border-soft); background: transparent; color: inherit; cursor: pointer; text-align: left; transition: .15s ease; }
.run-history-item:hover { background: var(--surface-hover); }.run-history-item.selected { background: rgba(243, 201, 105, .06); box-shadow: inset 2px 0 0 rgba(243, 201, 105, .45); }
.run-history-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.run-history-main { min-width: 0; display: grid; gap: 6px; }.run-history-heading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.run-history-role { color: var(--text-body); font-size: 11px; font-weight: 750; }.run-history-prompt { overflow: hidden; color: var(--muted); font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.run-history-heading .badge { flex: none; min-height: 18px; font-size: 8px; }.run-history-meta { min-width: 0; display: grid; gap: 2px; color: var(--faint); font-size: 8px; line-height: 1.35; }.run-history-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-history-heading .badge.cancelled, .run-history-heading .badge.interrupted { color: var(--red); border-color: rgba(255, 107, 117, .3); background: rgba(255, 107, 117, .08); }
</style>
