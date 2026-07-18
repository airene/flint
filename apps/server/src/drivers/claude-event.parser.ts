import { parsedEvent, rawEvent } from "./parser-types";
import type { ParsedAgentLine, ParserContext } from "./parser-types";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function assistantText(record: Record<string, unknown>): string | undefined {
  const message = object(record.message);
  if (!Array.isArray(message?.content)) return undefined;
  const text = message.content
    .map((block) => object(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text || undefined;
}

export function parseClaudeEventLine(raw: string, context: ParserContext): ParsedAgentLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return rawEvent(raw, "claude", context, undefined, error);
  }

  const record = object(parsed);
  if (!record || typeof record.type !== "string") return rawEvent(raw, "claude", context, parsed);

  if (record.type === "system" && record.subtype === "init" && typeof record.session_id === "string") {
    return {
      event: parsedEvent(raw, "claude", context, "session_started", parsed),
      sessionId: record.session_id,
    };
  }
  if (record.type === "assistant") {
    const text = assistantText(record);
    return {
      event: parsedEvent(raw, "claude", context, "message", parsed),
      ...(typeof record.session_id === "string" ? { sessionId: record.session_id } : {}),
      ...(text ? { finalMessage: text } : {}),
    };
  }
  if (record.type === "result") {
    const succeeded = record.subtype === "success" && record.is_error === false;
    return {
      event: parsedEvent(raw, "claude", context, succeeded ? "turn_completed" : "turn_failed", parsed),
      ...(typeof record.session_id === "string" ? { sessionId: record.session_id } : {}),
      ...(typeof record.result === "string" ? { finalMessage: record.result } : {}),
      structuredOutput: record.structured_output,
      completed: succeeded,
      failed: !succeeded,
    };
  }

  return rawEvent(raw, "claude", context, parsed);
}
