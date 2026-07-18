import type { AgentEvent } from "@local-pair-review/shared";

export interface ParserContext {
  projectId: string;
  taskId: string;
  runId: string;
}

export interface ParsedAgentLine {
  event: AgentEvent;
  sessionId?: string;
  finalMessage?: string;
  structuredOutput?: unknown;
  completed?: boolean;
  failed?: boolean;
}

export function rawEvent(
  raw: string,
  source: "codex" | "claude",
  context: ParserContext,
  parsed?: unknown,
  error?: unknown,
): ParsedAgentLine {
  return {
    event: {
      sequence: 0,
      timestamp: new Date().toISOString(),
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      source,
      type: "raw",
      payload: error === undefined
        ? { raw, parsed }
        : { raw, parseError: error instanceof Error ? error.message : String(error) },
    },
  };
}

export function parsedEvent(
  raw: string,
  source: "codex" | "claude",
  context: ParserContext,
  type: AgentEvent["type"],
  parsed: unknown,
): AgentEvent {
  return {
    sequence: 0,
    timestamp: new Date().toISOString(),
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    source,
    type,
    payload: { raw, parsed },
  };
}
