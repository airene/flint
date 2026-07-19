import { describe, expect, test } from "bun:test";
import type { UnfinishedTaskSummary } from "@local-pair-review/shared";
import { createUnfinishedTasksRoute } from "../../apps/server/src/api/unfinished-tasks";
import { UnfinishedTaskService } from "../../apps/server/src/services/unfinished-task.service";

function summary(
  id: string,
  attention: UnfinishedTaskSummary["attention"],
  updatedAt: string,
  overrides: Partial<UnfinishedTaskSummary> = {},
): UnfinishedTaskSummary {
  return {
    id,
    projectId: `project-${id}`,
    projectName: `Repository ${id}`,
    title: `Task ${id}`,
    status: "draft",
    latestRunStatus: null,
    pendingApprovalCount: 0,
    attention,
    updatedAt,
    ...overrides,
  };
}

describe("UnfinishedTaskService", () => {
  test("returns every non-completed task across projects in stable attention order", async () => {
    const tasks = [
      summary("draft", "pending_start", "2026-07-19T01:00:00.000Z"),
      summary("review", "ready_for_review", "2026-07-19T02:00:00.000Z", { status: "ready_for_review" }),
      summary("waiting", "waiting_for_human", "2026-07-19T03:00:00.000Z", { status: "waiting_for_human" }),
      summary("active", "running", "2026-07-19T04:00:00.000Z", { status: "developing", latestRunStatus: "running" }),
      summary("failed", "needs_attention", "2026-07-19T05:00:00.000Z", { latestRunStatus: "failed" }),
      summary("cancelled", "needs_attention", "2026-07-19T05:30:00.000Z", { latestRunStatus: "cancelled" }),
      summary("interrupted", "needs_attention", "2026-07-19T04:30:00.000Z", { latestRunStatus: "interrupted" }),
      summary("approval", "pending_approval", "2026-07-19T06:00:00.000Z", { pendingApprovalCount: 1 }),
      summary("completed", "pending_approval", "2026-07-19T07:00:00.000Z", { status: "completed" }),
    ];
    let reads = 0;
    const service = new UnfinishedTaskService({ listUnfinishedTasks: async () => { reads += 1; return tasks; } });

    const result = await service.list();

    expect(result.map((task) => task.id)).toEqual([
      "approval", "cancelled", "failed", "interrupted", "active", "waiting", "review", "draft",
    ]);
    expect(result.map((task) => task.projectId)).toContain("project-approval");
    expect(result.some((task) => task.status === "completed")).toBeFalse();
    expect(reads).toBe(1);
  });

  test("orders equal attention by updatedAt and then id", async () => {
    const service = new UnfinishedTaskService({
      listUnfinishedTasks: async () => [
        summary("z", "other", "2026-07-19T00:00:00.000Z"),
        summary("a", "other", "2026-07-19T00:00:00.000Z"),
        summary("new", "other", "2026-07-19T01:00:00.000Z"),
      ],
    });

    expect((await service.list()).map((task) => task.id)).toEqual(["new", "a", "z"]);
  });

  test("exposes a mountable GET snapshot route", async () => {
    const task = summary("task-1", "pending_approval", "2026-07-19T00:00:00.000Z", { pendingApprovalCount: 2 });
    const route = createUnfinishedTasksRoute(new UnfinishedTaskService({ listUnfinishedTasks: async () => [task] }));

    const response = await route(new Request("http://localhost/api/tasks/unfinished"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual([task]);
    expect(await route(new Request("http://localhost/api/tasks/not-a-summary"))).toBeNull();
    expect((await route(new Request("http://localhost/api/tasks/unfinished", { method: "POST" })))?.status).toBe(405);
  });
});
