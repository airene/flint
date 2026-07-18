import { parsedEvent, rawEvent } from "./parser-types";
import type { ParsedAgentLine, ParserContext } from "./parser-types";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function parseCodexEventLine(raw: string, context: ParserContext): ParsedAgentLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return rawEvent(raw, "codex", context, undefined, error);
  }

  const record = object(parsed);
  if (!record || typeof record.type !== "string") return rawEvent(raw, "codex", context, parsed);

  if (record.type === "thread.started" && typeof record.thread_id === "string") {
    return {
      event: parsedEvent(raw, "codex", context, "session_started", parsed),
      sessionId: record.thread_id,
    };
  }
  if (record.type === "turn.started") {
    return { event: parsedEvent(raw, "codex", context, "turn_started", parsed) };
  }
  if (record.type === "turn.completed") {
    return {
      event: parsedEvent(raw, "codex", context, "turn_completed", parsed),
      completed: true,
    };
  }
  if (record.type === "turn.failed" || record.type === "error") {
    return {
      event: parsedEvent(raw, "codex", context, "turn_failed", parsed),
      failed: true,
    };
  }
  if (record.type === "item.completed" || record.type === "item.updated" || record.type === "item.started") {
    const item = object(record.item);
    const itemType = item?.type;
    const eventType = itemType === "agent_message" ? "message"
      : itemType === "reasoning" ? "message"
      : itemType === "plan" ? "plan"
      : itemType === "todo_list" ? "plan"
      : itemType === "command_execution" ? "command"
      : itemType === "file_change" ? "file_changed"
      : itemType === "mcp_tool_call" ? "tool"
      : itemType === "web_search" ? "tool"
      : undefined;
    if (!eventType) return rawEvent(raw, "codex", context, parsed);
    return {
      event: parsedEvent(raw, "codex", context, eventType, parsed),
      ...(itemType === "agent_message" && typeof item?.text === "string" ? { finalMessage: item.text } : {}),
    };
  }

  return rawEvent(raw, "codex", context, parsed);
}
