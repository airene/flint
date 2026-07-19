import type { AgentRunType, TaskStatus } from "@local-pair-review/shared";

export type TaskStatusPolicy = "transition" | "preserve_current";

export function taskStatusPolicyForRun(runType: AgentRunType): TaskStatusPolicy {
  return runType === "reviewer_followup" ? "preserve_current" : "transition";
}

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Cannot transition task from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["developing"],
  developing: ["ready_for_review"],
  ready_for_review: ["reviewing", "fixing"],
  reviewing: ["waiting_for_human"],
  waiting_for_human: ["fixing", "reviewing", "completed"],
  fixing: ["ready_for_review"],
  completed: [],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from].includes(to)) throw new InvalidTaskTransitionError(from, to);
}

export function taskStatusForRunStart(status: TaskStatus, runType: AgentRunType): TaskStatus {
  if (runType === "reviewer_followup") return status;
  const target = runType === "developer_initial"
    ? "developing"
    : runType === "developer_feedback" || runType === "developer_followup"
      ? "fixing"
      : "reviewing";
  assertTaskTransition(status, target);
  return target;
}

export function taskStatusForRunSuccess(
  runType: AgentRunType,
): TaskStatus {
  if (runType === "reviewer_followup") {
    throw new Error("Reviewer follow-up terminal persistence must preserve current Task status");
  }
  return runType === "reviewer" ? "waiting_for_human" : "ready_for_review";
}

export function taskStatusForRunFailure(
  runType: AgentRunType,
  context: {
    hasDeveloperSession: boolean;
    workingTreeChanged: boolean;
  },
): TaskStatus {
  if (runType === "reviewer_followup") {
    throw new Error("Reviewer follow-up terminal persistence must preserve current Task status");
  }
  if (runType !== "developer_initial") return "ready_for_review";
  return context.hasDeveloperSession || context.workingTreeChanged ? "ready_for_review" : "draft";
}
