import { describe, expect, test } from "bun:test";
import type { AgentRun, FeedbackDelivery, ReviewFinding, Task } from "@local-pair-review/shared";
import type { StartAgentRunInput, StartedAgentRun } from "../../apps/server/src/services/agent-run.service";
import {
  composeFeedback,
  DuplicateFeedbackError,
  FeedbackService,
  type FeedbackDeliveryPersistencePort,
} from "../../apps/server/src/services/feedback.service";

function task(sessionId: string | null = "codex-session-exact"): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    originalPrompt: "Implement safe input handling.",
    workingDirectory: "/tmp/project",
    baseCommit: "abc123",
    latestSnapshotHash: "snapshot-1",
    status: "waiting_for_human",
    developerSessionId: sessionId,
    reviewerSessionId: "claude-session-1",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    completedAt: null,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "finding-1",
    taskId: "task-1",
    runId: "review-run-1",
    severity: "P1",
    title: "Validate input",
    description: "Input reaches the parser unchecked.",
    suggestion: "Validate before parsing.",
    file: "src/input.ts",
    startLine: 7,
    endLine: 9,
    selected: true,
    dismissed: false,
    userNote: "Keep the existing public error shape.",
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function developerRun(status: AgentRun["status"] = "completed"): AgentRun {
  return {
    id: "developer-feedback-run-1",
    taskId: "task-1",
    projectId: "project-1",
    provider: "codex",
    runType: "developer_feedback",
    status,
    reviewParseStatus: null,
    externalSessionId: "codex-session-exact",
    processId: 123,
    exitCode: status === "completed" ? 0 : 1,
    prompt: "feedback",
    finalMessage: status === "completed" ? "Fixed" : null,
    structuredOutput: null,
    errorMessage: status === "completed" ? null : "failed",
    startedAt: "2026-07-18T00:00:01.000Z",
    finishedAt: "2026-07-18T00:00:02.000Z",
  };
}

class FeedbackStarter {
  input: StartAgentRunInput | undefined;
  constructor(private readonly terminal = developerRun()) {}
  async start(input: StartAgentRunInput): Promise<StartedAgentRun> {
    this.input = input;
    return { run: { ...this.terminal, status: "queued" }, completion: Promise.resolve(this.terminal) };
  }
}

class MemoryDeliveryPersistence implements FeedbackDeliveryPersistencePort {
  readonly deliveries = new Map<string, FeedbackDelivery>();
  markedSent = false;
  allowStart = true;

  async reserve(candidate: FeedbackDelivery) {
    this.deliveries.set(candidate.id, candidate);
    return { delivery: candidate, allowStart: this.allowStart };
  }

  async attachRun(deliveryId: string, runId: string): Promise<FeedbackDelivery> {
    const delivery = { ...this.deliveries.get(deliveryId)!, targetDeveloperRunId: runId };
    this.deliveries.set(deliveryId, delivery);
    return delivery;
  }

  async markSent(deliveryId: string, sentAt: string): Promise<FeedbackDelivery> {
    this.markedSent = true;
    const delivery = { ...this.deliveries.get(deliveryId)!, sentAt };
    this.deliveries.set(deliveryId, delivery);
    return delivery;
  }
}

describe("Feedback composer", () => {
  test("uses selected non-dismissed findings in review order with human notes", () => {
    const text = composeFeedback(task(), [
      finding(),
      finding({ id: "finding-2", severity: "P2", title: "Dismissed", selected: true, dismissed: true }),
      finding({ id: "finding-3", severity: "P2", title: "Not selected", selected: false }),
    ]);

    expect(text).toContain("Implement safe input handling.");
    expect(text).toContain("## P1 - Validate input");
    expect(text).toContain("src/input.ts");
    expect(text).toContain("7-9");
    expect(text).toContain("Keep the existing public error shape.");
    expect(text).not.toContain("Dismissed");
    expect(text).not.toContain("Not selected");
  });
});

describe("FeedbackService", () => {
  test("reserves a delivery, resumes the exact Codex session, and marks sent only on completion", async () => {
    const starter = new FeedbackStarter();
    const persistence = new MemoryDeliveryPersistence();
    const service = new FeedbackService({
      agentRuns: starter,
      persistence,
      createId: () => "delivery-1",
      now: () => "2026-07-18T00:00:03.000Z",
    });

    const started = await service.send({
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Please fix the confirmed finding.",
    });
    const completed = await started.completion;

    expect(starter.input).toMatchObject({
      runType: "developer_feedback",
      sessionId: "codex-session-exact",
      prompt: "Please fix the confirmed finding.",
    });
    expect(started.delivery.targetDeveloperRunId).toBe("developer-feedback-run-1");
    expect(completed.run.status).toBe("completed");
    expect(completed.delivery.sentAt).toBe("2026-07-18T00:00:03.000Z");
    expect(persistence.markedSent).toBe(true);
  });

  test("rejects an atomically detected duplicate without launching another run", async () => {
    const starter = new FeedbackStarter();
    const persistence = new MemoryDeliveryPersistence();
    persistence.allowStart = false;
    const service = new FeedbackService({ agentRuns: starter, persistence });

    await expect(service.send({
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Same feedback",
    })).rejects.toBeInstanceOf(DuplicateFeedbackError);
    expect(starter.input).toBeUndefined();
  });

  test("requires a persisted exact developer session", async () => {
    const service = new FeedbackService({
      agentRuns: new FeedbackStarter(),
      persistence: new MemoryDeliveryPersistence(),
    });

    await expect(service.send({
      task: task(null),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: [],
      finalText: "Continue",
    })).rejects.toThrow("exact Codex session");
  });
});
