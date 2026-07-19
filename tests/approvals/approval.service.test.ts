import { describe, expect, test } from "bun:test";
import type { AgentRun, ApprovalDecision, ApprovalRequest, ProviderCapabilities } from "@local-pair-review/shared";
import {
  ApprovalService,
  ReviewerApprovalRequestError,
  type ApprovalPersistencePort,
  type ApprovalProviderControl,
  type SecurityErrorPort,
} from "../../apps/server/src/services/approval.service";
import { UnsupportedProviderCapabilityError } from "../../apps/server/src/drivers/agent-control";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    projectId: "project-1",
    taskId: "task-1",
    provider: "codex",
    runType: "developer_initial",
    status: "running",
    reviewParseStatus: null,
    externalSessionId: null,
    processId: 42,
    exitCode: null,
    prompt: "Implement safe approvals.",
    finalMessage: null,
    structuredOutput: null,
    errorMessage: null,
    startedAt: "2026-07-19T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

const approvalCapabilities: ProviderCapabilities = {
  developerInitialImage: false,
  developerResumeImage: false,
  reviewerInitialImage: false,
  reviewerResumeImage: false,
  liveMessages: false,
  interrupt: true,
  approvals: true,
};

class MemoryApprovals implements ApprovalPersistencePort {
  readonly records = new Map<string, ApprovalRequest>();
  readonly providerKeys = new Map<string, string>();
  decisionFailure: Error | null = null;

  async createApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    const key = `${request.runId}:${request.providerRequestId}`;
    const existing = this.providerKeys.get(key);
    if (existing) return this.records.get(existing)!;
    this.providerKeys.set(key, request.id);
    this.records.set(request.id, request);
    return request;
  }

  async getApproval(approvalId: string): Promise<ApprovalRequest> {
    const approval = this.records.get(approvalId);
    if (!approval) throw new Error("approval not found");
    return approval;
  }

  async decideApproval(approvalId: string, decision: ApprovalDecision, reason: string | null, resolvedAt: string) {
    if (this.decisionFailure) throw this.decisionFailure;
    const approval = this.records.get(approvalId);
    if (!approval) throw new Error("approval not found");
    if (approval.status !== "pending") return { approval, resolvedNow: false };
    const resolved = { ...approval, status: "resolved" as const, decision, reason, resolvedAt };
    this.records.set(approvalId, resolved);
    return { approval: resolved, resolvedNow: true };
  }

  async expireApprovals(runId: string, expiredAt: string): Promise<ApprovalRequest[]> {
    for (const [id, approval] of this.records) {
      if (approval.runId === runId && approval.status === "pending") {
        this.records.set(id, { ...approval, status: "expired", resolvedAt: expiredAt });
      }
    }
    return [...this.records.values()].filter((approval) => approval.runId === runId);
  }

  async providerForRun(_runId: string): Promise<"codex"> {
    return "codex";
  }
}

class Control implements ApprovalProviderControl {
  readonly calls: Array<{ runId: string; providerRequestId: string; decision: ApprovalDecision }> = [];
  failure: Error | null = null;
  gate: Promise<void> | null = null;
  constructor(readonly capabilities: ProviderCapabilities = approvalCapabilities) {}
  async resolveApproval(runId: string, providerRequestId: string, decision: ApprovalDecision): Promise<void> {
    this.calls.push({ runId, providerRequestId, decision });
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
  }
}

class SecurityErrors implements SecurityErrorPort {
  readonly errors: Array<{ runId: string; message: string }> = [];
  async recordSecurityError(runId: string, message: string): Promise<void> {
    this.errors.push({ runId, message });
  }
}

function createService(control = new Control()) {
  const persistence = new MemoryApprovals();
  const security = new SecurityErrors();
  return {
    control,
    persistence,
    security,
    service: new ApprovalService({
      controls: { codex: control, claude: control },
      persistence,
      security,
      createId: () => "approval-1",
      now: () => "2026-07-19T00:00:01.000Z",
    }),
  };
}

describe("ApprovalService", () => {
  test("creates one durable redacted request from a structured provider request", async () => {
    const { service } = createService();

    const approval = await service.request(run(), {
      providerRequestId: "provider-request-1",
      toolName: "shell",
      actionSummary: "curl -H 'Authorization: Bearer secret-value' https://example.test",
      workingDirectory: "/repo",
    });

    expect(approval).toMatchObject({
      id: "approval-1",
      runId: "run-1",
      providerRequestId: "provider-request-1",
      status: "pending",
      decision: null,
    });
    expect(approval.actionSummary).toContain("[REDACTED]");
    expect(approval.actionSummary).not.toContain("secret-value");
  });

  test("resolves a pending request exactly once and returns the first decision on retries", async () => {
    const { service, control } = createService();
    const approval = await service.request(run(), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
    });

    const first = await service.decide(approval.id, "allow_once");
    const retry = await service.decide(approval.id, "deny", "too late");

    expect(first).toMatchObject({ status: "resolved", decision: "allow_once", resolvedAt: "2026-07-19T00:00:01.000Z" });
    expect(retry).toEqual(first);
    expect(control.calls).toEqual([{ runId: "run-1", providerRequestId: "provider-request-1", decision: "allow_once" }]);
  });

  test("keeps a request pending after relay failure and permits a later retry", async () => {
    const control = new Control();
    control.failure = new Error("provider relay failed");
    const { service, persistence } = createService(control);
    const approval = await service.request(run(), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
    });

    await expect(service.decide(approval.id, "allow_once")).rejects.toThrow("provider relay failed");
    expect(await persistence.getApproval(approval.id)).toEqual(approval);

    control.failure = null;
    const resolved = await service.decide(approval.id, "allow_once");

    expect(resolved).toMatchObject({ status: "resolved", decision: "allow_once" });
    expect(control.calls).toHaveLength(2);
  });

  test("coalesces concurrent decisions so the provider receives only the first one", async () => {
    let release!: () => void;
    const control = new Control();
    control.gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = createService(control);
    const approval = await service.request(run(), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
    });

    const first = service.decide(approval.id, "allow_once");
    const duplicate = service.decide(approval.id, "deny", "duplicate click");
    release();

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ status: "resolved", decision: "allow_once" });
    expect(control.calls).toEqual([{ runId: "run-1", providerRequestId: "provider-request-1", decision: "allow_once" }]);
  });

  test("retries an idempotent provider relay when persistence failed after provider success", async () => {
    const { service, persistence, control } = createService();
    const approval = await service.request(run(), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
    });
    persistence.decisionFailure = new Error("database write failed");

    await expect(service.decide(approval.id, "allow_once")).rejects.toThrow("database write failed");
    expect(await persistence.getApproval(approval.id)).toEqual(approval);

    persistence.decisionFailure = null;
    expect(await service.decide(approval.id, "allow_once")).toMatchObject({ status: "resolved", decision: "allow_once" });
    expect(control.calls).toHaveLength(2);
  });

  test("expires unresolved requests when a run terminates", async () => {
    const { service } = createService();
    const approval = await service.request(run(), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
    });

    const expired = await service.expireRun(run({ status: "failed", finishedAt: "2026-07-19T00:00:02.000Z" }));

    expect(expired).toEqual([{ ...approval, status: "expired", resolvedAt: "2026-07-19T00:00:01.000Z" }]);
  });

  test("rejects reviewer approval requests and records the security error", async () => {
    const { service, persistence, security } = createService();

    await expect(service.request(run({ runType: "reviewer", provider: "claude" }), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Write file", workingDirectory: "/repo",
    })).rejects.toBeInstanceOf(ReviewerApprovalRequestError);

    expect(persistence.records.size).toBe(0);
    expect(security.errors).toEqual([{ runId: "run-1", message: "Reviewer runs cannot request approvals." }]);
  });

  test("returns a typed capability error without creating a pending request", async () => {
    const unsupported = new Control({ ...approvalCapabilities, approvals: false });
    const { service, persistence } = createService(unsupported);

    await expect(service.request(run(), {
      providerRequestId: "provider-request-1", toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
    })).rejects.toEqual(new UnsupportedProviderCapabilityError("codex", "approvals"));

    expect(persistence.records.size).toBe(0);
  });

  test("rejects late requests from every terminal run state without creating a pending record", async () => {
    const { service, persistence } = createService();

    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      await expect(service.request(run({ status, finishedAt: "2026-07-19T00:00:02.000Z" }), {
        providerRequestId: `provider-request-${status}`, toolName: "shell", actionSummary: "Run tests", workingDirectory: "/repo",
      })).rejects.toMatchObject({
        name: "TerminalRunApprovalRequestError",
        code: "TERMINAL_RUN_APPROVAL_REQUEST",
        runId: "run-1",
        status,
      });
    }

    expect(persistence.records.size).toBe(0);
  });
});
