<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentEvent, ApprovalRequest } from "@local-pair-review/shared";
import { useI18n } from "vue-i18n";
import ApprovalCard from "./ApprovalCard.vue";
import type { ApprovalCardDecision } from "./approval-card";

const props = withDefaults(defineProps<{
  events: AgentEvent[];
  connected: boolean;
  approvals?: ApprovalRequest[];
  approvalErrors?: Record<string, string>;
}>(), { approvals: () => [], approvalErrors: () => ({}) });
const emit = defineEmits<{ decideApproval: [approvalId: string, decision: ApprovalCardDecision] }>();
const filter = ref("all");
const { locale, t } = useI18n();

interface EventView {
  title: string;
  detail?: string;
  warning?: boolean;
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
  return t("activity.usage", { input: usage.input_tokens, output: usage.output_tokens });
}

function messageView(parsed: Record<string, unknown> | null, item: Record<string, unknown> | null): EventView {
  if (item?.type === "reasoning") return { title: t("activity.thinking"), detail: firstLine(item.text) };
  if (item) return { title: t("activity.message"), detail: firstLine(item.text) };
  const blocks = claudeBlocks(parsed);
  const text = blocks.find((block) => block.type === "text");
  if (text) return { title: t("activity.message"), detail: firstLine(text.text) };
  const toolUse = blocks.find((block) => block.type === "tool_use");
  if (toolUse) return { title: t("activity.tool", { name: typeof toolUse.name === "string" ? toolUse.name : t("activity.unknown") }), detail: toolInputSummary(toolUse.input) };
  if (blocks.some((block) => block.type === "thinking")) return { title: t("activity.thinking") };
  return { title: t("activity.message") };
}

function toolView(parsed: Record<string, unknown> | null, item: Record<string, unknown> | null): EventView {
  if (item?.type === "web_search") return { title: t("activity.webSearch"), detail: firstLine(item.query) };
  if (item?.type === "mcp_tool_call") {
    const name = [item.server, item.tool].filter((part) => typeof part === "string").join(".");
    return { title: name ? t("activity.tool", { name }) : t("activity.toolCall") };
  }
  const result = claudeBlocks(parsed).find((block) => block.type === "tool_result");
  if (result) {
    const content = typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content ?? "");
    if (/permission denied|permission required|not allowed|requires approval/i.test(content)) {
      return { title: t("activity.commandBlocked"), detail: firstLine(content), warning: true };
    }
    return { title: t("activity.toolResult"), detail: firstLine(content) };
  }
  return { title: t("activity.toolCall") };
}

function view(event: AgentEvent): EventView {
  const payload = record(event.payload);
  const parsed = record(payload?.parsed) ?? payload;
  const item = record(parsed?.item);
  switch (event.type) {
    case "run_queued": return { title: t("activity.runQueued") };
    case "run_started": return { title: t("activity.runStarted") };
    case "run_completed": return { title: t("activity.runCompleted") };
    case "run_failed": return { title: t("activity.runFailed"), detail: firstLine(payload?.message ?? parsed?.errorMessage) };
    case "run_cancelled": return { title: t("activity.runCancelled") };
    case "run_interrupted": return { title: t("activity.runInterrupted") };
    case "session_started": return { title: t("activity.sessionEstablished") };
    case "turn_started": return { title: t("activity.turnStarted") };
    case "turn_completed": return { title: t("activity.turnCompleted"), detail: usageSummary(parsed) };
    case "turn_failed": return { title: t("activity.turnFailed"), detail: firstLine(record(parsed?.error)?.message ?? payload?.raw) };
    case "message": return messageView(parsed, item);
    case "tool": return toolView(parsed, item);
    case "command": {
      const failed = typeof item?.exit_code === "number" && item.exit_code !== 0;
      return { title: failed ? t("activity.commandExit", { code: item?.exit_code }) : t("activity.command"), detail: firstLine(item?.command) };
    }
    case "file_changed": {
      const changes = Array.isArray(item?.changes) ? item.changes.map(record) : [];
      const paths = changes.map((change) => change?.path).filter((path): path is string => typeof path === "string");
      const listed = paths.slice(0, 3).join(", ");
      return {
        title: t("activity.filesChanged"),
        detail: paths.length > 3 ? `${listed} ${t("activity.more", { count: paths.length - 3 })}` : listed || undefined,
      };
    }
    case "plan": return { title: t("activity.plan"), detail: firstLine(item?.text) };
    case "review_parsed": {
      const count = typeof parsed?.findingCount === "number" ? t("activity.findings", { count: parsed.findingCount }) : undefined;
      const verdict = parsed?.verdict === "pass" ? t("review.verdictPass")
        : parsed?.verdict === "changes_suggested" ? t("review.verdictChangesSuggested") : undefined;
      return { title: t("activity.reviewFindingsParsed"), detail: [count, verdict].filter(Boolean).join(" · ") || undefined };
    }
    case "review_parse_failed": return { title: t("activity.reviewManualInspection") };
    case "message_queued": return { title: t("activity.messageQueued") };
    case "message_delivered": return { title: t("activity.messageDelivered") };
    case "message_failed": return { title: t("activity.messageFailed") };
    case "approval_requested": return { title: t("activity.approvalRequested") };
    case "approval_resolved": return { title: t("activity.approvalResolved") };
    case "raw": return {
      title: typeof parsed?.type === "string" ? t("activity.unparsed", { type: parsed.type }) : t("activity.unparsedOutput"),
      detail: firstLine(payload?.raw),
    };
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
      <h2 class="panel-title">{{ t("activity.heading") }} <span :class="['connection-dot', { connected }]" /></h2>
      <select v-model="filter" class="mini-select" :aria-label="t('activity.filter')">
        <option value="all">{{ t("activity.allSources") }}</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="system">System</option>
      </select>
    </header>
    <div v-if="approvals.length" class="approval-list">
      <ApprovalCard
        v-for="approval in approvals" :key="approval.id" :request="approval"
        :error="approvalErrors[approval.id]" @decide="emit('decideApproval', approval.id, $event)"
      />
    </div>
    <div v-if="visible.length" class="timeline scroll-area">
      <div v-for="row in visible" :key="`${row.event.taskId}:${row.event.sequence}`" :class="['timeline-row', { warning: row.view.warning }]">
        <span :class="['source-mark', row.event.source]" />
        <div class="timeline-content">
          <strong>{{ row.view.title }}</strong>
          <span v-if="row.view.detail" class="detail">{{ row.view.detail }}</span>
          <small>{{ row.event.source }} · #{{ row.event.sequence }} · {{ new Date(row.event.timestamp).toLocaleTimeString(locale) }}</small>
        </div>
      </div>
    </div>
    <div v-else class="empty-state"><strong>{{ t("activity.emptyTitle") }}</strong><span>{{ t("activity.emptyBody") }}</span></div>
  </section>
</template>

<style scoped>
.connection-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--red); }.connection-dot.connected { background:var(--green); }
.approval-list{display:grid;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)}
.mini-select { color:var(--muted); border:0; outline:0; background:transparent; font-size:10px; }
.timeline { max-height: 390px; }
.timeline-row { position:relative; display:grid; grid-template-columns:10px minmax(0,1fr); gap:10px; padding:10px 14px; border-bottom:1px solid var(--border-soft); }
.timeline-row:last-child { border:0; }.timeline-row strong { display:block; color:var(--text-body); font-size:11px; font-weight:600; }.timeline-row small { display:block; color:var(--faint); font-size:9px; margin-top:3px; }
.timeline-row.warning{background:rgba(243,201,105,.07)}.timeline-row.warning strong{color:var(--yellow-ink)}
.timeline-content { min-width:0; }
.detail { display:block; margin-top:2px; color:var(--muted); font-size:10px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.source-mark { width:7px; height:7px; margin-top:3px; border-radius:50%; background:var(--muted); }.source-mark.codex{background:var(--blue)}.source-mark.claude{background:var(--accent)}.source-mark.system{background:var(--green)}
</style>
