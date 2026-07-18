export type ProcessFailureKind = "failed" | "cancelled" | "protocol";

export class AgentProcessError extends Error {
  constructor(
    readonly kind: ProcessFailureKind,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "AgentProcessError";
  }
}

export interface ManagedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export async function terminateProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

export class ProcessSupervisor {
  private readonly active = new Map<string, ManagedProcess>();
  private readonly cancellationRequested = new Set<string>();

  constructor(private readonly graceMs = 1_000) {}

  track(runId: string, process: ManagedProcess): void {
    this.active.set(runId, process);
  }

  async cancel(runId: string): Promise<void> {
    const child = this.active.get(runId);
    if (!child) return;
    this.cancellationRequested.add(runId);
    await terminateProcessTree(child.pid, "SIGTERM");
    await Bun.sleep(this.graceMs);
    if (this.active.has(runId)) await terminateProcessTree(child.pid, "SIGKILL");
  }

  release(runId: string): boolean {
    this.active.delete(runId);
    return this.cancellationRequested.delete(runId);
  }
}
