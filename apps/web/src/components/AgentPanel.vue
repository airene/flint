<script setup lang="ts">
import { computed } from "vue";
import type { AgentEvent, AgentRun } from "@local-pair-review/shared";

const props = defineProps<{
  title: string;
  provider: "codex" | "claude";
  runs: AgentRun[];
  events: AgentEvent[];
}>();

const providerRuns = computed(() => props.runs.filter((run) => run.provider === props.provider));
const latest = computed(() => providerRuns.value.at(-1) ?? null);
const messages = computed(() => props.events.filter((event) => (
  event.source === props.provider && ["message", "plan", "command", "tool", "file_changed", "usage", "turn_completed", "stderr"].includes(event.type)
)).slice(-24));

function eventText(event: AgentEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (typeof payload?.raw === "string") return payload.raw;
  const parsed = payload?.parsed as Record<string, unknown> | undefined;
  const item = parsed?.item as Record<string, unknown> | undefined;
  if (typeof item?.text === "string") return item.text;
  return JSON.stringify(payload ?? {});
}
</script>

<template>
  <section class="panel agent-panel">
    <header class="panel-header">
      <h2 class="panel-title"><span :class="['agent-orb', provider]" />{{ title }}</h2>
      <span v-if="latest" :class="['badge', latest.status === 'completed' ? 'completed' : latest.status === 'running' ? 'running' : latest.status]">{{ latest.status }}</span>
      <span v-else class="badge">idle</span>
    </header>
    <div v-if="latest" class="panel-body agent-summary">
      <div class="run-meta mono">
        <span>{{ latest.runType }}</span><span>·</span><span>{{ latest.externalSessionId ?? "session pending" }}</span>
      </div>
      <div v-if="!['queued', 'running'].includes(latest.status)" class="terminal-meta mono">
        <span>exit {{ latest.exitCode ?? "n/a" }}</span><span>·</span><span>{{ latest.finishedAt ? new Date(latest.finishedAt).toLocaleTimeString() : latest.status }}</span>
      </div>
      <div class="prompt-block">
        <span class="mini-label">Prompt</span>
        <p>{{ latest.prompt }}</p>
      </div>
      <div v-if="latest.finalMessage" class="message-block">
        <span class="mini-label">Final response</span>
        <p>{{ latest.finalMessage }}</p>
      </div>
      <div v-if="latest.errorMessage" class="message-block error-text">
        <span class="mini-label">Error · exit {{ latest.exitCode ?? "?" }}</span>
        <p>{{ latest.errorMessage }}</p>
      </div>
      <details v-if="messages.length" class="event-details">
        <summary>{{ messages.length }} recent stream events</summary>
        <div class="event-lines mono">
          <div v-for="event in messages" :key="`${event.taskId}:${event.sequence}`" :class="['event-line', { stderr: event.type === 'stderr' }]">
            <span>{{ event.sequence }}</span><span>{{ event.type }}</span><code>{{ eventText(event) }}</code>
          </div>
        </div>
      </details>
    </div>
    <div v-else class="empty-state"><strong>No {{ provider }} run yet</strong><span>Start an action to see its session and stream.</span></div>
  </section>
</template>

<style scoped>
.agent-orb { width: 9px; height: 9px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 10px rgba(112,167,255,.35); }
.agent-orb.claude { background: var(--accent); box-shadow: 0 0 10px rgba(255,138,76,.35); }
.agent-summary { display: grid; gap: 13px; }
.run-meta { display: flex; gap: 7px; color: var(--faint); font-size: 10px; overflow: hidden; }
.terminal-meta{display:flex;gap:7px;color:#8d97a6;font-size:9px}
.prompt-block, .message-block { padding: 10px 11px; border: 1px solid var(--border); border-radius: 7px; background: #10141a; }
.mini-label { display: block; color: var(--faint); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
p { margin: 0; color: #c7cfdb; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
.error-text { border-color: rgba(255,107,117,.25); }.error-text p { color: #ffabb1; }
.event-details summary { cursor: pointer; color: var(--muted); font-size: 11px; }
.event-lines { max-height: 220px; margin-top: 8px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.event-line { display: grid; grid-template-columns: 30px 90px minmax(0,1fr); gap: 8px; padding: 6px 8px; border-bottom: 1px solid #20252e; color: var(--faint); font-size: 9px; }
.event-line:last-child { border: 0; }.event-line code { color: #aeb7c5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.event-line.stderr code { color: #f39aa1; }
</style>
