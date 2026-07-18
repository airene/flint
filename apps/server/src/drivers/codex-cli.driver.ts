import type { AgentAvailability, AgentDriver, AgentEvent, AgentStartRequest, AgentStartResult } from "@local-pair-review/shared";
import { buildCodexArgs } from "./cli-arguments";
import { checkCodexAvailability } from "./cli-availability";
import { parseCodexEventLine } from "./codex-event.parser";
import { StreamingCliDriver } from "./streaming-cli.driver";
import type { StreamingDriverOptions } from "./streaming-cli.driver";

export class CodexCliDriver extends StreamingCliDriver implements AgentDriver {
  readonly provider = "codex" as const;

  private readonly reviewSchemaPath?: string;

  constructor(options: StreamingDriverOptions & { reviewSchemaPath?: string }) {
    super(options);
    this.reviewSchemaPath = options.reviewSchemaPath;
  }

  checkAvailability(): Promise<AgentAvailability> {
    return checkCodexAvailability(this.executablePath, this.environment, this.availabilityWorkingDirectory);
  }

  start(request: AgentStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult> {
    return this.run(request, emit);
  }

  protected arguments(request: AgentStartRequest): string[] {
    return buildCodexArgs(this.executablePath, request.runType, request.sessionId, this.reviewSchemaPath);
  }

  protected parse(line: string, request: AgentStartRequest) {
    const parsed = parseCodexEventLine(line, request);
    if (request.runType !== "reviewer" || !parsed.finalMessage) return parsed;
    try {
      return { ...parsed, structuredOutput: JSON.parse(parsed.finalMessage) };
    } catch {
      return parsed;
    }
  }

  protected providerSource(): "codex" {
    return "codex";
  }
}
