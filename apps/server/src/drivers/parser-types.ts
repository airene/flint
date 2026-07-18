import type { AgentEvent } from "@local-pair-review/shared";
import { createAgentEvent } from "../utils/agent-event";

export interface ParserContext {
  projectId: string;
  taskId: string;
  runId: string;
}

export interface ParsedAgentLine {
  /** Absent when the line is deliberately dropped (e.g. progress heartbeats). */
  event?: AgentEvent;
  sessionId?: string;
  finalMessage?: string;
  structuredOutput?: unknown;
  completed?: boolean;
  failed?: boolean;
}

export function skippedLine(): ParsedAgentLine {
  return {};
}

export function rawEvent(
  raw: string,
  source: "codex" | "claude",
  context: ParserContext,
  parsed?: unknown,
  error?: unknown,
): ParsedAgentLine {
  return {
    event: createAgentEvent(context, source, "raw", error === undefined
      ? { raw, parsed }
      : { raw, parseError: error instanceof Error ? error.message : String(error) }),
  };
}

export function parsedEvent(
  raw: string,
  source: "codex" | "claude",
  context: ParserContext,
  type: AgentEvent["type"],
  parsed: unknown,
): AgentEvent {
  return createAgentEvent(context, source, type, { raw, parsed });
}
