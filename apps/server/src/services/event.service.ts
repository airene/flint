import type { AgentEvent } from "@local-pair-review/shared";
import { redactSensitive } from "../utils/redact";

export interface PersistAgentEventInput {
  event: AgentEvent;
  rawJson: string;
}

export interface EventPersistencePort {
  append(input: PersistAgentEventInput): Promise<AgentEvent>;
}

export interface EventBroadcastPort {
  broadcast(event: AgentEvent): void | Promise<void>;
}

function rawFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "raw" in payload && typeof payload.raw === "string") {
    return payload.raw;
  }
  return JSON.stringify(payload);
}

export class EventService {
  constructor(
    private readonly persistence: EventPersistencePort,
    private readonly broadcaster: EventBroadcastPort,
  ) {}

  async publish(event: AgentEvent): Promise<AgentEvent> {
    const sanitized = redactSensitive(event);
    const persisted = await this.persistence.append({
      event: sanitized,
      rawJson: redactSensitive(rawFromPayload(event.payload)),
    });
    try {
      void Promise.resolve(this.broadcaster.broadcast(persisted)).catch(() => {
        // Persistence is authoritative; clients recover through sequence replay.
      });
    } catch {
      // A synchronous client failure must not pause the CLI stream.
    }
    return persisted;
  }
}
