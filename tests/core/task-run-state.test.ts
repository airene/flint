import { describe, expect, test } from "bun:test";
import type { TaskStatus } from "@local-pair-review/shared";
import {
  assertTaskTransition,
  taskStatusPolicyForRun,
  taskStatusForRunFailure,
  taskStatusForRunStart,
  taskStatusForRunSuccess,
} from "../../apps/server/src/services/task-run-state";

describe("task run state policy", () => {
  test("owns manual transitions and run start transitions", () => {
    expect(() => assertTaskTransition("draft", "developing")).not.toThrow();
    expect(() => assertTaskTransition("draft", "reviewing")).toThrow("Cannot transition task");
    expect(taskStatusForRunStart("draft", "developer_initial")).toBe("developing");
    expect(taskStatusForRunStart("waiting_for_human", "developer_feedback")).toBe("fixing");
    expect(taskStatusForRunStart("ready_for_review", "reviewer")).toBe("reviewing");
    expect(() => taskStatusForRunStart("developing", "reviewer")).toThrow("Cannot transition task");
  });

  test("owns success and conservative failure fallbacks", () => {
    expect(taskStatusForRunSuccess("developer_initial")).toBe("ready_for_review");
    expect(taskStatusForRunSuccess("developer_feedback")).toBe("ready_for_review");
    expect(taskStatusForRunSuccess("reviewer")).toBe("waiting_for_human");
    expect(taskStatusForRunFailure("developer_initial", {
      hasDeveloperSession: false,
      workingTreeChanged: false,
    })).toBe("draft");
    expect(taskStatusForRunFailure("developer_initial", {
      hasDeveloperSession: true,
      workingTreeChanged: false,
    })).toBe("ready_for_review");
    expect(taskStatusForRunFailure("developer_initial", {
      hasDeveloperSession: false,
      workingTreeChanged: true,
    })).toBe("ready_for_review");
    expect(taskStatusForRunFailure("developer_feedback", {
      hasDeveloperSession: true,
      workingTreeChanged: true,
    })).toBe("ready_for_review");
    expect(taskStatusForRunFailure("reviewer", {
      hasDeveloperSession: false,
      workingTreeChanged: false,
    })).toBe("ready_for_review");
  });

  test("gives follow-up runs their distinct workflow semantics", () => {
    const cases = [
      {
        name: "developer follow-up",
        start: taskStatusForRunStart("ready_for_review", "developer_followup"),
        success: taskStatusForRunSuccess("developer_followup"),
        failure: taskStatusForRunFailure("developer_followup", {
          hasDeveloperSession: true,
          workingTreeChanged: true,
        }),
        expected: ["fixing", "ready_for_review", "ready_for_review"],
      },
      {
        name: "reviewer follow-up",
        start: taskStatusForRunStart("ready_for_review", "reviewer_followup"),
        success: taskStatusPolicyForRun("reviewer_followup"),
        failure: taskStatusPolicyForRun("reviewer_followup"),
        expected: ["ready_for_review", "preserve_current", "preserve_current"],
      },
    ] as const;

    for (const scenario of cases) {
      expect(
        [scenario.start, scenario.success, scenario.failure],
        scenario.name,
      ).toEqual([...scenario.expected]);
    }
  });

  test("reviewer follow-up terminal policy preserves a concurrent human Task transition", () => {
    const capturedStatusAtStart = "waiting_for_human" as const;
    let persistedStatus: TaskStatus = capturedStatusAtStart;
    persistedStatus = "completed";

    const policy = taskStatusPolicyForRun("reviewer_followup");
    if (policy === "transition") {
      persistedStatus = taskStatusForRunSuccess("reviewer_followup");
    }

    expect(policy).toBe("preserve_current");
    expect(persistedStatus).toBe("completed");
    expect(() => taskStatusForRunSuccess("reviewer_followup")).toThrow("preserve current Task status");
    expect(() => taskStatusForRunFailure("reviewer_followup", {
      hasDeveloperSession: true,
      workingTreeChanged: true,
    })).toThrow("preserve current Task status");
  });
});
