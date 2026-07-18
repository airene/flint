import type { AgentAvailability, AgentDriver, AgentEvent, AgentStartRequest, AgentStartResult } from "@local-pair-review/shared";
import { buildCodexArgs } from "./cli-arguments";
import { checkCodexAvailability } from "./cli-availability";
import { parseCodexEventLine } from "./codex-event.parser";
import { StreamingCliDriver } from "./streaming-cli.driver";
import type { StreamingDriverOptions } from "./streaming-cli.driver";

export class CodexCliDriver extends StreamingCliDriver implements AgentDriver {
  readonly provider = "codex" as const;

  constructor(options: StreamingDriverOptions) {
    super(options);
  }

  checkAvailability(): Promise<AgentAvailability> {
    return checkCodexAvailability(this.executablePath, this.environment);
  }

  start(request: AgentStartRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentStartResult> {
    return this.run(request, emit);
  }

  protected arguments(sessionId?: string): string[] {
    return buildCodexArgs(this.executablePath, sessionId);
  }

  protected parse(line: string, request: AgentStartRequest) {
    return parseCodexEventLine(line, request);
  }

  protected providerSource(): "codex" {
    return "codex";
  }
}
