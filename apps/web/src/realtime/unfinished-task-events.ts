import { unfinishedTaskSummarySchema, type UnfinishedTaskSummary } from "@local-pair-review/shared";

export type UnfinishedTaskEvent =
  | { type: "unfinished_task_upsert"; task: UnfinishedTaskSummary }
  | { type: "unfinished_task_remove"; taskId: string };

export interface UnfinishedTaskEventTarget {
  upsert(task: UnfinishedTaskSummary): void;
  remove(taskId: string): void;
  replaceSnapshot(tasks: readonly UnfinishedTaskSummary[]): void;
}

export function applyUnfinishedTaskEvent(target: UnfinishedTaskEventTarget, event: UnfinishedTaskEvent): void {
  if (event.type === "unfinished_task_upsert") target.upsert(event.task);
  else target.remove(event.taskId);
}

/** Safely ignores unrelated common-socket events and strips every non-summary field. */
export function applyUnfinishedTaskSocketMessage(target: UnfinishedTaskEventTarget, message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const event = message as { type?: unknown; task?: unknown; taskId?: unknown };
  if (event.type === "unfinished_task_upsert") {
    const parsed = unfinishedTaskSummarySchema.safeParse(event.task);
    if (!parsed.success) return false;
    target.upsert(parsed.data);
    return true;
  }
  if (event.type === "unfinished_task_remove" && typeof event.taskId === "string") {
    target.remove(event.taskId);
    return true;
  }
  return false;
}

export async function replaceUnfinishedTaskSnapshot(
  target: UnfinishedTaskEventTarget,
  load: () => Promise<readonly UnfinishedTaskSummary[]>,
): Promise<void> {
  target.replaceSnapshot(await load());
}
