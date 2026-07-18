<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentEvent } from "@local-pair-review/shared";

const props = defineProps<{ events: AgentEvent[]; connected: boolean }>();
const filter = ref("all");
const visible = computed(() => props.events.filter((event) => filter.value === "all" || event.source === filter.value).slice().reverse());

function label(event: AgentEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (event.type === "session_started") return "Session established";
  if (event.type === "review_parsed") return "Review findings parsed";
  if (event.type === "review_parse_failed") return "Review output needs manual inspection";
  if (typeof payload?.message === "string") return payload.message;
  return event.type.replaceAll("_", " ");
}
</script>

<template>
  <section class="panel activity-panel">
    <header class="panel-header">
      <h2 class="panel-title">Activity <span :class="['connection-dot', { connected }]" /></h2>
      <select v-model="filter" class="mini-select" aria-label="Filter activity source">
        <option value="all">All sources</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="system">System</option>
      </select>
    </header>
    <div v-if="visible.length" class="timeline scroll-area">
      <div v-for="event in visible" :key="`${event.taskId}:${event.sequence}`" class="timeline-row">
        <span :class="['source-mark', event.source]" />
        <div><strong>{{ label(event) }}</strong><small>{{ event.source }} · #{{ event.sequence }} · {{ new Date(event.timestamp).toLocaleTimeString() }}</small></div>
      </div>
    </div>
    <div v-else class="empty-state"><strong>No activity yet</strong><span>Persisted agent events will appear here.</span></div>
  </section>
</template>

<style scoped>
.connection-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--red); }.connection-dot.connected { background:var(--green); }
.mini-select { color:var(--muted); border:0; outline:0; background:transparent; font-size:10px; }
.timeline { max-height: 390px; }
.timeline-row { position:relative; display:grid; grid-template-columns:10px minmax(0,1fr); gap:10px; padding:10px 14px; border-bottom:1px solid #20252e; }
.timeline-row:last-child { border:0; }.timeline-row strong { display:block; color:#c4ccd8; font-size:11px; font-weight:600; text-transform:capitalize; }.timeline-row small { display:block; color:var(--faint); font-size:9px; margin-top:3px; }
.source-mark { width:7px; height:7px; margin-top:3px; border-radius:50%; background:var(--muted); }.source-mark.codex{background:var(--blue)}.source-mark.claude{background:var(--accent)}.source-mark.system{background:var(--green)}
</style>
