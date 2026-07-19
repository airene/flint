import type { ApprovalDecision, ApprovalRequest } from "@local-pair-review/shared";

export type ApprovalCardState = "pending" | "resolving" | "allowed" | "denied" | "expired" | "retry";

export interface ApprovalCardDecision {
  decision: ApprovalDecision;
  reason: string | null;
}

export interface ApprovalCardDisplay {
  state: ApprovalCardState;
  canDecide: boolean;
  reason: string | null;
  error: string | null;
  lockedDecision: ApprovalDecision | null;
}

export interface ApprovalCardDisplayOptions {
  resolving?: boolean;
  error?: string | null;
}

export function approvalCardDisplay(
  request: ApprovalRequest,
  options: ApprovalCardDisplayOptions = {},
): ApprovalCardDisplay {
  if (request.status === "expired") return { state: "expired", canDecide: false, reason: null, error: null, lockedDecision: null };
  if (request.status === "resolved") {
    return {
      state: request.decision === "allow_once" ? "allowed" : "denied",
      canDecide: false,
      reason: request.reason,
      error: null,
      lockedDecision: request.decision,
    };
  }
  if (options.resolving) return { state: "resolving", canDecide: false, reason: request.reason, error: null, lockedDecision: request.decision };
  if (request.status === "resolving") {
    return { state: "retry", canDecide: true, reason: request.reason, error: options.error ?? null, lockedDecision: request.decision };
  }
  if (options.error) return { state: "retry", canDecide: true, reason: null, error: options.error, lockedDecision: null };
  return { state: "pending", canDecide: true, reason: null, error: null, lockedDecision: null };
}

export function createApprovalCardController(request: ApprovalRequest) {
  let resolving = false;
  let error: string | null = null;

  return {
    display: () => approvalCardDisplay(request, { resolving, error }),
    submit(decision: ApprovalDecision, reason: string | null = null): ApprovalCardDecision | null {
      const display = approvalCardDisplay(request, { resolving, error });
      if (!display.canDecide || (display.lockedDecision && display.lockedDecision !== decision)) return null;
      resolving = true;
      error = null;
      return {
        decision: display.lockedDecision ?? decision,
        reason: display.lockedDecision ? request.reason : decision === "deny" ? reason?.trim() || null : null,
      };
    },
    retry(message: string | null = null): void {
      resolving = false;
      error = message;
    },
  };
}
