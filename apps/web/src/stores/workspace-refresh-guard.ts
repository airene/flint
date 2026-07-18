import type { AgentRun, AgentRunStatus } from "@local-pair-review/shared";

export interface WorkspaceRefreshToken {
  sequence: number;
  mutationRevision: number;
}

export type WorkspaceRefreshDisposition = "apply" | "superseded" | "retry";

export class WorkspaceRefreshGuard {
  private sequence = 0;
  private mutationRevision = 0;

  begin(): WorkspaceRefreshToken {
    return { sequence: ++this.sequence, mutationRevision: this.mutationRevision };
  }

  mutate(): void {
    this.mutationRevision += 1;
  }

  disposition(token: WorkspaceRefreshToken): WorkspaceRefreshDisposition {
    if (token.sequence !== this.sequence) return "superseded";
    if (token.mutationRevision !== this.mutationRevision) return "retry";
    return "apply";
  }

  shouldApply(token: WorkspaceRefreshToken, retry: () => void): boolean {
    const disposition = this.disposition(token);
    if (disposition === "retry") retry();
    return disposition === "apply";
  }
}

const statusRank: Record<AgentRunStatus, number> = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
  interrupted: 2,
};

export function shouldApplyRunUpdate(current: AgentRun | undefined, incoming: AgentRun): boolean {
  return !current || statusRank[incoming.status] >= statusRank[current.status];
}
