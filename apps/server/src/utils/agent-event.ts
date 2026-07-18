import type { AgentEvent, AgentRun } from "@local-pair-review/shared";

export interface AgentEventContext {
  projectId: string;
  taskId: string;
  runId: string;
}

export function createAgentEvent(
  context: AgentEventContext,
  source: AgentEvent["source"],
  type: AgentEvent["type"],
  payload: unknown,
  timestamp = new Date().toISOString(),
): AgentEvent {
  return {
    sequence: 0,
    timestamp,
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    source,
    type,
    payload,
  };
}

export function createRunEvent(
  run: Pick<AgentRun, "id" | "projectId" | "taskId">,
  source: AgentEvent["source"],
  type: AgentEvent["type"],
  payload: unknown,
  timestamp = new Date().toISOString(),
): AgentEvent {
  return createAgentEvent({ projectId: run.projectId, taskId: run.taskId, runId: run.id }, source, type, payload, timestamp);
}
