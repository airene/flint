import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@local-pair-review/shared";
import { approvalCardDisplay, createApprovalCardController } from "../../apps/web/src/components/approval-card";

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    projectId: "project-1",
    taskId: "task-1",
    runId: "run-1",
    providerRequestId: "provider-request-1",
    toolName: "shell",
    actionSummary: "Run the test suite",
    workingDirectory: "/repo",
    status: "pending",
    decision: null,
    reason: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

describe("approvalCardDisplay", () => {
  test("maps pending, resolving, resolved, expired, and retry states to a safe card model", () => {
    expect(approvalCardDisplay(approval())).toMatchObject({ state: "pending", canDecide: true });
    expect(approvalCardDisplay(approval(), { resolving: true })).toMatchObject({ state: "resolving", canDecide: false });
    expect(approvalCardDisplay(approval({ status: "resolving", decision: "allow_once" }))).toMatchObject({
      state: "retry", canDecide: true, lockedDecision: "allow_once",
    });
    expect(approvalCardDisplay(approval({ status: "resolved", decision: "allow_once", resolvedAt: "2026-07-19T00:01:00.000Z" }))).toMatchObject({ state: "allowed", canDecide: false });
    expect(approvalCardDisplay(approval({ status: "resolved", decision: "deny", reason: "Needs review", resolvedAt: "2026-07-19T00:01:00.000Z" }))).toMatchObject({ state: "denied", reason: "Needs review", canDecide: false });
    expect(approvalCardDisplay(approval({ status: "expired", resolvedAt: "2026-07-19T00:01:00.000Z" }))).toMatchObject({ state: "expired", canDecide: false });
    expect(approvalCardDisplay(approval(), { error: "Connection lost" })).toMatchObject({ state: "retry", error: "Connection lost", canDecide: true });
  });

  test("allows a resolving request to retry only its persisted first decision", () => {
    const controller = createApprovalCardController(approval({ status: "resolving", decision: "deny", reason: "unsafe" }));

    expect(controller.submit("allow_once")).toBeNull();
    expect(controller.submit("deny", "replacement")).toEqual({ decision: "deny", reason: "unsafe" });
  });
});

describe("createApprovalCardController", () => {
  test("emits one typed decision, preserves an optional deny reason, and prevents duplicate clicks while resolving", () => {
    const controller = createApprovalCardController(approval());

    expect(controller.submit("deny", "Not safe yet")).toEqual({ decision: "deny", reason: "Not safe yet" });
    expect(controller.submit("allow_once")).toBeNull();
    expect(controller.display()).toMatchObject({ state: "resolving", canDecide: false });

    controller.retry();
    expect(controller.submit("allow_once")).toEqual({ decision: "allow_once", reason: null });
  });
});
