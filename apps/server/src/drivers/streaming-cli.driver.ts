import type { AgentEvent, AgentStartRequest, AgentStartResult } from "@local-pair-review/shared";
import { createCliEnvironment } from "../utils/process-environment";
import { createAgentEvent } from "../utils/agent-event";
import { AgentProcessError, ProcessSupervisor } from "../utils/process-supervisor";
import type { ParsedAgentLine } from "./parser-types";
import {
  UnsupportedProviderCapabilityError,
  imageCapability,
  validateAgentControlStart,
  type AgentControl,
  type AgentControlStartRequest,
  type InterruptAcknowledgement,
  type ProviderCapability,
} from "./agent-control";
import type { ApprovalDecision, Provider, ProviderCapabilities } from "@local-pair-review/shared";

export interface StreamingDriverOptions {
  executablePath: string;
  environment?: Readonly<Record<string, string | undefined>>;
  availabilityWorkingDirectory?: string;
  cancellationGraceMs?: number;
}

interface StreamState {
  sessionId: string | null;
  finalMessage: string | null;
  structuredOutput: unknown | null;
  completed: boolean;
  failed: boolean;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) await onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  buffered += decoder.decode();
  if (buffered) await onLine(buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered);
}

export abstract class StreamingCliDriver implements AgentControl {
  abstract readonly provider: Provider;
  abstract readonly capabilities: ProviderCapabilities;

  protected executablePath: string;
  protected readonly environment: Readonly<Record<string, string | undefined>>;
  protected readonly availabilityWorkingDirectory: string;
  private readonly supervisor: ProcessSupervisor;

  constructor(options: StreamingDriverOptions) {
    this.executablePath = options.executablePath;
    this.environment = options.environment ?? process.env;
    this.availabilityWorkingDirectory = options.availabilityWorkingDirectory ?? process.cwd();
    this.supervisor = new ProcessSupervisor(options.cancellationGraceMs);
  }

  setExecutablePath(executablePath: string): void {
    this.executablePath = executablePath;
  }

  protected abstract arguments(request: AgentControlStartRequest): string[];
  protected abstract parse(line: string, request: AgentStartRequest): ParsedAgentLine;

  async run(
    request: AgentControlStartRequest,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<AgentStartResult> {
    if (request.signal?.aborted) {
      throw new AgentProcessError("cancelled", "Agent run was cancelled before process start.");
    }
    validateAgentControlStart(this.provider, this.capabilities, request);
    const args = this.arguments(request);
    let process: Bun.PipedSubprocess;
    try {
      process = Bun.spawn(args, {
        cwd: request.workingDirectory,
        detached: true,
        env: createCliEnvironment(this.environment),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }) as Bun.PipedSubprocess;
    } catch (error) {
      throw new AgentProcessError("failed", error instanceof Error ? error.message : String(error));
    }

    this.supervisor.track(request.runId, process);
    const exited = process.exited;
    const state: StreamState = {
      sessionId: request.sessionId ?? null,
      finalMessage: null,
      structuredOutput: null,
      completed: false,
      failed: false,
    };

    const abort = () => { void this.cancel(request.runId); };
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (request.signal?.aborted) {
        throw new AgentProcessError("cancelled", "Agent run was cancelled before process setup.");
      }
      await emit(createAgentEvent(request, this.providerSource(), "run_started", { processId: process.pid }));
      process.stdin.write(request.prompt);
      process.stdin.end();

      const stdout = readLines(process.stdout, async (line) => {
        const parsed = this.parse(line, request);
        if (parsed.sessionId) state.sessionId = parsed.sessionId;
        if (parsed.finalMessage) state.finalMessage = parsed.finalMessage;
        if (parsed.structuredOutput !== undefined) state.structuredOutput = parsed.structuredOutput;
        if (parsed.completed) state.completed = true;
        if (parsed.failed) state.failed = true;
        if (parsed.event) await emit(parsed.event);
      });
      // CLI stderr is routine logging (codex writes INFO/ERROR noise there even on success);
      // keep it out of the event stream and surface it only when the run actually fails.
      const stderrLines: string[] = [];
      const stderr = readLines(process.stderr, async (line) => {
        stderrLines.push(line);
      });

      const [exitCode] = await Promise.all([exited, stdout, stderr]);

      const cancelled = this.supervisor.release(request.runId);
      if (cancelled) throw new AgentProcessError("cancelled", "Agent run was cancelled.", exitCode);
      if (exitCode !== 0 || state.failed) {
        throw new AgentProcessError(
          "failed",
          stderrLines.join("\n") || `Agent process failed with exit code ${exitCode}.`,
          exitCode,
        );
      }
      if (!state.completed) {
        throw new AgentProcessError("protocol", "Agent stream ended without a completion event.", exitCode);
      }
      return {
        sessionId: state.sessionId,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
      };
    } catch (error) {
      if (this.supervisor.isActive(request.runId)) {
        await this.supervisor.cancel(request.runId);
        await exited;
      }
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abort);
      this.supervisor.release(request.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.supervisor.cancel(runId);
  }

  imageCapability(request: AgentStartRequest): ProviderCapability {
    return imageCapability(request);
  }

  async interrupt(runId: string): Promise<InterruptAcknowledgement> {
    if (!this.capabilities.interrupt) {
      throw new UnsupportedProviderCapabilityError(this.provider, "interrupt");
    }
    const wasRunning = this.supervisor.isActive(runId);
    await this.cancel(runId);
    return { runId, status: wasRunning ? "terminated" : "not_running" };
  }

  async sendLiveMessage(_runId: string, _message: string): Promise<void> {
    throw new UnsupportedProviderCapabilityError(this.provider, "liveMessages");
  }

  // Dormant: the prompt is written to stdin once and closed in run(), so there is no channel
  // to relay an approval decision back to a running CLI. See the TODO in approval.service.ts.
  async resolveApproval(_runId: string, _approvalId: string, _decision: ApprovalDecision): Promise<void> {
    throw new UnsupportedProviderCapabilityError(this.provider, "approvals");
  }

  protected abstract providerSource(): "codex" | "claude";
}
