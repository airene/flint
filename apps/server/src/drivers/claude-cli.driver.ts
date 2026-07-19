import type { AgentAvailability, AgentDriver, AgentEvent, AgentStartRequest, AgentStartResult } from "@local-pair-review/shared";
import { buildClaudeArgs } from "./cli-arguments";
import { checkClaudeAvailability } from "./cli-availability";
import { parseClaudeEventLine } from "./claude-event.parser";
import { StreamingCliDriver } from "./streaming-cli.driver";
import type { StreamingDriverOptions } from "./streaming-cli.driver";
import type { AgentControlStartRequest } from "./agent-control";

export class ClaudeCliDriver extends StreamingCliDriver implements AgentDriver {
  readonly provider = "claude" as const;
  readonly capabilities = {
    developerInitialImage: false,
    developerResumeImage: false,
    reviewerInitialImage: false,
    reviewerResumeImage: false,
    liveMessages: false,
    interrupt: true,
    approvals: false,
  } as const;

  constructor(options: StreamingDriverOptions) {
    super(options);
  }

  checkAvailability(): Promise<AgentAvailability> {
    return checkClaudeAvailability(this.executablePath, this.environment, this.availabilityWorkingDirectory);
  }

  start(request: AgentControlStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult> {
    return this.run(request, emit);
  }

  protected arguments(request: AgentControlStartRequest): string[] {
    return buildClaudeArgs(this.executablePath, request.runType, request.sessionId);
  }

  protected parse(line: string, request: AgentStartRequest) {
    return parseClaudeEventLine(line, request);
  }

  protected providerSource(): "claude" {
    return "claude";
  }
}
