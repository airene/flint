import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { UnfinishedTaskSummary } from "@local-pair-review/shared";
import { applyUnfinishedTaskSocketMessage, replaceUnfinishedTaskSnapshot } from "../../apps/web/src/realtime/unfinished-task-events";
import { unfinishedTaskStatusLabel, useUnfinishedTasksStore } from "../../apps/web/src/stores/unfinished-tasks";

const { createPinia, setActivePinia } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pinia") as {
  createPinia(): Parameters<typeof useUnfinishedTasksStore>[0];
  setActivePinia(pinia: Parameters<typeof useUnfinishedTasksStore>[0]): void;
};

function summary(
  id: string,
  attention: UnfinishedTaskSummary["attention"] = "other",
  updatedAt = "2026-07-19T00:00:00.000Z",
): UnfinishedTaskSummary {
  return {
    id,
    projectId: "project-1",
    projectName: "Flint",
    title: `Task ${id}`,
    status: attention === "ready_for_review" ? "ready_for_review" : "draft",
    latestRunStatus: null,
    pendingApprovalCount: attention === "pending_approval" ? 1 : 0,
    attention,
    updatedAt,
  };
}

afterEach(() => setActivePinia(createPinia()));

describe("unfinished task store and realtime reducer", () => {
  test("replaces initial and reconnect snapshots, preserving attention sort and current task", async () => {
    const store = useUnfinishedTasksStore(createPinia());
    store.setCurrentTask("running");
    store.replaceSnapshot([
      summary("draft", "pending_start"),
      summary("running", "running"),
      summary("approval", "pending_approval"),
    ]);

    expect(store.tasks.map((task) => task.id)).toEqual(["approval", "running", "draft"]);
    expect(store.isCurrentTask("running")).toBeTrue();

    await replaceUnfinishedTaskSnapshot(store, async () => [summary("review", "ready_for_review")]);
    expect(store.tasks.map((task) => task.id)).toEqual(["review"]);
    expect(store.currentTaskId).toBe("running");
  });

  test("upserts and removes summary-only realtime messages", () => {
    const store = useUnfinishedTasksStore(createPinia());
    store.replaceSnapshot([summary("draft", "pending_start")]);

    expect(applyUnfinishedTaskSocketMessage(store, {
      type: "unfinished_task_upsert",
      task: summary("approval", "pending_approval"),
    })).toBeTrue();
    expect(store.tasks.map((task) => task.id)).toEqual(["approval", "draft"]);

    expect(applyUnfinishedTaskSocketMessage(store, { type: "unfinished_task_remove", taskId: "approval" })).toBeTrue();
    expect(store.tasks.map((task) => task.id)).toEqual(["draft"]);
    expect(applyUnfinishedTaskSocketMessage(store, {
      type: "unfinished_task_upsert",
      task: { ...summary("unsafe"), originalPrompt: "must never enter this store" },
    })).toBeFalse();
    expect(store.tasks.map((task) => task.id)).toEqual(["draft"]);
  });

  test("uses accessible attention labels", () => {
    expect(unfinishedTaskStatusLabel(summary("approval", "pending_approval"))).toBe("Pending approval");
    expect(unfinishedTaskStatusLabel(summary("needs-help", "needs_attention"))).toBe("Needs attention");
    expect(unfinishedTaskStatusLabel(summary("review", "ready_for_review"))).toBe("Ready for review");
  });
});
