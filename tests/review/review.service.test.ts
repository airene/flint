import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentRun, ReviewFinding, Task } from "@local-pair-review/shared";
import type { StartAgentRunInput, StartedAgentRun } from "../../apps/server/src/services/agent-run.service";
import { EventService } from "../../apps/server/src/services/event.service";
import {
  buildReviewPrompt,
  ReviewService,
  type ReviewContextPort,
  type ReviewPersistencePort,
} from "../../apps/server/src/services/review.service";

function task(): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    originalPrompt: "Add validation to user input.",
    workingDirectory: "/tmp/project",
    baseCommit: "base-abc123",
    latestSnapshotHash: null,
    status: "ready_for_review",
    developerProvider: "codex",
    reviewerProvider: "claude",
    developerSessionId: "codex-session-1",
    reviewerSessionId: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    completedAt: null,
  };
}

function reviewerRun(structuredOutput: unknown): AgentRun {
  return {
    id: "review-run-1",
    taskId: "task-1",
    projectId: "project-1",
    provider: "claude",
    runType: "reviewer",
    status: "completed",
    reviewParseStatus: "pending",
    externalSessionId: "claude-session-1",
    processId: 777,
    exitCode: 0,
    prompt: "Review prompt",
    finalMessage: "Raw review result",
    structuredOutput,
    errorMessage: null,
    startedAt: "2026-07-18T00:00:01.000Z",
    finishedAt: "2026-07-18T00:00:02.000Z",
  };
}

class ReviewStarter {
  input: StartAgentRunInput | undefined;
  constructor(private readonly terminal: AgentRun) {}
  async start(input: StartAgentRunInput): Promise<StartedAgentRun> {
    this.input = input;
    return { run: { ...this.terminal, status: "queued" }, completion: Promise.resolve(this.terminal) };
  }
}

class MemoryReviewPersistence implements ReviewPersistencePort {
  readonly findings: ReviewFinding[] = [];
  readonly parseStatuses: string[] = [];
  readonly snapshots: string[] = [];

  async recordSnapshot(_taskId: string, snapshotHash: string): Promise<void> { this.snapshots.push(snapshotHash); }
  async replaceFindings(_taskId: string, _runId: string, findings: ReviewFinding[]): Promise<void> {
    this.findings.splice(0, this.findings.length, ...findings);
  }
  async setParseStatus(run: AgentRun, status: "succeeded" | "failed"): Promise<AgentRun> {
    this.parseStatuses.push(status);
    return { ...run, reviewParseStatus: status };
  }
}

function setup(structuredOutput: unknown, hashes = ["snapshot-start", "snapshot-start"]) {
  const terminal = reviewerRun(structuredOutput);
  const starter = new ReviewStarter(terminal);
  const persistence = new MemoryReviewPersistence();
  const captures = [...hashes];
  const context: ReviewContextPort = {
    async capture() {
      return {
        snapshotHash: captures.shift() ?? hashes.at(-1)!,
        gitStatus: " M src/input.ts",
        diffStat: "1 file changed, 3 insertions(+)",
      };
    },
  };
  const emitted: AgentEvent[] = [];
  let sequence = 0;
  const events = new EventService({
    async append(input) {
      const event = { ...input.event, sequence: ++sequence };
      emitted.push(event);
      return event;
    },
  }, { async broadcast() {} });
  const service = new ReviewService({
    agentRuns: starter,
    context,
    persistence,
    events,
    createId: (() => { let value = 0; return () => `finding-${++value}`; })(),
    now: () => "2026-07-18T00:00:03.000Z",
  });
  return { service, starter, persistence, emitted };
}

describe("Review prompt", () => {
  test("contains task, baseline, Git evidence, dimensions, and severity definitions", () => {
    const prompt = buildReviewPrompt({
      task: task(),
      gitStatus: " M src/input.ts",
      diffStat: "1 file changed",
    });

    expect(prompt).toContain("Add validation to user input.");
    expect(prompt).toContain("base-abc123");
    expect(prompt).toContain(" M src/input.ts");
    expect(prompt).toContain("1 file changed");
    expect(prompt).toContain("功能正确性");
    expect(prompt).toContain("P0");
    expect(prompt).toContain("P1");
    expect(prompt).toContain("P2");
    expect(prompt).toContain("不要修改文件");
  });
});

describe("ReviewService", () => {
  test("validates structured output, persists findings with severity defaults, and records snapshots", async () => {
    const { service, starter, persistence, emitted } = setup({
      summary: "Three findings",
      verdict: "changes_suggested",
      findings: [
        { severity: "P0", title: "Critical", description: "Critical issue", suggestion: "Fix now", file: "a.ts", startLine: 1, endLine: 1 },
        { severity: "P1", title: "Important", description: "Important issue", suggestion: "Fix", file: "b.ts", startLine: 2, endLine: 3 },
        { severity: "P2", title: "Optional", description: "Optional issue", suggestion: "Consider", file: null, startLine: null, endLine: null },
      ],
    });

    const started = await service.start(task());
    const outcome = await started.completion;

    expect(starter.input).toMatchObject({ runType: "reviewer", sessionId: undefined });
    expect(starter.input).toMatchObject({ snapshotHash: "snapshot-start" });
    expect(starter.input?.prompt).toContain("Add validation to user input.");
    expect(outcome.result?.summary).toBe("Three findings");
    expect(outcome.findings.map((finding) => finding.selected)).toEqual([true, true, false]);
    expect(outcome.findings.every((finding) => !finding.dismissed && finding.userNote === null)).toBe(true);
    expect(outcome.stale).toBe(false);
    expect(persistence.snapshots).toEqual([]);
    expect(persistence.parseStatuses).toEqual(["succeeded"]);
    expect(emitted.at(-1)?.type).toBe("review_parsed");
  });

  test("keeps a completed run, emits parse failure, and creates no findings for invalid schema", async () => {
    const { service, persistence, emitted } = setup({ summary: "Invalid", verdict: "unknown", findings: [] });

    const started = await service.start(task());
    const outcome = await started.completion;

    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.reviewParseStatus).toBe("failed");
    expect(outcome.result).toBeNull();
    expect(outcome.findings).toEqual([]);
    expect(persistence.parseStatuses).toEqual(["failed"]);
    expect(emitted.at(-1)?.type).toBe("review_parse_failed");
  });

  test("marks review output stale when the ending snapshot differs", async () => {
    const { service, emitted } = setup({ summary: "Pass", verdict: "pass", findings: [] }, ["snapshot-start", "snapshot-end"]);

    const outcome = await (await service.start(task())).completion;

    expect(outcome.stale).toBe(true);
    expect(outcome.startSnapshotHash).toBe("snapshot-start");
    expect(outcome.endSnapshotHash).toBe("snapshot-end");
    expect(emitted.at(-1)?.payload).toMatchObject({
      stale: true,
      startSnapshotHash: "snapshot-start",
      endSnapshotHash: "snapshot-end",
    });
  });
});
