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
  readonly cancelledRunIds: string[] = [];
  startCalls = 0;
  startError: Error | null = null;
  constructor(private readonly terminal = developerRun()) {}
  async start(input: StartAgentRunInput): Promise<StartedAgentRun> {
    this.startCalls += 1;
    this.input = input;
    if (this.startError) throw this.startError;
    return { run: { ...this.terminal, status: "queued" }, completion: Promise.resolve(this.terminal) };
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRunIds.push(runId);
  }
}

class MemoryDeliveryPersistence implements FeedbackDeliveryPersistencePort {
  readonly deliveries = new Map<string, FeedbackDelivery>();
  readonly deliveryIdsByFingerprint = new Map<string, string>();
  readonly activeLeases = new Map<string, string>();
  markedSent = false;
  allowStart = true;
  attachError: Error | null = null;

  private fingerprint(delivery: FeedbackDelivery): string {
    return JSON.stringify([
      delivery.taskId,
      delivery.sourceReviewRunId,
      delivery.selectedFindingIds,
      delivery.finalText,
    ]);
  }

  async reserve(candidate: FeedbackDelivery, leaseToken: string) {
    const fingerprint = this.fingerprint(candidate);
    const existingId = this.deliveryIdsByFingerprint.get(fingerprint);
    const delivery = existingId ? this.deliveries.get(existingId)! : candidate;
    if (!existingId) {
      this.deliveryIdsByFingerprint.set(fingerprint, candidate.id);
      this.deliveries.set(candidate.id, candidate);
    }
    if (!this.allowStart || delivery.sentAt !== null || this.activeLeases.has(delivery.id)) {
      return { delivery, allowStart: false };
    }
    this.activeLeases.set(delivery.id, leaseToken);
    return { delivery, allowStart: true };
  }

  async attachRun(deliveryId: string, runId: string, leaseToken: string): Promise<FeedbackDelivery> {
    this.assertLease(deliveryId, leaseToken);
    if (this.attachError) throw this.attachError;
    const delivery = { ...this.deliveries.get(deliveryId)!, targetDeveloperRunId: runId };
    this.deliveries.set(deliveryId, delivery);
    return delivery;
  }

  async release(deliveryId: string, leaseToken: string): Promise<void> {
    this.assertLease(deliveryId, leaseToken);
    this.activeLeases.delete(deliveryId);
  }

  async markSent(deliveryId: string, leaseToken: string, sentAt: string): Promise<FeedbackDelivery> {
    this.assertLease(deliveryId, leaseToken);
    this.markedSent = true;
    const delivery = { ...this.deliveries.get(deliveryId)!, sentAt };
    this.deliveries.set(deliveryId, delivery);
    this.activeLeases.delete(deliveryId);
    return delivery;
  }

  expireLease(deliveryId: string): void {
    this.activeLeases.delete(deliveryId);
  }

  private assertLease(deliveryId: string, leaseToken: string): void {
    if (this.activeLeases.get(deliveryId) !== leaseToken) throw new Error("stale feedback lease");
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

  test("atomically starts only one run for concurrent identical feedback", async () => {
    const starter = new FeedbackStarter();
    const persistence = new MemoryDeliveryPersistence();
    let id = 0;
    const service = new FeedbackService({
      agentRuns: starter,
      persistence,
      createId: () => `delivery-${++id}`,
      createLeaseToken: () => `lease-${id}`,
    });
    const input = {
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Same feedback",
    };

    const results = await Promise.allSettled([service.send(input), service.send(input)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DuplicateFeedbackError);
    expect(starter.startCalls).toBe(1);
  });

  test("releases the reservation when starting the run fails so a retry can start", async () => {
    const starter = new FeedbackStarter();
    starter.startError = new Error("spawn failed");
    const persistence = new MemoryDeliveryPersistence();
    let id = 0;
    const service = new FeedbackService({
      agentRuns: starter,
      persistence,
      createId: () => `delivery-${++id}`,
      createLeaseToken: () => `lease-${id}`,
    });
    const input = {
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Retryable feedback",
    };

    await expect(service.send(input)).rejects.toThrow("spawn failed");
    starter.startError = null;
    const retried = await service.send(input);

    expect(retried.delivery.id).toBe("delivery-1");
    expect(retried.run.id).toBe("developer-feedback-run-1");
  });

  test("cancels the started run and releases the reservation when attaching it fails", async () => {
    const starter = new FeedbackStarter();
    const persistence = new MemoryDeliveryPersistence();
    persistence.attachError = new Error("attach failed");
    let id = 0;
    const service = new FeedbackService({
      agentRuns: starter,
      persistence,
      createId: () => `delivery-${++id}`,
      createLeaseToken: () => `lease-${id}`,
    });
    const input = {
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Retry after attach failure",
    };

    await expect(service.send(input)).rejects.toThrow("attach failed");
    expect(starter.cancelledRunIds).toEqual(["developer-feedback-run-1"]);
    persistence.attachError = null;
    const retried = await service.send(input);

    expect(retried.delivery.id).toBe("delivery-1");
  });

  test("releases the reservation after a failed run so the retained draft can be retried", async () => {
    const persistence = new MemoryDeliveryPersistence();
    let id = 0;
    const options = {
      persistence,
      createId: () => `delivery-${++id}`,
      createLeaseToken: () => `lease-${id}`,
    };
    const input = {
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Retry after terminal failure",
    };
    const failed = await new FeedbackService({
      ...options,
      agentRuns: new FeedbackStarter(developerRun("failed")),
    }).send(input);

    expect((await failed.completion).run.status).toBe("failed");
    const retried = await new FeedbackService({
      ...options,
      agentRuns: new FeedbackStarter(),
    }).send(input);

    expect(retried.delivery.id).toBe("delivery-1");
  });

  test("does not let an old completion mark a delivery sent after a new lease is reserved", async () => {
    let completeFirst!: (run: AgentRun) => void;
    const firstCompletion = new Promise<AgentRun>((resolve) => { completeFirst = resolve; });
    let startCount = 0;
    const starter = {
      cancelledRunIds: [] as string[],
      async start(): Promise<StartedAgentRun> {
        startCount += 1;
        const run = { ...developerRun(), id: `developer-feedback-run-${startCount}`, status: "queued" as const };
        return {
          run,
          completion: startCount === 1 ? firstCompletion : Promise.resolve(developerRun()),
        };
      },
      async cancel(runId: string): Promise<void> {
        this.cancelledRunIds.push(runId);
      },
    };
    const persistence = new MemoryDeliveryPersistence();
    let id = 0;
    const service = new FeedbackService({
      agentRuns: starter,
      persistence,
      createId: () => `delivery-${++id}`,
      createLeaseToken: () => `lease-${id}`,
    });
    const input = {
      task: task(),
      sourceReviewRunId: "review-run-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Lease protected feedback",
    };

    const first = await service.send(input);
    persistence.expireLease(first.delivery.id);
    await service.send(input);
    completeFirst(developerRun());

    await expect(first.completion).rejects.toThrow("stale feedback lease");
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
