import type { UnfinishedTaskSummary } from "@local-pair-review/shared";
import { defineStore } from "pinia";

const attentionPriority: Record<UnfinishedTaskSummary["attention"], number> = {
  pending_approval: 0,
  needs_attention: 1,
  running: 2,
  waiting_for_human: 3,
  ready_for_review: 4,
  pending_start: 5,
  other: 6,
};

export function sortUnfinishedTaskSummaries(tasks: readonly UnfinishedTaskSummary[]): UnfinishedTaskSummary[] {
  return [...tasks].sort((left, right) => (
    attentionPriority[left.attention] - attentionPriority[right.attention]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id)
  ));
}

export function unfinishedTaskStatusLabel(task: UnfinishedTaskSummary): string {
  switch (task.attention) {
    case "pending_approval": return "Pending approval";
    case "needs_attention": return "Needs attention";
    case "running": return "Running";
    case "waiting_for_human": return "Waiting for you";
    case "ready_for_review": return "Ready for review";
    case "pending_start": return "Ready to start";
    case "other": return task.status.replaceAll("_", " ");
  }
}

export function unfinishedTaskStatusKey(task: UnfinishedTaskSummary): string | null {
  switch (task.attention) {
    case "pending_approval": return "statuses.pendingApproval";
    case "needs_attention": return "statuses.needsAttention";
    case "running": return "statuses.running";
    case "waiting_for_human": return "statuses.waitingForYou";
    case "ready_for_review": return "statuses.ready_for_review";
    case "pending_start": return "statuses.readyToStart";
    case "other": return task.status in { draft: 1, developing: 1, fixing: 1, reviewing: 1, waiting_for_human: 1, ready_for_review: 1, completed: 1 }
      ? `statuses.${task.status}` : null;
  }
}

export const useUnfinishedTasksStore = defineStore("unfinishedTasks", {
  state: () => ({
    tasks: [] as UnfinishedTaskSummary[],
    currentTaskId: null as string | null,
    loading: false,
  }),
  getters: {
    isCurrentTask: (state) => (taskId: string): boolean => state.currentTaskId === taskId,
  },
  actions: {
    replaceSnapshot(tasks: readonly UnfinishedTaskSummary[]): void {
      this.tasks = sortUnfinishedTaskSummaries(tasks);
    },
    upsert(task: UnfinishedTaskSummary): void {
      const index = this.tasks.findIndex((candidate) => candidate.id === task.id);
      const next = [...this.tasks];
      if (index === -1) next.push(task);
      else next.splice(index, 1, task);
      this.tasks = sortUnfinishedTaskSummaries(next);
    },
    remove(taskId: string): void {
      this.tasks = this.tasks.filter((task) => task.id !== taskId);
    },
    setCurrentTask(taskId: string | null): void {
      this.currentTaskId = taskId;
    },
    async loadSnapshot(load: () => Promise<readonly UnfinishedTaskSummary[]>): Promise<UnfinishedTaskSummary[]> {
      this.loading = true;
      try {
        const tasks = await load();
        this.replaceSnapshot(tasks);
        return this.tasks;
      } finally {
        this.loading = false;
      }
    },
  },
});
