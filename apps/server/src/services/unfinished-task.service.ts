import type { UnfinishedTaskSummary } from "@local-pair-review/shared";

/** Narrow read port implemented by the persistence layer's single summary query. */
export interface UnfinishedTaskPersistencePort {
  listUnfinishedTasks(): Promise<UnfinishedTaskSummary[]>;
}

const attentionPriority: Record<UnfinishedTaskSummary["attention"], number> = {
  pending_approval: 0,
  needs_attention: 1,
  running: 2,
  waiting_for_human: 3,
  ready_for_review: 4,
  pending_start: 5,
  other: 6,
};

/**
 * Keeps the task-attention read model separate from the database implementation.
 * The persistence port supplies all Run and approval facts in one summary query;
 * this service only establishes the API's deterministic ordering.
 */
export class UnfinishedTaskService {
  constructor(private readonly persistence: UnfinishedTaskPersistencePort) {}

  async list(): Promise<UnfinishedTaskSummary[]> {
    return sortUnfinishedTasks((await this.persistence.listUnfinishedTasks())
      .filter((task) => task.status !== "completed"));
  }
}

export function sortUnfinishedTasks(tasks: readonly UnfinishedTaskSummary[]): UnfinishedTaskSummary[] {
  return [...tasks].sort((left, right) => (
    attentionPriority[left.attention] - attentionPriority[right.attention]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id)
  ));
}
