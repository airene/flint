import type { AgentAvailability, AgentDriver, AgentEvent, AgentStartRequest, AgentStartResult } from "@local-pair-review/shared";
import { buildClaudeArgs } from "./cli-arguments";
import { checkClaudeAvailability } from "./cli-availability";
import { parseClaudeEventLine } from "./claude-event.parser";
import { StreamingCliDriver } from "./streaming-cli.driver";
import type { StreamingDriverOptions } from "./streaming-cli.driver";

export class ClaudeCliDriver extends StreamingCliDriver implements AgentDriver {
  readonly provider = "claude" as const;

  constructor(options: StreamingDriverOptions) {
    super(options);
  }

  checkAvailability(): Promise<AgentAvailability> {
    return checkClaudeAvailability(this.executablePath, this.environment, this.availabilityWorkingDirectory);
  }

  start(request: AgentStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult> {
    return this.run(request, emit);
  }

  protected arguments(request: AgentStartRequest): string[] {
    return buildClaudeArgs(this.executablePath, request.runType, request.sessionId);
  }

  protected parse(line: string, request: AgentStartRequest) {
    return parseClaudeEventLine(line, request);
  }

  protected providerSource(): "claude" {
    return "claude";
  }
}
