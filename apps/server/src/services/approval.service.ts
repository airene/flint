import { approvalDecisionSchema, type AgentRun, type ApprovalDecision, type ApprovalRequest, type Provider, type ProviderCapabilities } from "@local-pair-review/shared";
import { UnsupportedProviderCapabilityError } from "../drivers/agent-control";
import { redactSensitive } from "../utils/redact";

export interface ApprovalProviderControl {
  readonly capabilities: Pick<ProviderCapabilities, "approvals">;
  resolveApproval(runId: string, providerRequestId: string, decision: ApprovalDecision): Promise<void>;
}

export interface ApprovalPersistencePort {
  /** Must atomically persist the request or return the existing request for the same run and provider request ID. */
  createApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest>;
  getApproval(approvalId: string): Promise<ApprovalRequest>;
  /** Must atomically resolve a pending request and report whether this call won the transition. */
  decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string | null,
    resolvedAt: string,
  ): Promise<{ approval: ApprovalRequest; resolvedNow: boolean }>;
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
    const existing = await this.options.persistence.getApproval(approvalId);
    if (existing.status !== "pending") return existing;

    const provider = await this.options.persistence.providerForRun(existing.runId);
    const control = this.options.controls[provider];
    if (!control.capabilities.approvals) throw new UnsupportedProviderCapabilityError(provider, "approvals");

    const result = await this.options.persistence.decideApproval(approvalId, decision, reason, this.now());
    if (!result.resolvedNow) return result.approval;

    await control.resolveApproval(result.approval.runId, result.approval.providerRequestId, decision);
    return result.approval;
  }

  async expireRun(run: AgentRun): Promise<ApprovalRequest[]> {
    if (!isTerminal(run)) return [];
    return await this.options.persistence.expireApprovals(run.id, this.now());
  }
}
