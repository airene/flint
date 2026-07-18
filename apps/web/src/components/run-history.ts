import type { AgentRun, AgentRunStatus, Provider } from "@local-pair-review/shared";

export interface RunHistoryEntry {
  runId: string;
  roleLabel: "Developer" | "Reviewer";
  roleOrdinal: number;
  providerLabel: string;
  status: AgentRunStatus;
  timestamp: string;
  promptSummary: string;
}

type ProviderLabel = (provider: Provider) => string;

function roleLabel(run: AgentRun): RunHistoryEntry["roleLabel"] {
  return run.runType === "reviewer" ? "Reviewer" : "Developer";
}

function promptSummary(prompt: string): string {
  return prompt.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function latestRunId(runs: AgentRun[]): string | null {
  return runs.at(-1)?.id ?? null;
}

export function buildRunHistory(runs: AgentRun[], providerLabel: ProviderLabel): RunHistoryEntry[] {
  const roleOrdinals = new Map<RunHistoryEntry["roleLabel"], number>();
  const chronological = runs.map((run) => {
    const label = roleLabel(run);
    const ordinal = (roleOrdinals.get(label) ?? 0) + 1;
    roleOrdinals.set(label, ordinal);
    return {
      runId: run.id,
      roleLabel: label,
      roleOrdinal: ordinal,
      providerLabel: providerLabel(run.provider),
      status: run.status,
      timestamp: run.startedAt ?? run.finishedAt ?? "",
      promptSummary: promptSummary(run.prompt),
    };
  });

  return chronological.reverse();
}

export function selectRunAfterUpdate(currentId: string | null, previousIds: string[], runs: AgentRun[]): string | null {
  const currentIds = new Set(runs.map((run) => run.id));
  const addedRuns = runs.filter((run) => !previousIds.includes(run.id));

  if (addedRuns.length) return latestRunId(addedRuns);
  if (currentId && currentIds.has(currentId)) return currentId;
  return latestRunId(runs);
}
