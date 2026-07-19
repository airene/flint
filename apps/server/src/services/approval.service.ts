import { approvalDecisionSchema, type AgentRun, type ApprovalDecision, type ApprovalRequest, type Provider, type ProviderCapabilities } from "@local-pair-review/shared";
import { UnsupportedProviderCapabilityError } from "../drivers/agent-control";
import { redactSensitive } from "../utils/redact";

// TODO(approvals): This subsystem is intentionally dormant in production. No driver sets
// `capabilities.approvals = true` and nothing calls `ApprovalService.request`, so approval
// requests are never created. Root cause: the streaming CLI drivers write the prompt to
// stdin once and close it (see `StreamingCliDriver.run`), then read the CLI event stream
// one-way — there is no back-channel to answer a mid-run approval prompt, so `resolveApproval`
// throws. Flint instead runs the CLIs headless within a fixed permission envelope (codex
// `--sandbox`, claude `--permission-mode`) and relies on each CLI's own config to auto-approve
// (see README "无人值守运行与 CLI 审批配置"). Enabling in-app approvals needs a bidirectional
// driver that keeps stdin open, parses an approval-request event → `ApprovalService.request`,
// relays the decision via `resolveApproval`, and flips the capability flag. Before enabling,
// also handle the "resolving" stuck-state (`expireApprovals` only clears "pending").

export interface ApprovalProviderControl {
  readonly capabilities: Pick<ProviderCapabilities, "approvals">;
  /** Must be idempotent for the same Run and provider request ID. */
  resolveApproval(runId: string, providerRequestId: string, decision: ApprovalDecision): Promise<void>;
}

export interface ApprovalPersistencePort {
  /** Must atomically persist the request or return the existing request for the same run and provider request ID. */
  createApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest>;
  getApproval(approvalId: string): Promise<ApprovalRequest>;
  /** Atomically reserves the first decision (pending -> resolving) or returns the stored decision unchanged. */
  reserveDecision(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string | null,
  ): Promise<ApprovalRequest>;
  /** Completes a successfully relayed resolving request (resolving -> resolved). */
  completeDecision(approvalId: string, resolvedAt: string): Promise<ApprovalRequest>;
  /** Must expire only pending requests for the supplied terminal Run. */
  expireApprovals(runId: string, expiredAt: string): Promise<ApprovalRequest[]>;
  /** Returns the immutable provider selected for the Run that owns this approval. */
  providerForRun(runId: string): Promise<Provider>;
}

export interface SecurityErrorPort {
  recordSecurityError(runId: string, message: string): Promise<void>;
}

export interface ProviderApprovalRequest {
  providerRequestId: string;
  toolName: string;
  actionSummary: string;
  workingDirectory: string;
}

export class ReviewerApprovalRequestError extends Error {
  readonly code = "REVIEWER_APPROVAL_REJECTED" as const;

  constructor(readonly runId: string) {
    super("Reviewer runs cannot request approvals.");
    this.name = "ReviewerApprovalRequestError";
  }
}

export class TerminalRunApprovalRequestError extends Error {
  readonly code = "TERMINAL_RUN_APPROVAL_REQUEST" as const;

  constructor(readonly runId: string, readonly status: AgentRun["status"]) {
    super(`Run ${runId} is already ${status} and cannot request approval.`);
    this.name = "TerminalRunApprovalRequestError";
  }
}

interface ApprovalServiceOptions {
  controls: Record<Provider, ApprovalProviderControl>;
  persistence: ApprovalPersistencePort;
  security: SecurityErrorPort;
  createId?: () => string;
  now?: () => string;
}

function isReviewerRun(run: AgentRun): boolean {
  return run.runType === "reviewer" || run.runType === "reviewer_followup";
}

function isTerminal(run: AgentRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
}

function redactedSummary(summary: string): string {
  return redactSensitive(summary);
}

export class ApprovalService {
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly decisionsInFlight = new Map<string, Promise<ApprovalRequest>>();

  constructor(private readonly options: ApprovalServiceOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async request(run: AgentRun, input: ProviderApprovalRequest): Promise<ApprovalRequest> {
    if (isReviewerRun(run)) {
      const error = new ReviewerApprovalRequestError(run.id);
      await this.options.security.recordSecurityError(run.id, error.message);
      throw error;
    }
    if (isTerminal(run)) throw new TerminalRunApprovalRequestError(run.id, run.status);

    const control = this.options.controls[run.provider];
    if (!control.capabilities.approvals) throw new UnsupportedProviderCapabilityError(run.provider, "approvals");

    return await this.options.persistence.createApprovalRequest({
      id: this.createId(),
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      providerRequestId: input.providerRequestId,
      toolName: redactedSummary(input.toolName),
      actionSummary: redactedSummary(input.actionSummary),
      workingDirectory: input.workingDirectory,
      status: "pending",
      decision: null,
      reason: null,
      createdAt: this.now(),
      resolvedAt: null,
    });
  }

  async decide(approvalId: string, decision: ApprovalDecision, reason: string | null = null): Promise<ApprovalRequest> {
    approvalDecisionSchema.parse(decision);
    const active = this.decisionsInFlight.get(approvalId);
    if (active) return await active;

    const operation = this.relayAndPersist(approvalId, decision, reason);
    this.decisionsInFlight.set(approvalId, operation);
    try {
      return await operation;
    } finally {
      if (this.decisionsInFlight.get(approvalId) === operation) this.decisionsInFlight.delete(approvalId);
    }
  }

  private async relayAndPersist(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string | null,
  ): Promise<ApprovalRequest> {
    const existing = await this.options.persistence.getApproval(approvalId);
    if (existing.status === "resolved" || existing.status === "expired") return existing;

    const provider = await this.options.persistence.providerForRun(existing.runId);
    const control = this.options.controls[provider];
    if (!control.capabilities.approvals) throw new UnsupportedProviderCapabilityError(provider, "approvals");

    const reserved = existing.status === "pending"
      ? await this.options.persistence.reserveDecision(approvalId, decision, reason)
      : existing;
    if (reserved.status !== "resolving" || !reserved.decision) return reserved;

    await control.resolveApproval(reserved.runId, reserved.providerRequestId, reserved.decision);
    return await this.options.persistence.completeDecision(approvalId, this.now());
  }

  async expireRun(run: AgentRun): Promise<ApprovalRequest[]> {
    if (!isTerminal(run)) return [];
    return await this.options.persistence.expireApprovals(run.id, this.now());
  }
}
