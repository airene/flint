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
  if (process.platform === "win32") {
    const args = ["taskkill", "/PID", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const taskkill = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const completed = await Promise.race([
      taskkill.exited.then(() => true, () => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (!completed) taskkill.kill();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function processTreeExists(pid: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function processTreeExitedWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await processTreeExists(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  return true;
}

export async function processExitedWithin(process: ManagedProcess, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    process.exited.then(() => true, () => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

export async function stopProcessTree(managedProcess: ManagedProcess, graceMs = 100): Promise<void> {
  await stopProcessTreeByPid(managedProcess.pid, graceMs);
  if (process.platform === "win32") await processExitedWithin(managedProcess, graceMs);
}

export async function stopProcessTreeByPid(pid: number, graceMs = 100): Promise<void> {
  if (process.platform !== "win32" && !await processTreeExists(pid)) return;
  await terminateProcessTree(pid, "SIGTERM").catch(() => undefined);
  if (process.platform !== "win32" && await processTreeExitedWithin(pid, graceMs)) return;
  if (process.platform === "win32") await Bun.sleep(graceMs);
  await terminateProcessTree(pid, "SIGKILL").catch(() => undefined);
  if (process.platform !== "win32") await processTreeExitedWithin(pid, graceMs);
}

export class ProcessSupervisor {
  private readonly active = new Map<string, ManagedProcess>();
  private readonly cancellationRequested = new Set<string>();

  constructor(private readonly graceMs = 1_000) {}

  track(runId: string, process: ManagedProcess): void {
    this.active.set(runId, process);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
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
