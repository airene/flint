import { reviewResultSchema, type AgentRun, type ReviewFinding } from "@local-pair-review/shared";

const emptyFindings: readonly ReviewFinding[] = Object.freeze([]);

export function displayFindingsForRun(run: AgentRun | null, findings: ReviewFinding[]): readonly ReviewFinding[] {
  if (!run) return emptyFindings;

  const persistedFindings = findings.filter((finding) => finding.runId === run.id);
  if (persistedFindings.length) return persistedFindings;

  const parsed = reviewResultSchema.safeParse(run.structuredOutput);
  if (!parsed.success) return emptyFindings;

  return Object.freeze(parsed.data.findings.map((finding, index) => Object.freeze({
    id: `structured:${run.id}:${index}`,
    taskId: run.taskId,
    runId: run.id,
    ...finding,
    selected: finding.severity !== "P2",
    dismissed: false,
    userNote: null,
    createdAt: run.finishedAt ?? run.startedAt ?? "",
  })));
}
