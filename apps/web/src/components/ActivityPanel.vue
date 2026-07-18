<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentEvent } from "@local-pair-review/shared";

const props = defineProps<{ events: AgentEvent[]; connected: boolean }>();
const filter = ref("all");

interface EventView {
  title: string;
  detail?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstLine(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function claudeBlocks(parsed: Record<string, unknown> | null): Record<string, unknown>[] {
  const message = record(parsed?.message);
  return Array.isArray(message?.content) ? message.content.map(record).filter((block): block is Record<string, unknown> => block !== null) : [];
}

function toolInputSummary(input: unknown): string | undefined {
  const fields = record(input);
  if (!fields) return undefined;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
    const summary = firstLine(fields[key]);
    if (summary) return summary;
  }
  return firstLine(JSON.stringify(fields));
}

function usageSummary(parsed: Record<string, unknown> | null): string | undefined {
  const usage = record(parsed?.usage);
  if (typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  return `${usage.input_tokens} in / ${usage.output_tokens} out tokens`;
}

function messageView(parsed: Record<string, unknown> | null, item: Record<string, unknown> | null): EventView {
  if (item?.type === "reasoning") return { title: "Thinking", detail: firstLine(item.text) };
  if (item) return { title: "Message", detail: firstLine(item.text) };
  const blocks = claudeBlocks(parsed);
  const text = blocks.find((block) => block.type === "text");
  if (text) return { title: "Message", detail: firstLine(text.text) };
  const toolUse = blocks.find((block) => block.type === "tool_use");
  if (toolUse) return { title: `Tool: ${typeof toolUse.name === "string" ? toolUse.name : "unknown"}`, detail: toolInputSummary(toolUse.input) };
  if (blocks.some((block) => block.type === "thinking")) return { title: "Thinking" };
  return { title: "Message" };
}

function toolView(parsed: Record<string, unknown> | null, item: Record<string, unknown> | null): EventView {
  if (item?.type === "web_search") return { title: "Web search", detail: firstLine(item.query) };
  if (item?.type === "mcp_tool_call") {
    const name = [item.server, item.tool].filter((part) => typeof part === "string").join(".");
    return { title: name ? `Tool: ${name}` : "Tool call" };
  }
  const result = claudeBlocks(parsed).find((block) => block.type === "tool_result");
  if (result) {
    const content = typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content ?? "");
    return { title: "Tool result", detail: firstLine(content) };
  }
  return { title: "Tool call" };
}

function view(event: AgentEvent): EventView {
  const payload = record(event.payload);
  const parsed = record(payload?.parsed) ?? payload;
  const item = record(parsed?.item);
  switch (event.type) {
    case "run_queued": return { title: "Run queued" };
    case "run_started": return { title: "Run started" };
    case "run_completed": return { title: "Run completed" };
    case "run_failed": return { title: "Run failed", detail: firstLine(payload?.message ?? parsed?.errorMessage) };
    case "run_cancelled": return { title: "Run cancelled" };
    case "run_interrupted": return { title: "Run interrupted" };
    case "session_started": return { title: "Session established" };
    case "turn_started": return { title: "Turn started" };
    case "turn_completed": return { title: "Turn completed", detail: usageSummary(parsed) };
    case "turn_failed": return { title: "Turn failed", detail: firstLine(record(parsed?.error)?.message ?? payload?.raw) };
    case "message": return messageView(parsed, item);
    case "tool": return toolView(parsed, item);
    case "command": {
      const failed = typeof item?.exit_code === "number" && item.exit_code !== 0;
      return { title: failed ? `Command · exit ${item?.exit_code}` : "Command", detail: firstLine(item?.command) };
    }
    case "file_changed": {
      const changes = Array.isArray(item?.changes) ? item.changes.map(record) : [];
      const paths = changes.map((change) => change?.path).filter((path): path is string => typeof path === "string");
      const listed = paths.slice(0, 3).join(", ");
      return {
        title: "Files changed",
        detail: paths.length > 3 ? `${listed} +${paths.length - 3} more` : listed || undefined,
      };
    }
    case "plan": return { title: "Plan", detail: firstLine(item?.text) };
    case "stderr": return { title: "CLI log", detail: firstLine(payload?.raw) };
    case "review_parsed": {
      const count = typeof parsed?.findingCount === "number" ? `${parsed.findingCount} findings` : undefined;
      const verdict = typeof parsed?.verdict === "string" ? parsed.verdict : undefined;
      return { title: "Review findings parsed", detail: [count, verdict].filter(Boolean).join(" · ") || undefined };
    }
    case "review_parse_failed": return { title: "Review output needs manual inspection" };
    case "raw": return {
      title: typeof parsed?.type === "string" ? `Unparsed: ${parsed.type}` : "Unparsed output",
      detail: firstLine(payload?.raw),
    };
    default: return { title: event.type.replaceAll("_", " ") };
  }
}

const visible = computed(() => props.events
  .filter((event) => filter.value === "all" || event.source === filter.value)
  .slice()
  .reverse()
  .map((event) => ({ event, view: view(event) })));
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
      <div v-for="row in visible" :key="`${row.event.taskId}:${row.event.sequence}`" class="timeline-row">
        <span :class="['source-mark', row.event.source]" />
        <div class="timeline-content">
          <strong>{{ row.view.title }}</strong>
          <span v-if="row.view.detail" class="detail">{{ row.view.detail }}</span>
          <small>{{ row.event.source }} · #{{ row.event.sequence }} · {{ new Date(row.event.timestamp).toLocaleTimeString() }}</small>
        </div>
      </div>
    </div>
    <div v-else class="empty-state"><strong>No activity for this run yet</strong><span>Persisted agent events will appear here.</span></div>
  </section>
</template>

<style scoped>
.connection-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--red); }.connection-dot.connected { background:var(--green); }
.mini-select { color:var(--muted); border:0; outline:0; background:transparent; font-size:10px; }
.timeline { max-height: 390px; }
.timeline-row { position:relative; display:grid; grid-template-columns:10px minmax(0,1fr); gap:10px; padding:10px 14px; border-bottom:1px solid #20252e; }
.timeline-row:last-child { border:0; }.timeline-row strong { display:block; color:#c4ccd8; font-size:11px; font-weight:600; }.timeline-row small { display:block; color:var(--faint); font-size:9px; margin-top:3px; }
.timeline-content { min-width:0; }
.detail { display:block; margin-top:2px; color:var(--muted); font-size:10px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.source-mark { width:7px; height:7px; margin-top:3px; border-radius:50%; background:var(--muted); }.source-mark.codex{background:var(--blue)}.source-mark.claude{background:var(--accent)}.source-mark.system{background:var(--green)}
</style>
